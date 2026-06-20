import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Message } from '../core/channel.ts';
import { INTERACTION_DECISION, INTERACTION_REQUEST } from '../core/interaction.ts';
import { composeAgentInstructions } from '../core/agent-instructions.ts';
import type { Respond } from './executor-runtime.ts';

/**
 * The labeled line that prefixes every message the executor turns into a prompt,
 * naming the sender's identity and role so the agent can tell the authoritative
 * human apart from a peer/subordinate agent (#86, #71). The `planner` role is the
 * architect/human and is marked authoritative; every other role reads as a
 * non-authoritative agent. This is the seam delegation (#85) needs: once an
 * executor shares its channel with delegates, a delegate's message can never be
 * mistaken for the architect's instruction. Renaming `planner`→`orchestrator` is
 * a separate concern and deliberately untouched here.
 */
export function senderAttribution(message: Pick<Message, 'from' | 'role'>): string {
  const descriptor =
    message.role === 'planner' ? 'architect — authoritative' : message.role === 'executor' ? 'agent' : 'unknown role';
  return `[Message from ${descriptor} (id: ${message.from})]`;
}

/** Options shaping a one-shot `claude` run beyond the task prompt and cwd. */
export interface ClaudeRunArgs {
  /** Executor-role instructions appended to Claude's system prompt. */
  readonly appendSystemPrompt?: string;
  /** The Claude session UUID to pin, so an executor's turns continue one conversation. */
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
 * Permission policy for the executor's headless `claude`: no prompts for what a
 * normal dev task needs (reads, cwd-scoped edits, shell commands), with a few
 * clearly-dangerous commands denied. This is *soft* confinement — on native
 * Windows there's no OS sandbox, so the worktree cwd, the executor-role
 * instructions, and the developer's branch review are the real boundary (Bash
 * can still escape this policy). A WSL sandbox would be the hard boundary. See #62.
 */
export const EXECUTOR_PERMISSION_POLICY = {
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
export const EXECUTOR_PERMISSIONS = JSON.stringify(EXECUTOR_PERMISSION_POLICY);

/** Build the `claude` argv for a one-shot run from the task prompt and run options. */
export function buildClaudeArgs(prompt: string, options: ClaudeRunArgs = {}): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--settings', EXECUTOR_PERMISSIONS];
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
 * Interpret a finished `claude -p --output-format json` run into its result text,
 * or throw an informative Error. `claude` writes a JSON object to stdout *even on
 * failure* — the human-readable error lands in `result` (an expired/absent login
 * surfaces `"Not logged in · Please run /login"`) with `is_error: true` and a
 * non-zero exit, while stderr is typically empty. So the failure detail must be
 * taken from the JSON `result` first (then stderr, then raw stdout): a stderr-only
 * path drops it and leaves the surfaced error turn blank and unclassifiable —
 * which is exactly what hid the auth signal from the re-login card (#90, #89).
 * Pure (no I/O), so the parsing is unit-tested without spawning `claude`.
 */
export function interpretClaudeResult(stdout: string, stderr: string, code: number | null): string {
  let parsed: { result?: string; is_error?: boolean } | undefined;
  try {
    parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
  } catch {
    parsed = undefined;
  }
  if (code !== 0 || parsed?.is_error) {
    const detail =
      (typeof parsed?.result === 'string' && parsed.result.trim()) ||
      stderr.trim() ||
      stdout.trim() ||
      `exited with code ${code}`;
    throw new Error(`claude failed (exit ${code}): ${detail}`);
  }
  if (!parsed) {
    throw new Error(`could not parse claude output: ${stdout.slice(0, 300)}`);
  }
  return parsed.result ?? '';
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
      try {
        resolve(interpretClaudeResult(stdout, stderr, code));
      } catch (error) {
        reject(error as Error);
      }
    });
  });

