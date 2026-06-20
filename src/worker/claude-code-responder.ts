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

/**
 * The base policy serialized for `--settings`. The "Always"/learned-rule side of
 * the permission card (#70) is *not* applied here: a learned allow rule in
 * `--settings` doesn't reach out-of-cwd writes (Claude gates those at its access
 * layer before allow rules are consulted — verified live), so remembering is
 * consumed in the permission MCP server's `approve` instead (see
 * `learned-permissions.ts`). The `deny` floor stays here, enforced before
 * `approve` is ever called, so a denied foot-gun can't be auto-allowed.
 */
export const WORKER_PERMISSIONS = JSON.stringify(WORKER_PERMISSION_POLICY);

/** Build the `claude` argv for a one-shot run from the task prompt and run options. */
export function buildClaudeArgs(prompt: string, options: ClaudeRunArgs = {}): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--settings', WORKER_PERMISSIONS];
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
  { cwd, appendSystemPrompt, sessionId, resume, permissionPromptTool, mcpConfigPath },
) =>
  new Promise((resolve, reject) => {
    const args = buildClaudeArgs(prompt, {
      appendSystemPrompt,
      sessionId,
      resume,
      permissionPromptTool,
      mcpConfigPath,
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
 * The extension's shared model, carried by *every* tool-spawned agent (#71): the
 * agent chain, the factual/design/permission classification, the
 * escalate-when-unsure bias, and the descriptive-record rule. Identical for all
 * roles — it tells an agent the chain it is structurally inside and where the
 * human's authority sits. Exported so other roles (orchestrator, evaluator) can
 * reuse it verbatim with their own insert once they are tool-spawned agents.
 */
export const SHARED_CORE = `You operate in a chain of sessions coordinating one project. From the top: the architect (a human) holds final authority over design and permissions; an orchestrator plans, delegates, reviews its delegated work, and routes; executors implement delegated tasks in isolation; evaluators critique with fresh eyes and no stake in the plan. Work flows down; questions and decisions flow up.

Classify every check-in you would make, and act on it:
- Factual — answerable from already-decided design (the shared record, your brief, the code): answer it at the lowest session that knows.
- Design — a choice with consequences the record does not settle, that a later session or the human would treat as endorsed direction: route it up; never invent it.
- Permission — anything authorizing a consequential or boundary-crossing action: only the architect, or a rule the architect authored, grants it; no agent self-approves (the tool also enforces this).

When unsure which a thing is, treat it as the more-escalated kind. Escalation is cheap; an un-endorsed decision compounds down the chain. The shared design record holds only decided design — read it as ground truth; never write speculation into it.`;

/** The executor's one-line role insert: its position and standing rule in the chain (#71). */
export const EXECUTOR_INSERT = `You are an executor: you implement the single task delegated to you. Decide implementation freely, but route design and permission questions up to your orchestrator, and do not expand scope.`;

/** How an executor works within its worktree — operational guidance under the model and role insert. */
const EXECUTOR_OPERATIONS = `As you implement:
- Collaborate continuously — this is an interactive, multi-turn conversation, not fire-and-forget. Surface decisions, trade-offs, and progress as you go; the architect needs visibility while you work, not only at the end.
- Read widely, write narrowly. Read anything in or beyond the repo you need to integrate cleanly, but only create, modify, or run things within your own worktree and branch — never touch other branches, refs, git history, or other workers' workspaces.
- Don't commit; hand off. Leave your work in your branch's working tree with a final summary of what you changed and why — clear enough for the orchestrator to compose the commit and judge the result against the design.
- Justify every change for the record — a brief rationale per meaningful change, so future sessions recover the reasoning without you present.`;

/**
 * Default instructions appended to an executor's system prompt (not replacing
 * Claude Code's own): the shared model {@link SHARED_CORE} + the executor role
 * insert {@link EXECUTOR_INSERT} + the executor's {@link EXECUTOR_OPERATIONS}.
 * Composed from the reusable pieces so other roles can later carry the same core
 * with their own insert; layered atop the worktree's hard isolation and the
 * developer's branch review (#45, #71).
 */
export const DEFAULT_WORKER_ROLE = `${SHARED_CORE}\n\n${EXECUTOR_INSERT}\n\n${EXECUTOR_OPERATIONS}`;

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
      })
    ).trim();
    started = true;
    return result ? { type: 'result', payload: result } : undefined;
  };
}
