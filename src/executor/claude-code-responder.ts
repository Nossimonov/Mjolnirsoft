import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Message } from '../core/channel.ts';
import { composeAgentInstructions } from '../core/agent-instructions.ts';
import { contextWindowFor } from '../core/model-context-window.ts';
import { createReasoningDigestAssembler, REASONING_DIGEST, type ReasoningDigest } from './reasoning-digest.ts';
import type { Respond } from './executor-runtime.ts';

/**
 * The labeled line that prefixes every message the executor turns into a prompt,
 * naming the sender's identity and role so the agent can tell the authoritative
 * human apart from a peer/subordinate agent (#86, #71). The `planner` role is the
 * architect/human and is the *only* authoritative sender. An `orchestrator` reads
 * as the (non-authoritative) delegating supervisor — distinct from a plain agent
 * so an executor can tell its task-giving orchestrator from a peer/subordinate
 * agent's report, while still routing design/permission decisions past it to the
 * architect (#114). Every other agent role (executor, evaluator, …) reads as a
 * plain (non-authoritative) agent. This is the seam delegation (#85) needs: once a
 * spawner shares its channel with delegates, a delegate's message can never be
 * mistaken for the architect's instruction.
 */
export function senderAttribution(message: Pick<Message, 'from' | 'role'>): string {
  // `planner` is the authoritative human; an `orchestrator` is the (non-
  // authoritative) delegating supervisor, named distinctly so an executor can tell
  // its task-giver from a peer report (#114); every other spawned agent role
  // (executor, evaluator, …) is a plain non-authoritative `agent`. So neither an
  // orchestrator nor a bridged delegate report (#93) can be mistaken for the
  // architect's instruction (#86), and only `planner` ever reads as authoritative.
  const descriptor =
    message.role === 'planner'
      ? 'architect — authoritative'
      : message.role === 'orchestrator'
        ? 'orchestrator — delegating'
        : 'agent';
  return `[Message from ${descriptor} (id: ${message.from})]`;
}

/**
 * A live, intermediate event parsed from the `claude` NDJSON stream and forwarded
 * to the view as the agent works (#109). These are *ephemeral* — they never touch
 * the durable channel or the JSONL log; only the final `result` persists, as today.
 *
 *  - `thinking` — a token chunk of the agent's reasoning (a `thinking_delta`).
 *  - `text` — a token chunk of the agent's answer text (a `text_delta`).
 *  - `tool-use` — the agent started a tool call; `name` is the tool (e.g. `Bash`).
 */
export type ViewEvent =
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-use'; readonly name: string };

/**
 * One turn's token usage, read from the `claude` result line (#116). Tokens only:
 * a subscription run reports no `total_cost_usd` (there's no per-token billing), and
 * tokens are what the session limit is actually measured against anyway. Cache reads
 * are ~10x cheaper than fresh input, so the breakdown is kept (a raw sum over-states
 * the limit weight) rather than collapsed to one number.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** Sum two {@link Usage} tallies — the basis for per-session accumulation and spawner roll-up (#116). */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** A zero tally to seed an accumulator. */
export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

// Per-kind cost-proxy multipliers (#133). Output is ~5× more limit-heavy than fresh input;
// cache-read is ~10× cheaper; cache-creation carries a small write premium.
const WEIGHT_INPUT = 1;
const WEIGHT_OUTPUT = 5;
const WEIGHT_CACHE_READ = 0.1;
const WEIGHT_CACHE_CREATION = 1.25;

/**
 * A cost-equivalent token weight for {@link Usage} (#133): applies per-kind multipliers
 * (output × 5, cache-read × 0.1, cache-creation × 1.25, input × 1) to give a figure that
 * tracks real budget impact rather than raw count. Rounded to the nearest integer so it
 * compacts cleanly alongside the raw total.
 */
export function weightedUsage(u: Usage): number {
  return Math.round(
    u.inputTokens * WEIGHT_INPUT +
    u.outputTokens * WEIGHT_OUTPUT +
    u.cacheReadTokens * WEIGHT_CACHE_READ +
    u.cacheCreationTokens * WEIGHT_CACHE_CREATION,
  );
}

/**
 * Channel message type carrying one turn's {@link Usage} (#116). Like the delegation
 * and interaction control messages, it rides the channel for persistence/transport
 * but is *plumbing*, not a task prompt — the responder short-circuits it so an agent
 * never feeds its own per-turn usage back to itself as a new turn (which would loop).
 */
export const USAGE_MESSAGE = 'usage';

/** Options shaping a one-shot `claude` run beyond the task prompt and cwd. */
export interface ClaudeRunArgs {
  /**
   * The model to run, passed to `--model` (e.g. `sonnet`, `opus`, `haiku`, or a
   * full id). Omit to inherit the user's default Claude Code model (#119). Set
   * per role so the mechanical roles (executor/evaluator) can run a cheaper tier
   * than the orchestrator, which stays on the user's default (the design agent).
   */
  readonly model?: string;
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
  /** The serialized `--settings` policy (default {@link EXECUTOR_PERMISSIONS}); the orchestrator passes a push-capable variant (#137). */
  readonly settings?: string;
  /**
   * Live seam (#109/#110): called with a block-level {@link ReasoningDigest}
   * **snapshot** each time the trail gains a visible entry as the agent works (a
   * thinking block, an interim narration block, or a tool finalizes; a tool result
   * attaches). The host forwards these to the webview ephemerally; the durable
   * channel/log is untouched. The same entries are persisted via {@link onDigest},
   * so the live view and the reloaded digest show identical data — no settle-time
   * swap, no token smear. Omit to ignore the stream and only take the final result.
   */
  readonly onReasoningChange?: (digest: ReasoningDigest) => void;
  /**
   * Digest seam (#110): called once when the run completes with the final assembled
   * {@link ReasoningDigest} — the same block-level entries as the last
   * {@link onReasoningChange} snapshot. This is the *durable* trail the responder
   * persists to the channel alongside the result. Omit (along with
   * {@link onReasoningChange}) to skip digest assembly entirely (no per-line overhead).
   */
  readonly onDigest?: (digest: ReasoningDigest) => void;
  /**
   * Usage seam (#116): called once when the run completes with the turn's token
   * {@link Usage}, read from the `result` line. The host accumulates it per session
   * and rolls sub-agent usage into the spawner — all in code, so no agent turn is
   * spent counting. Omit to ignore usage.
   */
  readonly onUsage?: (usage: Usage) => void;
}

