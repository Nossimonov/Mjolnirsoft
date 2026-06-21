import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Message } from '../core/channel.ts';
import { INTERACTION_DECISION, INTERACTION_REQUEST } from '../core/interaction.ts';
import { DELEGATION_REQUEST, DELEGATION_RESPONSE } from '../core/delegation-protocol.ts';
import { composeAgentInstructions } from '../core/agent-instructions.ts';
import { createReasoningDigestAssembler, REASONING_DIGEST, type ReasoningDigest } from './reasoning-digest.ts';
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
  // `planner` is the authoritative human; every spawned agent role (executor,
  // evaluator, …) reads as a non-authoritative `agent`, so a delegate's bridged
  // report (#93) can never be mistaken for the architect's instruction (#86).
  const descriptor = message.role === 'planner' ? 'architect — authoritative' : 'agent';
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
 * Permission policy for the executor's headless `claude`: no prompts for what a
 * normal dev task needs (reads, cwd-scoped edits, shell commands), with a few
 * clearly-dangerous commands denied. This is *soft* confinement — on native
 * Windows there's no OS sandbox, so the worktree cwd, the executor-role
 * instructions, and the developer's branch review are the real boundary (Bash
 * can still escape this policy). A WSL sandbox would be the hard boundary. See #62.
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
      'mcp__delegate__shutdown',
    ],
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
  // `--output-format stream-json` (which requires `--verbose`) emits the run as
  // NDJSON; `--include-partial-messages` adds the token-level `stream_event`
  // deltas the live view streams (#109). The terminal `result` line carries the
  // same final text the old single-object `json` format put on stdout, so the
  // durable channel/log is unchanged — only the intermediate events are new.
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--settings',
    EXECUTOR_PERMISSIONS,
  ];
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
  { cwd, appendSystemPrompt, sessionId, resume, permissionPromptTool, mcpConfigPath, onReasoningChange, onDigest },
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
  /** Override how Claude Code is run (tests inject a fake; default spawns the CLI). */
  readonly run?: RunClaudeCode;
  /**
   * Live seam (#109/#110): forwarded to each run as its `onReasoningChange`, so the
   * host receives block-level {@link ReasoningDigest} snapshots as the executor
   * works and streams them to the view ephemerally. Omit for no streaming.
   */
  readonly onReasoningChange?: (digest: ReasoningDigest) => void;
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
    onReasoningChange,
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
    // Permission requests/decisions (#66) and delegation control messages (#93)
    // are side-channels between an MCP server and the host — not task prompts.
    // Ignoring them keeps the executor from feeding its own mid-run request back
    // into Claude as a new turn. (A delegate's *report* is an ordinary message,
    // not one of these, so it still reaches the executor as a turn.)
    if (
      message.type === INTERACTION_REQUEST ||
      message.type === INTERACTION_DECISION ||
      message.type === DELEGATION_REQUEST ||
      message.type === DELEGATION_RESPONSE
    ) {
      return undefined;
    }
    const body = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
    // Prefix the sender's identity + role so the agent reads who it's hearing
    // from — the authoritative architect vs. a peer/subordinate agent (#86).
    const prompt = `${senderAttribution(message)}\n\n${body}`;
    let result: string;
    // The turn's assembled reasoning trail (#110), captured from the run's stream;
    // posted to the channel alongside the result so it survives reload/replay.
    let digest: ReasoningDigest | undefined;
    try {
      result = (
        await run(prompt, {
          cwd: workdir,
          appendSystemPrompt,
          sessionId,
          resume: started,
          permissionPromptTool,
          mcpConfigPath,
          onReasoningChange,
          onDigest: (d) => {
            digest = d;
          },
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