/**
 * Default instructions appended to an executor's system prompt (not replacing
 * Claude Code's own): the extension's shared model + the executor role insert +
 * its operational guidance, composed through the layering framework (#57). The
 * layered pieces live in `src/core/agent-instructions.ts`, so other roles can
 * later carry the same core with their own insert; layered atop the worktree's
 * hard isolation and the developer's branch review (#45, #71).
 */
export const DEFAULT_EXECUTOR_ROLE = composeAgentInstructions('executor');

export interface ClaudeCodeResponderOptions {
  readonly workdir: string;
  /**
   * Executor-role instructions appended to Claude's system prompt
   * (default: {@link DEFAULT_EXECUTOR_ROLE}; pass `''` to append nothing).
   */
  readonly appendSystemPrompt?: string;
  /**
   * The executor's Claude session UUID (default: a fresh UUID). Pinned so the
   * executor's turns continue one conversation, and known up front so the
   * keystone (#40) can record it.
   */
  readonly claudeSessionId?: string;
  /**
   * MCP tool that handles permission prompts (e.g. `mcp__perm__approve`) plus
   * the config path defining its server, so a tool use the executor isn't
   * pre-allowed to make is surfaced to the human instead of dead-ending (#66).
   * Both must be set together; omit for an executor with no escalation path.
   */
  readonly permissionPromptTool?: string;
  readonly mcpConfigPath?: string;
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). */
  readonly run?: RunClaudeCode;
}

/**
 * An executor {@link Respond} backed by Claude Code: each task runs a headless
 * `claude` agent in a per-executor workspace, with executor-role instructions
 * appended to its system prompt, and its result text is returned as the reply.
 * Turns share one pinned Claude session — created on the first turn
 * (`--session-id`) and resumed on later ones (`--resume`) — so the executor
 * retains context across an interactive exchange. The agent's own tools and
 * agent loop do the work — runs on the user's Claude Code subscription, no API
 * key required.
 */
export function createClaudeCodeResponder(options: ClaudeCodeResponderOptions): Respond {
  const {
    workdir,
    appendSystemPrompt = DEFAULT_EXECUTOR_ROLE,
    claudeSessionId = randomUUID(),
    permissionPromptTool,
    mcpConfigPath,
    run = runClaudeCodeCli,
  } = options;
  // The pinned Claude session: the first turn creates it (`--session-id`), later
  // turns resume it (`--resume`). `sessionId` is mutable because a turn that fails
  // *before* any session is established may still have made `claude` register the
  // id (an auth failure does), so a retry that re-creates the same id would hit
  // "Session ID … already in use" — rotate to a fresh id so the retry creates
  // cleanly. Once a session is established, the id is kept so a later-turn failure
  // can resume without losing the conversation (#90).
  let sessionId = claudeSessionId;
  let started = false;
  return async (message) => {
    // Permission requests/decisions are a side-channel between the MCP server and
    // the view — not task prompts. Ignoring them keeps the executor from feeding
    // its own mid-run permission request back into Claude as a new turn (#66).
    if (message.type === INTERACTION_REQUEST || message.type === INTERACTION_DECISION) return undefined;
    const body = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    // Prefix the sender's identity + role so the agent reads who it's hearing
    // from — the authoritative architect vs. a peer/subordinate agent (#86).
    const prompt = `${senderAttribution(message)}\n\n${body}`;
    let result: string;
    try {
      result = (
        await run(prompt, {
          cwd: workdir,
          appendSystemPrompt,
          sessionId,
          resume: started,
          permissionPromptTool,
          mcpConfigPath,
        })
      ).trim();
    } catch (error) {
      // A turn failed before the session was established: the id may already be
      // claimed by `claude`, so rotate it so the retry creates fresh instead of
      // colliding. An established session (started) keeps its id and resumes.
      if (!started) sessionId = randomUUID();
      throw error;
    }
    started = true;
    return result ? { type: 'result', payload: result } : undefined;
  };
}