/**
 * Parse one NDJSON line from `claude --output-format stream-json --verbose
 * --include-partial-messages` into a live {@link ViewEvent}, the final `result`
 * marker, or `null` for a line the live view ignores. Pure (no I/O), so it's
 * unit-tested against fake stream lines without ever spawning `claude`.
 *
 * The stream emits one JSON object per line. We consume only the `stream_event`
 * lifecycle deltas for the live view — the periodic `assistant` snapshot lines
 * re-state the whole message so far and would double-render if streamed. Token
 * deltas: `text_delta` (answer text) and `thinking_delta` (reasoning); a tool
 * call is announced by a `content_block_start` whose block is a `tool_use`. The
 * terminal `{"type":"result",…}` line is returned as a `result` marker carrying
 * its raw JSON, which the runner feeds to {@link interpretClaudeResult} exactly
 * as the old single-object `--output-format json` stdout was. Everything else
 * (system init/status, rate-limit events, `message_start`/`_stop`, block stops,
 * `signature_delta`, `input_json_delta`) is bookkeeping the view skips.
 */
export function parseStreamEvent(line: string): ViewEvent | { kind: 'result'; raw: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as { type?: unknown; event?: unknown };
  if (record.type === 'result') return { kind: 'result', raw: trimmed };
  if (record.type !== 'stream_event' || typeof record.event !== 'object' || record.event === null) return null;
  const event = record.event as { type?: unknown; delta?: unknown; content_block?: unknown };
  if (event.type === 'content_block_start') {
    const block = event.content_block as { type?: unknown; name?: unknown } | null;
    if (block && block.type === 'tool_use' && typeof block.name === 'string') {
      return { kind: 'tool-use', name: block.name };
    }
    return null;
  }
  if (event.type === 'content_block_delta') {
    const delta = event.delta as { type?: unknown; text?: unknown; thinking?: unknown } | null;
    if (delta && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return { kind: 'thinking', text: delta.thinking };
    }
    if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'text', text: delta.text };
    }
    return null;
  }
  return null;
}

/** Receives the parsed output of an NDJSON stream: live view events and the final result line. */
export interface StreamReaderHandlers {
  /**
   * Each intermediate {@link ViewEvent} parsed from a complete line, in order.
   * Optional: the live view is now driven by the block-level digest assembler (via
   * `onLine`), so production omits this; `parseStreamEvent` and this token seam are
   * retained for direct unit testing of the stream shapes.
   */
  readonly onEvent?: (event: ViewEvent) => void;
  /** The raw JSON of the terminal `result` line, captured for {@link interpretClaudeResult}. */
  readonly onResult: (raw: string) => void;
  /**
   * Each complete raw line, before parsing (#110). The digest assembler taps this
   * to see the lower-level events `parseStreamEvent` discards — tool-input deltas,
   * `tool_result` lines — that the block-level digest needs. Optional; omit to skip.
   */
  readonly onLine?: (line: string) => void;
}

/**
 * A line-buffering reader for the `claude` NDJSON stream. `feed` is called with
 * each raw stdout string chunk — which split on arbitrary byte boundaries, not
 * line boundaries — so it buffers and only parses on a complete `\n`-terminated
 * line; `flush` parses any trailing line left without a newline (the terminal
 * `result` line frequently is one). Each complete line goes through
 * {@link parseStreamEvent}: a {@link ViewEvent} fires `onEvent`, the `result`
 * marker fires `onResult`. Pure of I/O (it never touches the process), so the
 * buffering — chunk-split-mid-line, no-trailing-newline, CRLF — is unit-tested
 * directly without spawning `claude`.
 */
