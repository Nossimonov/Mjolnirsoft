import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Respond } from './worker-runtime.ts';

/** Options shaping a one-shot `claude` run beyond the task prompt and cwd. */
export interface ClaudeRunArgs {
  /** Worker-role instructions appended to Claude's system prompt. */
  readonly appendSystemPrompt?: string;
  /** The Claude session UUID to pin, so a worker's turns continue one conversation. */
  readonly sessionId?: string;
  /** When a session is pinned, resume it (later turns) instead of creating it (first turn). */
  readonly resume?: boolean;
}

/** Runs a one-shot headless Claude Code task in `cwd`, returning its result text. */
export type RunClaudeCode = (prompt: string, options: { cwd: string } & ClaudeRunArgs) => Promise<string>;

/** Build the `claude` argv for a one-shot run from the task prompt and run options. */
export function buildClaudeArgs(prompt: string, options: ClaudeRunArgs = {}): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.sessionId) args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
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
export const runClaudeCodeCli: RunClaudeCode = (prompt, { cwd, appendSystemPrompt, sessionId, resume }) =>
  new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBin(), buildClaudeArgs(prompt, { appendSystemPrompt, sessionId, resume }), {
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
export const DEFAULT_WORKER_ROLE = `You are a Mjolnirsoft worker. A planner/orchestrator owns the overall design and delegates you a single task to implement; the human architect stays involved at every step. Your job is the nitty-gritty implementation.

- Collaborate continuously with the user. This is an interactive, multi-turn conversation — not fire-and-forget. Surface decisions, trade-offs, and open questions as you go, and fold in the architect's guidance. They need visibility while you work, not only at the end.
- Read widely, write narrowly. Read anything in or beyond the repo you need to understand the task and integrate cleanly with surrounding code. But only create, modify, or run things within your own worktree and branch — never write to, execute against, or alter other branches, refs, git history, or other workers' workspaces.
- Don't commit; hand off. Leave your work in your branch's working tree. The orchestrator and architect review it against the broader design and decide whether to accept and commit it. Make your final hand-off summarize what you changed and why, clearly enough for the orchestrator to compose the commit message and judge whether the result fits the design.
- Justify every change for the record. Your output is a permanent record that future sessions will read to understand why the code is the way it is. For each meaningful change, include a brief rationale, so that reasoning is recoverable later without you present.
- Stay in scope. Implement the task you were given; surface related issues to the planner rather than expanding into them yourself.`;

export interface ClaudeCodeResponderOptions {
  readonly workdir: string;
  /**
   * Worker-role instructions appended to Claude's system prompt
   * (default: {@link DEFAULT_WORKER_ROLE}; pass `''` to append nothing).
   */
  readonly appendSystemPrompt?: string;
  /**
   * The worker's Claude session UUID (default: a fresh UUID). Pinned so the
   * worker's turns continue one conversation, and known up front so the
   * keystone (#40) can record it.
   */
  readonly claudeSessionId?: string;
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). */
  readonly run?: RunClaudeCode;
}

/**
 * A worker {@link Respond} backed by Claude Code: each task runs a headless
 * `claude` agent in a per-worker workspace, with worker-role instructions
 * appended to its system prompt, and its result text is returned as the reply.
 * Turns share one pinned Claude session — created on the first turn
 * (`--session-id`) and resumed on later ones (`--resume`) — so the worker
 * retains context across an interactive exchange. The agent's own tools and
 * agent loop do the work — runs on the user's Claude Code subscription, no API
 * key required.
 */
export function createClaudeCodeResponder(options: ClaudeCodeResponderOptions): Respond {
  const {
    workdir,
    appendSystemPrompt = DEFAULT_WORKER_ROLE,
    claudeSessionId = randomUUID(),
    run = runClaudeCodeCli,
  } = options;
  let started = false; // first turn creates the session; later turns resume it
  return async (message) => {
    const prompt = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    const result = (
      await run(prompt, { cwd: workdir, appendSystemPrompt, sessionId: claudeSessionId, resume: started })
    ).trim();
    started = true;
    return result ? { type: 'result', payload: result } : undefined;
  };
}
