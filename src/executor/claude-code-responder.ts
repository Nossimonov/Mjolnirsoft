import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Message } from '../core/channel.ts';
import { composeAgentInstructions } from '../core/agent-instructions.ts';
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
 * The serialized `--settings` policy for an agent of `role`. Executors and evaluators
 * get the base {@link EXECUTOR_PERMISSIONS}; the **orchestrator** additionally may
 * `git push` and run `gh` so it can integrate a delegate's work by pushing the branch
 * and opening a PR (#137) — it still can't force-push or hard-reset (the architect
 * reviews and merges; that merge is the ratification, #71). Everything else (the
 * `Agent` deny #131, auto-memory off #132, CLAUDE.md excludes #121) is inherited.
 */
export function permissionPolicyFor(role: string): string {
  if (role !== 'orchestrator') return EXECUTOR_PERMISSIONS;
  const base = EXECUTOR_PERMISSION_POLICY;
  return JSON.stringify({
    ...base,
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
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). */
  readonly run?: RunClaudeCode;
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

export function createClaudeCodeResponder(options: ClaudeCodeResponderOptions): Respond {
  const {
    workdir,
    appendSystemPrompt = DEFAULT_EXECUTOR_ROLE,
    claudeSessionId = randomUUID(),
    permissionPromptTool,
    mcpConfigPath,
    settings,
    model,
    run = runClaudeCodeCli,
    onReasoningChange,
    onUsage,
    resume = false,
  } = options;
  // The pinned Claude session: the first turn creates it (`--session-id`), later
  // turns resume it (`--resume`). `sessionId` is mutable because a turn that fails
  // *before* any session is established may still have made `claude` register the
  // id (an auth failure does), so a retry that re-creates the same id would hit
  // "Session ID … already in use" — rotate to a fresh id so the retry creates
  // cleanly. Once a session is established, the id is kept so a later-turn failure
  // can resume without losing the conversation (#90).
  let sessionId = claudeSessionId;
  // `started` gates `--session-id` (create, first turn) vs `--resume` (later turns).
  // A re-attached session (#126) starts already-`started`, so its first turn resumes
  // the conversation the reload left behind rather than colliding on create.
  let started = resume;
  return async (message) => {
    // Only conversation reaches here: infrastructure (permission/delegation control,
    // per-turn usage, reasoning digests) is filtered upstream by the agent runtime's
    // allowlist (`deliversToAgent` in executor-runtime), so the responder no longer
    // keeps its own denylist of side-channel types — a new infra type can't reach an
    // agent by default, rather than relying on this list being kept current (#116).
    const body = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    // Prefix the sender's identity + role so the agent reads who it's hearing
    // from — the authoritative architect vs. a peer/subordinate agent (#86).
    const prompt = `${senderAttribution(message)}\n\n${body}`;
    let result: string;
    // The turn's assembled reasoning trail (#110), captured from the run's stream;
    // posted to the channel alongside the result so it survives reload/replay.
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
        onDigest: (d) => {
          digest = d;
        },
      });
    try {
      result = (await runTurn(started)).trim();
    } catch (error) {
      if (started && isNoConversation(error)) {
        // Re-attaching a session whose conversation doesn't exist — an old session
        // from before stable ids, or one interrupted before its first turn ever ran —
        // so there's nothing to `--resume`. Create it fresh on this same worktree and
        // retry the turn so it isn't lost: context from before the reload is gone, but
        // the session continues instead of dead-ending on every turn (#126).
        started = false;
        result = (await runTurn(false)).trim();
      } else {
        // Failed before establishing a session: the id may already be claimed by
        // `claude`, so rotate it so the retry creates fresh instead of colliding
        // ("Session ID … already in use"). An established session keeps its id (#90).
        if (!started) sessionId = randomUUID();
        throw error;
      }
    }
    started = true;
    // A resultless turn replies with nothing, exactly as before — the digest rides
    // *with* a result, never alone: a lone digest message wouldn't settle the
    // turn's "working" indicator (only the `result` does, #100), so it would spin.
    if (!result) return undefined;
    // Post the durable digest *before* the result so the view renders the
    // (collapsed) reasoning trail above the clean result, matching the live
    // layout. Skip an empty digest (a turn with no thinking/tools) — no log noise;
    // then the reply is the bare result object, exactly as a non-streaming run (#110).
    if (digest && digest.entries.length > 0) {
      return [
        { type: REASONING_DIGEST, payload: digest },
        { type: 'result', payload: result },
      ];
    }
    return { type: 'result', payload: result };
  };
}