export function createStreamReader(handlers: StreamReaderHandlers): {
  feed(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  const handleLine = (line: string): void => {
    handlers.onLine?.(line); // raw tap for the digest assembler (#110), before parsing
    const event = parseStreamEvent(line);
    if (!event) return;
    if (event.kind === 'result') handlers.onResult(event.raw);
    else handlers.onEvent?.(event);
  };
  return {
    feed(chunk) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    flush() {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
    },
  };
}

/** Runs a one-shot headless Claude Code task in `cwd`, returning its result text. */
export type RunClaudeCode = (prompt: string, options: { cwd: string } & ClaudeRunArgs) => Promise<string>;

/**
 * Per-turn callbacks forwarded into a persistent session's {@link StreamSession.send}
 * (#172). Mirrors the per-turn subset of {@link ClaudeRunArgs} callbacks.
 */
export interface StreamTurnHandlers {
  readonly onReasoningChange?: (digest: ReasoningDigest) => void;
  readonly onUsage?: (usage: Usage) => void;
  readonly onDigest?: (digest: ReasoningDigest) => void;
}

/**
 * A persistent streaming `claude` session (#172): push one user message, get back
 * the result text. The process stays alive between calls (stdin kept open); a new
 * message is pushed to stdin for each turn. `close()` terminates the session
 * (closes stdin, letting claude exit cleanly).
 */
export interface StreamSession {
  send(prompt: string, handlers: StreamTurnHandlers): Promise<string>;
  close(): void;
}

/**
 * Factory that creates a {@link StreamSession} for the given session options (#172).
 * Injectable so tests can provide a mock session without spawning the real CLI.
 */
export type CreateStreamSession = (options: { cwd: string } & ClaudeRunArgs) => StreamSession;

/**
 * The `--settings` payload for the executor's headless `claude`. Two parts:
 *
 * 1. `permissions` — no prompts for what a normal dev task needs (reads, cwd-scoped
 *    edits, shell commands), with a few clearly-dangerous commands denied. This is
 *    *soft* confinement — on native Windows there's no OS sandbox, so the worktree
 *    cwd, the executor-role instructions, and the developer's branch review are the
 *    real boundary (Bash can still escape this policy). A WSL sandbox would be the
 *    hard boundary. See #62.
 * 2. `claudeMdExcludes` — glob patterns (matched against absolute paths) of
 *    `CLAUDE.md`/`CLAUDE.local.md` files to skip when loading memory (#121). A
 *    spawned agent should get only its composed role instructions, not the
 *    project's CLAUDE.md — which `claude -p` otherwise walks the directory tree to
 *    load (so a worktree inherits the repo-root file) and whose architect-grade
 *    protocol an agent would then enact (the issue-discipline ceremony). We exclude
 *    *all* CLAUDE.md (user/project/local) so the role layer is the agent's whole
 *    operating manual. This rides `--settings`, so unlike `--bare` it doesn't touch
 *    OAuth/keychain auth; managed-policy memory can't be excluded this way (not used
 *    here). Belt-and-braces with the role layer's own "bookkeeping is the
 *    architect's" boundary, which still holds for any memory this can't reach.
 */
export const EXECUTOR_PERMISSION_POLICY = {
  permissions: {
    // The delegation MCP tools (#93) are pre-allowed so an executor can delegate
    // (e.g. spawn an evaluator to cold-read its diff) without each spawn dead-
    // ending on a prompt — spawning is a safe, read-only-by-role action gated by
    // protocol, not by a human decision. The actual spawn still bridges to the
    // host, which decides what a role may do.
    allow: [
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'Edit(./**)',
      'Write(./**)',
      'Bash',
      'mcp__delegate__spawn',
      'mcp__delegate__send',
      'mcp__delegate__shutdown',
    ],
    // `Agent` (claude's native sub-agent / sub-task tool) is denied so a spawned
    // agent can't spin up its own ad-hoc sub-agents (#131): they're a heavyweight,
    // opaque token sink whose output balloons the spawner's context, and they're
    // redundant with our own delegation (`mcp__delegate__*`, which this doesn't
    // touch). A bare deny strips the tool from the agent's context entirely, so it
    // falls back to direct reads or — better — asks upward for context it lacks.
    deny: ['Agent', 'Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(sudo *)'],
  },
  // Skip every CLAUDE.md/CLAUDE.local.md (user/project/local) so a spawned agent
  // loads only its composed role instructions, not the project's architect-grade
  // protocol (#121). Globs match absolute paths; forward slashes work cross-platform.
  claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md'],
  // Turn off claude's built-in auto-memory for spawned agents (#132). Its memory dir
  // is keyed to the agent's cwd — an ephemeral worktree — so anything it saves orphans
  // when the worktree is removed and is never recalled by a later session (a different
  // worktree). Worse, the learnings belong *up* with the architect/orchestrator, not in
  // an agent's private notes (#71): the role layer tells agents to surface them in the
  // hand-off. Auto-memory is a built-in (no tool to deny); this settings toggle is the
  // off switch, read from `--settings` like the rest of this policy.
  autoMemoryEnabled: false,
  // Turn off built-in auto-compaction for short-lived executor/evaluator sessions (#224).
  // They have no longevity problem, so the overhead of compaction (which fires on token
  // count alone, ignoring task boundaries) is pure waste. The orchestrator opts in
  // separately via permissionPolicyFor('orchestrator', model, factor).
  autoCompactEnabled: false,
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

/**
 * Read-only variant of {@link EXECUTOR_PERMISSION_POLICY}: `Edit`, `Write`, and
 * `NotebookEdit` are removed from the allow list and explicitly added to the deny
 * list, so a misbehaving evaluator or investigator is blocked at the *declarative*
 * tool level — not merely discouraged by role instructions (#185).
 *
 * **Soft-confinement caveat (same as the executor policy, #62):** `Bash` remains
 * allowed (read-only roles legitimately need `git log`/`git diff`/`gh issue view`),
 * so shell-mediated file writes are not blocked at this layer. The hard read-only
 * boundary requires an OS-level sandbox (tracked by #62).
 */
export const READONLY_PERMISSION_POLICY = {
  ...EXECUTOR_PERMISSION_POLICY,
  permissions: {
    allow: EXECUTOR_PERMISSION_POLICY.permissions.allow.filter(
      (rule) => rule !== 'Edit(./**)' && rule !== 'Write(./**)',
    ),
    deny: [...EXECUTOR_PERMISSION_POLICY.permissions.deny, 'Edit', 'Write', 'NotebookEdit'],
  },
};

/** The read-only policy serialized for `--settings` (#185). */
export const READONLY_PERMISSIONS = JSON.stringify(READONLY_PERMISSION_POLICY);

/**
 * The serialized `--settings` policy for an agent of `role`.
 * - **evaluator / investigator** — {@link READONLY_PERMISSIONS}: reads/search/inspection
 *   allowed; `Edit` and `Write` denied at the policy level (hard enforcement, #185).
 * - **executor / arbitrator** — base {@link EXECUTOR_PERMISSIONS}: full cwd-scoped edits.
 * - **orchestrator** — extends the base with `git push` and `gh` so it can integrate
 *   delegate work by pushing the branch and opening a PR (#137); force-push still denied.
 *   Also enables Claude Code's built-in auto-compaction (#224): `autoCompactEnabled: true`
 *   and `autoCompactWindow` derived from the model's context window × `autoCompactFactor`.
 *
 * Everything else (`Agent` deny #131, auto-memory off #132, CLAUDE.md excludes #121,
 * `autoCompactEnabled: false` for executors/evaluators #224) is inherited from the base.
 *
 * @param model — the orchestrator's model (used to derive `autoCompactWindow`); omit to
 *   use the default 1M-window assumption (safe — `min(configured, model_max)` applies).
 * @param autoCompactFactor — fraction of the model window to set as the compaction
 *   threshold (default 0.5). Drive from `mjolnir.config.json` when available.
 */
export function permissionPolicyFor(role: string, model?: string, autoCompactFactor = 0.5): string {
  if (role === 'evaluator' || role === 'investigator') return READONLY_PERMISSIONS;
  if (role !== 'orchestrator') return EXECUTOR_PERMISSIONS;
  const base = EXECUTOR_PERMISSION_POLICY;
  // autoCompactWindow is an absolute token count; effective threshold = min(configured, model_max).
  const autoCompactWindow = Math.round(contextWindowFor(model) * autoCompactFactor);
  return JSON.stringify({
    ...base,
    autoCompactEnabled: true,   // override the base false for the long-lived orchestrator
    autoCompactWindow,
    permissions: {
      ...base.permissions,
      // Lift the blanket git-push deny (so a normal push is allowed) but keep
      // force-push off-limits — the orchestrator proposes via a PR, never rewrites history.
      deny: [
        ...base.permissions.deny.filter((rule) => rule !== 'Bash(git push *)'),
        'Bash(git push --force *)',
        'Bash(git push -f *)',
      ],
    },
  });
}

/** Build the `claude` argv for a one-shot run from the task prompt and run options. */
export function buildClaudeArgs(prompt: string, options: ClaudeRunArgs = {}): string[] {
  // `--output-format stream-json` (which requires `--verbose`) emits the run as
  // NDJSON; `--include-partial-messages` adds the token-level `stream_event`
  // deltas the live view streams (#109). The terminal `result` line carries the
  // same final text the old single-object `json` format put on stdout, so the
  // durable channel/log is unchanged — only the intermediate events are new.
  //
  // NOTE (#121): we deliberately do NOT pass `--bare` to drop the project CLAUDE.md.
  // It would, but it *also* skips OAuth/keychain reads, breaking the subscription
  // login (auth errors no re-login can fix). Instead CLAUDE.md is excluded via the
  // `claudeMdExcludes` key in `--settings` (see {@link EXECUTOR_PERMISSION_POLICY}),
  // which rides settings and so leaves auth untouched.
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--settings',
    options.settings ?? EXECUTOR_PERMISSIONS,
  ];
  if (options.model) args.push('--model', options.model);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.sessionId) args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  if (options.permissionPromptTool) args.push('--permission-prompt-tool', options.permissionPromptTool);
  if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
  return args;
}

