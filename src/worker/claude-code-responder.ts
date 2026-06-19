import { spawn } from 'node:child_process';
import type { Respond } from './worker-runtime.ts';

/** Runs a one-shot headless Claude Code task in `cwd`, returning its result text. */
export type RunClaudeCode = (prompt: string, options: { cwd: string }) => Promise<string>;

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
export const runClaudeCodeCli: RunClaudeCode = (prompt, { cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      resolveClaudeBin(),
      ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

export interface ClaudeCodeResponderOptions {
  readonly workdir: string;
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). */
  readonly run?: RunClaudeCode;
}

/**
 * A worker {@link Respond} backed by Claude Code: each task runs a headless
 * `claude` agent in a per-worker workspace, and its result text is returned as
 * the reply. The agent's own tools and agent loop do the work — runs on the
 * user's Claude Code subscription, no API key required.
 */
export function createClaudeCodeResponder(options: ClaudeCodeResponderOptions): Respond {
  const { workdir, run = runClaudeCodeCli } = options;
  return async (message) => {
    const prompt = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    const result = (await run(prompt, { cwd: workdir })).trim();
    return result ? { type: 'result', payload: result } : undefined;
  };
}
