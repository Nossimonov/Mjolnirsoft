import { spawn } from 'node:child_process';
import type { Respond } from './worker-runtime.ts';

/** Runs a one-shot headless Claude Code task in `cwd`, returning its result text. */
export type RunClaudeCode = (
  prompt: string,
  options: { cwd: string; appendSystemPrompt?: string },
) => Promise<string>;

/** Build the `claude` argv for a one-shot run, appending worker-role instructions when given. */
export function buildClaudeArgs(prompt: string, appendSystemPrompt?: string): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  return args;
}

/**
 * The `claude` executable to spawn. Resolved at call time (not module load) so a
 * `.local.env`-supplied `CLAUDE_BIN` loaded during startup is honored. `CLAUDE_BIN`
 * is the escape hatch when `claude` isn't on the subprocess PATH (a common
 * Windows gap); it should be an absolute path to the binary. Falls back to the
 * bare command, relying on PATH resolution.
 */
export function resolveClaudeBin(): string {
  return process.env.CLAUDE_BIN ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
}

/**
 * Default launcher: spawn `claude -p` headless. A non-`--bare` run uses the
 * logged-in Claude Code session (the user's subscription), `--output-format
 * json` returns a `.result` field, and `--permission-mode acceptEdits` lets the
 * agent write files without prompting. The task is passed as an argv element
 * (no shell), so prompt contents are not interpreted by a shell.
 */
export const runClaudeCodeCli: RunClaudeCode = (prompt, { cwd, appendSystemPrompt }) =>
  new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBin(), buildClaudeArgs(prompt, appendSystemPrompt), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        resolve(parsed.result ?? '');
      } catch {
        reject(new Error(`could not parse claude output: ${stdout.slice(0, 300)}`));
      }
    });
  });

/**
 * Default worker-role instructions, appended to Claude Code's own system prompt
 * (not replacing it). Establishes the worker's role and warns it to stay within
 * its own workspace and branch — a soft guardrail layered atop the worktree's
 * hard working-tree isolation and the developer's review of the branch (#45).
 */
export const DEFAULT_WORKER_ROLE =
  'You are an automated Mjolnirsoft worker. Execute the single task you are given in your assigned workspace and report the result concisely. ' +
  'Stay within your own workspace and branch: do not modify git history, branches, or refs outside it, and do not interfere with other concurrent workers.';

export interface ClaudeCodeResponderOptions {
  readonly workdir: string;
  /**
   * Worker-role instructions appended to Claude's system prompt
   * (default: {@link DEFAULT_WORKER_ROLE}; pass `''` to append nothing).
   */
  readonly appendSystemPrompt?: string;
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). */
  readonly run?: RunClaudeCode;
}

/**
 * A worker {@link Respond} backed by Claude Code: each task runs a headless
 * `claude` agent in a per-worker workspace, with worker-role instructions
 * appended to its system prompt, and its result text is returned as the reply.
 * The agent's own tools and agent loop do the work — runs on the user's Claude
 * Code subscription, no API key required.
 */
export function createClaudeCodeResponder(options: ClaudeCodeResponderOptions): Respond {
  const { workdir, appendSystemPrompt = DEFAULT_WORKER_ROLE, run = runClaudeCodeCli } = options;
  return async (message) => {
    const prompt = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    const result = (await run(prompt, { cwd: workdir, appendSystemPrompt })).trim();
    return result ? { type: 'result', payload: result } : undefined;
  };
}