/**
 * Build the `claude` argv for a persistent streaming session (#172): the same flags
 * as {@link buildClaudeArgs} but with `--input-format stream-json` (stdin becomes
 * an NDJSON message pipe) instead of a prompt argv element. `--print` replaces `-p`
 * (equivalent; long form is clearer in this context). No prompt argument — messages
 * are pushed to stdin as `{"type":"user","message":{"role":"user","content":"…"}}` lines.
 */
export function buildStreamSessionArgs(options: ClaudeRunArgs = {}): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--settings',
    options.settings ?? EXECUTOR_PERMISSIONS,
  ];
  if (options.model) args.push('--model', options.model);
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
 * Interpret a finished `claude` run's terminal `result` event into its result
 * text, or throw an informative Error. Under `--output-format stream-json` (#109)
 * the run is NDJSON and this is fed the single `{"type":"result",…}` line — the
 * same object the old `--output-format json` wrote to stdout whole, so the contract
 * is unchanged. `claude` emits a result event *even on failure* — the human-readable
 * error lands in `result` (an expired/absent login surfaces `"Not logged in ·
 * Please run /login"`) with `is_error: true` and a non-zero exit, while stderr is
 * typically empty. So the failure detail must be taken from the JSON `result` first
 * (then stderr, then the raw line): a stderr-only path drops it and leaves the
 * surfaced error turn blank and unclassifiable — which is exactly what hid the auth
 * signal from the re-login card (#90, #89). When no result line was captured (a
 * crash before one is emitted), the caller feeds the whole raw stream instead: it
 * won't `JSON.parse`, so the detail falls through to the raw text — which still
 * carries any auth wording for isAuthError to classify — before the exit-code last
 * resort. Pure (no I/O), so the parsing is unit-tested without spawning `claude`.
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
 * Pull the turn's token {@link Usage} from a `claude` result line (#116). The
 * terminal `{"type":"result",…}` line carries a `usage` object with
 * `{input,output,cache_read_input,cache_creation_input}_tokens`. Returns undefined
 * when the line is missing/unparseable or carries no usage (so an unmeasured turn
 * is simply not counted). Pure — unit-tested against captured result lines.
 */
export function extractUsage(resultRaw: string): Usage | undefined {
  let parsed: { usage?: Record<string, unknown> } | undefined;
  try {
    parsed = JSON.parse(resultRaw) as { usage?: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const u = parsed?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return {
    inputTokens: n('input_tokens'),
    outputTokens: n('output_tokens'),
    cacheReadTokens: n('cache_read_input_tokens'),
    cacheCreationTokens: n('cache_creation_input_tokens'),
  };
}

/**
 * Extracts per-turn {@link Usage} from the `iterations[i]` entry of a multi-turn
 * combined result line (#172). When `--input-format stream-json` bundles N pushed
 * messages into one `result` line, the `iterations` array carries one usage record
 * per turn. Each entry's usage may be nested as `iter.usage` or at the top level.
 * Returns undefined when the iteration is absent or carries no token counts.
 */
export function extractIterationUsage(iterations: unknown[], i: number): Usage | undefined {
  const iter = iterations[i];
  if (!iter || typeof iter !== 'object') return undefined;
  const iterObj = iter as Record<string, unknown>;
  // Usage may be nested as iter.usage (likely) or at the top level of the iter object.
  const u = (iterObj.usage && typeof iterObj.usage === 'object')
    ? iterObj.usage as Record<string, unknown>
    : iterObj;
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const tally: Usage = {
    inputTokens: n('input_tokens'),
    outputTokens: n('output_tokens'),
    cacheReadTokens: n('cache_read_input_tokens'),
    cacheCreationTokens: n('cache_creation_input_tokens'),
  };
  return (tally.inputTokens || tally.outputTokens || tally.cacheReadTokens || tally.cacheCreationTokens)
    ? tally : undefined;
}

/**
 * Default launcher: spawn `claude -p` headless. A non-`--bare` run uses the
 * logged-in Claude Code session (the user's subscription). With `--output-format
 * stream-json` the run streams as NDJSON: stdout is read line-by-line. The raw
 * lines feed the block-level digest assembler, which drives the live view
 * (`onReasoningChange` snapshots, #109/#110) and the durable digest (`onDigest`);
 * the terminal `result` line is held and passed to {@link interpretClaudeResult}
 * on close, so the returned final text — the only thing that reaches the durable
 * channel as the answer — is exactly as before.
 * The task is passed as an argv element (no shell), so prompt contents are not
 * interpreted by a shell.
 */
export const runClaudeCodeCli: RunClaudeCode = (
  prompt,
  options,
) =>
  new Promise((resolve, reject) => {
    const { cwd, onReasoningChange, onDigest, onUsage } = options;
    // Pass the whole options object through: `buildClaudeArgs` reads only the
    // flag-relevant fields and ignores `cwd`/the callbacks, so a CLI flag can't be
    // silently dropped by hand-listing fields here (that dropped `--model`, #119).
    const args = buildClaudeArgs(prompt, options);
    const child = spawn(resolveClaudeBin(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    // The terminal `result` line, captured by the reader, is what feeds
    // interpretClaudeResult. `stdout` accumulates the *whole* raw stream as a
    // fallback: if no result line is ever emitted (a crash, or an error routed to
    // a different line shape), interpretClaudeResult is given the raw stream so its
    // error detail — and the #90 auth signal isAuthError scans for — isn't lost to
    // a bare "exited with code N".
    let resultRaw = '';
    let stdout = '';
    // Assemble the block-level reasoning trail (#110) when any consumer wants it —
    // the live view (`onReasoningChange`, fed each snapshot via the assembler's
    // `onChange`) and/or the durable digest (`onDigest`, taken from `build()` on
    // close). One assembler serves both, so they never diverge. It taps the raw
    // stream via `onLine` to see the tool-input deltas and `tool_result` lines the
    // view's `parseStreamEvent` discards. No consumer → no per-line work.
    const digest =
      onDigest || onReasoningChange
        ? createReasoningDigestAssembler({ onChange: onReasoningChange })
        : undefined;
    const reader = createStreamReader({
      onResult: (raw) => {
        resultRaw = raw;
      },
      onLine: digest ? (line) => digest.feed(line) : undefined,
    });
    // Decode stdout through a StringDecoder so a multi-byte UTF-8 char split across
    // two `data` chunks isn't mangled into U+FFFD — it would otherwise corrupt a
    // live delta or, worse, the durable result text.
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => {
      const text = decoder.write(chunk as Buffer);
      stdout += text;
      reader.feed(text);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const tail = decoder.end();
      if (tail) {
        stdout += tail;
        reader.feed(tail);
      }
      reader.flush(); // parse a final line with no trailing newline (the `result` line often is one)
      if (digest && onDigest) onDigest(digest.build()); // hand the assembled trail back for persistence (#110)
      if (onUsage) {
        const usage = extractUsage(resultRaw || stdout); // read the turn's token usage from the result line (#116)
        if (usage) onUsage(usage);
      }
      try {
        resolve(interpretClaudeResult(resultRaw || stdout, stderr, code));
      } catch (error) {
        reject(error as Error);
      }
    });
  });

/** One in-flight `send()` call waiting for its turn's result from the stream. */
export interface PendingEntry {
  resolve(v: string): void;
  reject(e: Error): void;
  handlers: StreamTurnHandlers;
  digestAssembler?: ReturnType<typeof createReasoningDigestAssembler>;
}

/**
 * Manages the FIFO pending-entry queue for {@link createPersistentCli} (#172).
 *
 * **Combined envelope:** when `--input-format stream-json` bundles N pushed messages
 * into one `result` line (e.g. message B pushed while a tool is running for A),
 * `num_turns>1` and `result.result` is the *last* turn's text only. Intermediate
 * answers live in the `assistant` message events in the stream. This multiplexer
 * tracks turn boundaries by watching for injected user-message echoes in the stream
 * (`{"type":"user","message":{"role":"user","content":"<string>"}}`), captures the
 * preceding assistant text per turn, and resolves all N entries when the single
 * result line arrives: entries 0..N-2 from the captured text, entry N-1 from
 * `result.result`. Per-turn usage comes from `result.iterations[i]` (#116).
 *
 * Extracted from `createPersistentCli` for unit-testability: the turn-boundary
 * logic is pure (no I/O) and can be driven by feeding raw stream lines.
 */
export function createTurnMultiplexer(getStderr: () => string): {
  add(entry: PendingEntry): void;
  onResult(raw: string): void;
  onLine(line: string): void;
  drain(err: Error): void;
} {
  const pending: PendingEntry[] = [];
  // Intermediate turn answers committed as the stream crosses each turn boundary.
  // committed[i].text = turn i's answer (all turns except the last).
  const committed: Array<{ text: string }> = [];
  let lastAssistantText = '';
  // Number of injected user-message echoes seen so far (each marks a new turn start).
  let userTurnsSeen = 0;

  const onLine = (line: string): void => {
    // Feed the currently-active turn's digest assembler. committed.length is the index
    // of the active turn: entries 0..committed.length-1 are already captured; the next
    // entry is still accumulating stream events.
    // Note: the turn-boundary user-echo line is fed to the PRIOR turn's assembler
    // (committed.length hasn't incremented yet when this runs). That is harmless:
    // createReasoningDigestAssembler's handleToolResults guards `!Array.isArray(content)`
    // and user-echo content is a string, so the line is silently ignored by the assembler.
    pending[committed.length]?.digestAssembler?.feed(line);

    let obj: unknown;
    try { obj = JSON.parse(line.trim()); } catch { return; }
    if (typeof obj !== 'object' || obj === null) return;
    const rec = obj as { type?: unknown; message?: unknown };

    if (rec.type === 'assistant') {
      // Capture the text of the most recent complete assistant message. It will be
      // committed as the current turn's answer when the next user echo arrives.
      const msg = rec.message as { content?: unknown } | null;
      if (Array.isArray(msg?.content)) {
        const text = (msg!.content as Array<{ type?: string; text?: string }>)
          .filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        if (text) lastAssistantText = text;
      }
      return;
    }

    if (rec.type === 'user') {
      const msg = rec.message as { role?: unknown; content?: unknown } | null;
      // Injected messages have string content; tool results have array content — skip those.
      if (msg?.role === 'user' && typeof msg.content === 'string') {
        userTurnsSeen++;
        if (userTurnsSeen > 1) {
          // A new turn is starting: the previous turn's assistant text is now final.
          committed.push({ text: lastAssistantText });
          lastAssistantText = '';
        }
      }
    }
  };

  const onResult = (raw: string): void => {
    let parsed: { num_turns?: number; iterations?: unknown[]; is_error?: boolean } | undefined;
    try { parsed = JSON.parse(raw) as typeof parsed; } catch {}
    const numTurns = Math.max(1, parsed?.num_turns ?? 1);
    const iterations = Array.isArray(parsed?.iterations) ? parsed!.iterations : [];
    // is_error is session-level, not turn-specific: if any turn produced an error the
    // whole run is marked failed. Resolving intermediate entries as success while only
    // rejecting the last would give callers a spurious partial success. Route all entries
    // through interpretClaudeResult (which throws on is_error) so all are rejected.
    const isErrorResult = !!parsed?.is_error;

    const toResolve = pending.splice(0, numTurns);
    for (let i = 0; i < toResolve.length; i++) {
      const entry = toResolve[i]!;
      const isLast = i === toResolve.length - 1;
      if (entry.handlers.onUsage) {
        // Per-turn usage from iterations[i]; fall back to aggregate for single-turn results.
        const usage = extractIterationUsage(iterations, i) ?? (numTurns === 1 ? extractUsage(raw) : undefined);
        if (usage) entry.handlers.onUsage(usage);
      }
      if (entry.digestAssembler && entry.handlers.onDigest) {
        entry.handlers.onDigest(entry.digestAssembler.build());
      }
      try {
        // Intermediate turns use the assistant text captured from the stream. If
        // committed[i] is absent (fewer turn boundaries seen than num_turns claims),
        // this resolves with ''; buildReply('') → undefined, so the turn produces no
        // channel message. This is a protocol mismatch from the CLI; in practice it
        // should not occur.
        entry.resolve((!isLast && !isErrorResult)
          ? (committed[i]?.text?.trim() ?? '')
          : interpretClaudeResult(raw, getStderr(), 0),
        );
      } catch (err) {
        entry.reject(err as Error);
      }
    }
    // Reset per-run state so a subsequent run starts clean.
    committed.splice(0);
    lastAssistantText = '';
    userTurnsSeen = 0;
  };

  const drain = (err: Error): void => {
    const drained = pending.splice(0);
    for (const entry of drained) entry.reject(err);
  };

  return { add: (entry) => { pending.push(entry); }, onResult, onLine, drain };
}

/**
 * Persistent streaming session factory: spawn `claude --print --input-format
 * stream-json` once, keep stdin open, and push each user message as an NDJSON
 * line (#172). Messages arriving while a turn is in flight are pushed immediately
 * to stdin so claude can consume them at the next tool boundary within the same
 * running turn — not deferred to a separate later turn.
 *
 * **Combined envelope:** when a message is injected while a tool is running, claude
 * bundles both turns into one `result` line with `num_turns>1`. {@link createTurnMultiplexer}
 * handles this: it tracks turn boundaries in the stream, captures each turn's
 * assistant text, and resolves all N pending entries when the single result arrives.
 *
 * Concurrent sends ARE possible (#172): executor-runtime fires respond() immediately
 * for each incoming channel message. The multiplexer's FIFO queue + per-result reset
 * guarantee correct per-turn attribution regardless of how many messages are in flight.
 */
export const createPersistentCli: CreateStreamSession = ({ cwd, ...runArgs }) => {
  const args = buildStreamSessionArgs(runArgs);
  const child = spawn(resolveClaudeBin(), args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const decoder = new StringDecoder('utf8');
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => { stderrBuf += String(chunk); });

  const mux = createTurnMultiplexer(() => stderrBuf);
  const reader = createStreamReader({ onResult: mux.onResult, onLine: mux.onLine });

  child.stdout.on('data', (chunk) => { reader.feed(decoder.write(chunk as Buffer)); });
  child.on('error', (err) => { mux.drain(err); });
  child.on('close', (code) => {
    const tail = decoder.end();
    if (tail) reader.feed(tail);
    reader.flush(); // parses any trailing result line emitted without a terminating \n
    // Reject remaining entries (process exited before all results were emitted).
    const detail = stderrBuf.trim() || `exited with code ${code ?? 1}`;
    mux.drain(new Error(`claude failed (exit ${code ?? 1}): ${detail}`));
  });

  return {
    send(prompt, handlers) {
      return new Promise<string>((resolve, reject) => {
        const { onReasoningChange, onDigest, onUsage } = handlers;
        const digestAssembler = (onDigest || onReasoningChange)
          ? createReasoningDigestAssembler({ onChange: onReasoningChange })
          : undefined;
        mux.add({ resolve, reject, handlers: { onReasoningChange, onDigest, onUsage }, digestAssembler });
        child.stdin!.write(
          JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
        );
      });
    },
    close() { child.stdin!.end(); },
  };
};

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
  /** The serialized `--settings` policy (default {@link EXECUTOR_PERMISSIONS}); pass {@link permissionPolicyFor}(role) so the orchestrator may push + PR (#137). */
  readonly settings?: string;
  /**
   * The model this responder's runs use (`--model`); omit to inherit the user's
   * default. Set per role so executors/evaluators can run a cheaper tier (#119).
   */
  readonly model?: string;
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). When set, uses the legacy per-turn process model instead of the persistent session. */
  readonly run?: RunClaudeCode;
  /**
   * Override the persistent session factory (#172). When set (and `run` is not),
   * used to create the long-lived streaming session. Tests inject a mock session
   * here; production uses {@link createPersistentCli}. Ignored when `run` is set.
   */
  readonly createSession?: CreateStreamSession;
  /** Delay used between transient-overload retries (#141); injected as a no-op in tests. Default: real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Live seam (#109/#110): forwarded to each run as its `onReasoningChange`, so the
   * host receives block-level {@link ReasoningDigest} snapshots as the executor
   * works and streams them to the view ephemerally. Omit for no streaming.
   */
  readonly onReasoningChange?: (digest: ReasoningDigest) => void;
  /** Usage seam (#116): forwarded to each run as its `onUsage`, so the host accumulates per-turn token usage. */
  readonly onUsage?: (usage: Usage) => void;
  /**
   * Start already resumed (#126): the pinned {@link claudeSessionId} names a
   * conversation that *already exists* (the session was interrupted by a reload and
   * is being re-attached), so the very first turn must `--resume` it rather than
   * `--session-id`-create it. Defaults to `false` (a brand-new session). Pair with a
   * **stable** `claudeSessionId` (see {@link claudeSessionIdFor}) so the re-derived
   * id matches the conversation left behind.
   */
  readonly resume?: boolean;
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
/**
 * A **stable** `claude --session-id` (a UUID) derived from a Mjolnir session id, so a
 * session the extension host had to tear down (a window reload) can resume the *same*
 * `claude` conversation when re-attached — without persisting the id anywhere, since
 * re-deriving it from the session name is enough (#126). Formats a SHA-1 of the name
 * as a v5-shaped UUID (deterministic; `claude` only needs a well-formed UUID).
 */
export function claudeSessionIdFor(sessionId: string): string {
  const h = createHash('sha1').update(`mjolnir:${sessionId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // RFC-4122 variant nibble
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Whether a failed `claude` run means the session asked to `--resume` doesn't exist (#126). */
function isNoConversation(error: unknown): boolean {
  return /no conversation found/i.test(String(error));
}

/** Whether a failed `claude` run is a *transient* server overload worth retrying (#141). */
function isTransient(error: unknown): boolean {
  return /\b(429|503|529)\b|overloaded|rate limit/i.test(String(error));
}

/** Whether a `--session-id` create collided with an id `claude` already registered (#90/#141). */
function isAlreadyInUse(error: unknown): boolean {
  return /already in use/i.test(String(error));
}

/** Per-turn retry budget covering transient overloads + session-id strategy switches (#141). */
const MAX_TURN_ATTEMPTS = 6;
/** Exponential backoff (capped) before retrying a transient overload. */
const transientBackoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 30_000);

/**
 * An executor {@link Respond} backed by Claude Code (#172): a persistent `claude`
 * streaming session (one process per responder lifetime) with messages pushed to
 * stdin as NDJSON lines. The `Respond` seam is preserved — callers see the same
 * `(message) => Promise<Reply|Reply[]>` contract; only the internals change from
 * per-process to per-session.
 *
 * Returns a `Respond` function augmented with `closeSession()` so the caller can
 * terminate the persistent claude process when the session ends (#215). The function
 * is still directly callable as a plain `Respond` (structural subtype).
 *
 * **Legacy `run` path:** when `run` is provided in options, the old per-turn CLI
 * model is used unchanged. This preserves existing tests that inject a fake `run`.
 */
export function createClaudeCodeResponder(
  options: ClaudeCodeResponderOptions,
): Respond & { closeSession(): void } {
  const {
    workdir,
    appendSystemPrompt = DEFAULT_EXECUTOR_ROLE,
    claudeSessionId = randomUUID(),
    permissionPromptTool,
    mcpConfigPath,
    settings,
    model,
    run,
    createSession: createSessionFn,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    onReasoningChange,
    onUsage,
    resume = false,
  } = options;
  const sessionId = claudeSessionId;

  // Shared prompt-building: same for both paths.
  const buildPrompt = (message: Parameters<Respond>[0]): string => {
    const body = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    return `${senderAttribution(message)}\n\n${body}`;
  };

  // Shared reply-building: same for both paths.
  const buildReply = (result: string, digest: ReasoningDigest | undefined): Awaited<ReturnType<Respond>> => {
    if (!result) return undefined;
    if (digest && digest.entries.length > 0) {
      return [{ type: REASONING_DIGEST, payload: digest }, { type: 'result', payload: result }];
    }
    return { type: 'result', payload: result };
  };

  if (run) {
    // Legacy per-turn path: preserve exact behavior for tests that inject `run`.
    // Each message spawns a new one-shot `claude` process with the appropriate
    // --session-id / --resume flag. Tests using this path are sequential so
    // concurrent-send concerns do not apply here.
    let started = resume;
    const respond: Respond = async (message) => {
      const prompt = buildPrompt(message);
      let result: string;
      let digest: ReasoningDigest | undefined;
      const runTurn = (useResume: boolean) =>
        run(prompt, {
          cwd: workdir,
          appendSystemPrompt,
          sessionId,
          resume: useResume,
          permissionPromptTool,
          mcpConfigPath,
          settings,
          model,
          onReasoningChange,
          onUsage,
          onDigest: (d) => { digest = d; },
        });
      let resuming = started;
      for (let attempt = 0; ; attempt++) {
        try {
          result = (await runTurn(resuming)).trim();
          break;
        } catch (error) {
          if (attempt >= MAX_TURN_ATTEMPTS) throw error;
          if (isTransient(error)) {
            if (!resuming) resuming = true;
            await sleep(transientBackoffMs(attempt));
            continue;
          }
          if (resuming && isNoConversation(error)) { resuming = false; continue; }
          if (!resuming && isAlreadyInUse(error)) { resuming = true; continue; }
          throw error;
        }
      }
      started = true;
      return buildReply(result!, digest);
    };
    return Object.assign(respond, { closeSession: (): void => {} });
  }

  // Persistent session path (#172): one `claude --print --input-format stream-json`
  // process for the responder's lifetime. Messages are pushed to stdin as NDJSON
  // lines; each send() resolves when the matching result line arrives. Session is
  // created lazily on the first respond() call and reused across turns.
  // Concurrent sends ARE possible (#172): executor-runtime fires respond() immediately
  // for each incoming channel message without waiting for the prior result. The
  // session's FIFO pending queue (in createPersistentCli) guarantees that result N
  // resolves turn N — claude processes stdin in order and emits one result per message.
  const factory = createSessionFn ?? createPersistentCli;
  let session: StreamSession | null = null;
  let started = resume;

  const respond: Respond = async (message) => {
    const prompt = buildPrompt(message);
    let result: string;
    let digest: ReasoningDigest | undefined;
    // `resuming` tracks the create vs resume strategy for session spawns, mirroring
    // the cross-turn `started` state. Errors may flip it: "no conversation" → create;
    // "already in use" → resume; transient → retry same strategy after backoff.
    let resuming = started;

    for (let attempt = 0; ; attempt++) {
      // Spawn a new session if none is live (first turn, or prior session died).
      if (!session) {
        session = factory({
          cwd: workdir,
          appendSystemPrompt,
          sessionId,
          resume: resuming,
          permissionPromptTool,
          mcpConfigPath,
          settings,
          model,
        });
      }
      digest = undefined; // reset per attempt so a partial prior attempt's digest isn't kept
      try {
        result = (await session.send(prompt, {
          onReasoningChange,
          onUsage,
          onDigest: (d) => { digest = d; },
        })).trim();
        break;
      } catch (error) {
        // Session may be dead after any error — discard it so the next attempt spawns fresh.
        // Use optional chaining: closeSession() may have already nulled `session` (race with
        // dispose while a turn is in flight), in which case `dead` is null and close() would
        // throw a TypeError instead of surfacing the real error (#172).
        //
        // Concurrent-turn note: if two turns share this session and both catch a session-startup
        // error (isNoConversation / isAlreadyInUse), they may race to null/replace `session` in
        // a compounding way: Turn A creates session[1] and yields at await; Turn B catches, closes
        // session[1] (the one A is using), creates session[2]; session[1]'s close handler rejects
        // A's pending send; A's retry closes session[2] (B's current session), etc. Each recovery
        // attempt can trigger the other, burning MAX_TURN_ATTEMPTS across both turns. Practical
        // impact is bounded: this window only opens before `started` is true (startup errors
        // don't arise for established sessions), and transient overloads always sleep before retry
        // (preventing the cascade entirely). Both turns eventually exhaust attempts and post error
        // messages to the channel; no data corruption or infinite loop results.
        const dead = session;
        session = null;
        dead?.close();

        if (attempt >= MAX_TURN_ATTEMPTS) throw error;
        if (isTransient(error)) {
          // A transient server overload: close the dead session and retry after backoff.
          // After a create attempt the id may now be registered, so switch to resume.
          if (!resuming) resuming = true;
          await sleep(transientBackoffMs(attempt));
          continue;
        }
        if (resuming && isNoConversation(error)) {
          // --resume found nothing: create the session fresh (#126).
          resuming = false;
          continue;
        }
        if (!resuming && isAlreadyInUse(error)) {
          // --session-id collided with an already-registered id: resume it (#90/#141).
          resuming = true;
          continue;
        }
        throw error; // not retryable (auth failure, etc.) — surface for the view's re-login card (#90)
      }
    }
    started = true;
    return buildReply(result!, digest);
  };

  const closeSession = (): void => {
    session?.close();
    session = null;
  };

  return Object.assign(respond, { closeSession });
}
