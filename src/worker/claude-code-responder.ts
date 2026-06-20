import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { INTERACTION_DECISION, INTERACTION_REQUEST } from '../core/interaction.ts';
import type { Respond } from './worker-runtime.ts';

/** Options shaping a one-shot `claude` run beyond the task prompt and cwd. */
export interface ClaudeRunArgs {
  /** Worker-role instructions appended to Claude's system prompt. */
  readonly appendSystemPrompt?: string;
  /** The Claude session UUID to pin, so a worker's turns continue one conversation. */
  readonly sessionId?: string;
  /** When a session is pinned, resume it (later turns) instead of creating it (first turn). */
  readonly resume?: boolean;
  /** MCP tool that handles permission prompts (e.g. `mcp__perm__approve`), surfacing them to the human (#66). */
  readonly permissionPromptTool?: string;
  /** Path to the MCP config defining the server that backs {@link permissionPromptTool}. */
  readonly mcpConfigPath?: string;
  /** Allow rules learned from "Always" decisions, merged into the policy for this run (#70). */
  readonly learnedAllowRules?: readonly string[];
}

/** Runs a one-shot headless Claude Code task in `cwd`, returning its result text. */
export type RunClaudeCode = (prompt: string, options: { cwd: string } & ClaudeRunArgs) => Promise<string>;

/**
 * Permission policy for the worker's headless `claude`: no prompts for what a
 * normal dev task needs (reads, cwd-scoped edits, shell commands), with a few
 * clearly-dangerous commands denied. This is *soft* confinement — on native
 * Windows there's no OS sandbox, so the worktree cwd, the worker-role
 * instructions, and the developer's branch review are the real boundary (Bash
 * can still escape this policy). A WSL sandbox would be the hard boundary. See #62.
 */
export const WORKER_PERMISSION_POLICY = {
  permissions: {
    allow: ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit(./**)', 'Write(./**)', 'Bash'],
    deny: ['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(sudo *)'],
  },
};

/** The base policy serialized for `--settings` — the spawn default when nothing is learned. */
export const WORKER_PERMISSIONS = JSON.stringify(WORKER_PERMISSION_POLICY);

/**
 * Serialize the `--settings` policy, merging any learned "Always" allow rules
 * into the base allow-list (#70). Learned rules only widen `allow`; the `deny`
 * floor is untouched and still wins, so a learned rule can't unlock a denied
 * foot-gun. With no learned rules this returns the exact base {@link WORKER_PERMISSIONS}.
 */
export function buildWorkerSettings(learnedAllowRules: readonly string[] = []): string {
  if (learnedAllowRules.length === 0) return WORKER_PERMISSIONS;
  const allow = [...WORKER_PERMISSION_POLICY.permissions.allow];
  for (const rule of learnedAllowRules) if (!allow.includes(rule)) allow.push(rule);
  return JSON.stringify({ permissions: { allow, deny: WORKER_PERMISSION_POLICY.permissions.deny } });
}

/** Build the `claude` argv for a one-shot run from the task prompt and run options. */
export function buildClaudeArgs(prompt: string, options: ClaudeRunArgs = {}): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--settings', buildWorkerSettings(options.learnedAllowRules)];
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.sessionId) args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  if (options.permissionPromptTool) args.push('--permission-prompt-tool', options.permissionPromptTool);
  if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
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
export const runClaudeCodeCli: RunClaudeCode = (
  prompt,
  { cwd, appendSystemPrompt, sessionId, resume, permissionPromptTool, mcpConfigPath, learnedAllowRules },
) =>
  new Promise((resolve, reject) => {
    const args = buildClaudeArgs(prompt, {
      appendSystemPrompt,
      sessionId,
      resume,
      permissionPromptTool,
      mcpConfigPath,
      learnedAllowRules,
    });
    const child = spawn(resolveClaudeBin(), args, {
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
  /**
   * MCP tool that handles permission prompts (e.g. `mcp__perm__approve`) plus
   * the config path defining its server, so a tool use the worker isn't
   * pre-allowed to make is surfaced to the human instead of dead-ending (#66).
   * Both must be set together; omit for a worker with no escalation path.
   */
  readonly permissionPromptTool?: string;
  readonly mcpConfigPath?: string;
  /**
   * Supplies the allow rules learned from "Always" decisions (#70), read *per
   * turn* so a rule recorded mid-session takes effect on the next turn's spawn
   * (not only the next worker). Defaults to none.
   */
  readonly loadLearnedRules?: () => readonly string[];
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
    permissionPromptTool,
    mcpConfigPath,
    loadLearnedRules = () => [],
    run = runClaudeCodeCli,
  } = options;
  let started = false; // first turn creates the session; later turns resume it
  return async (message) => {
    // Permission requests/decisions are a side-channel between the MCP server and
    // the view — not task prompts. Ignoring them keeps the worker from feeding
    // its own mid-run permission request back into Claude as a new turn (#66).
    if (message.type === INTERACTION_REQUEST || message.type === INTERACTION_DECISION) return undefined;
    const prompt = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    const result = (
      await run(prompt, {
        cwd: workdir,
        appendSystemPrompt,
        sessionId: claudeSessionId,
        resume: started,
        permissionPromptTool,
        mcpConfigPath,
        learnedAllowRules: loadLearnedRules(),
      })
    ).trim();
    started = true;
    return result ? { type: 'result', payload: result } : undefined;
  };
}
