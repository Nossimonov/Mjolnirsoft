/**
 * The durable counterpart to #109's ephemeral live reasoning (#110).
 *
 * #109 streams an executor's reasoning to the view token-by-token over an
 * off-channel path that is *gone on reload* — only the final `result` persists.
 * This assembles those same intermediate events into a condensed, **block-level**
 * **reasoning digest** that *is* persisted to the durable channel/JSONL, distinct
 * from the `result`, so the trail survives reload/replay and a later log-reader —
 * the Arbitrator (#99), an Investigator, the orchestrator reviewing — can
 * post-mortem *why* a turn went the way it did, not just *what* it produced (#102).
 *
 * The digest is deliberately **block-level, not per-token**: whole thinking
 * block(s) (assembled verbatim from their token deltas) interleaved with the
 * tool-uses the turn made, each carrying its **action detail** — the tool's input
 * (the actual query/command) and a *trimmed* slice of its result, so the search is
 * visible without bloating the log. Per-token deltas are never persisted.
 *
 * Pure of I/O — fed the `claude` NDJSON lines and unit-tested directly, the way
 * `parseStreamEvent`/`createStreamReader` are — so the assembly is exercised
 * against captured stream lines without ever spawning `claude`.
 */

/** Channel message type carrying a {@link ReasoningDigest} payload (#110). */
export const REASONING_DIGEST = 'reasoning-digest';

/**
 * One step of a turn's reasoning, in the order it happened:
 *  - `thinking` — a complete thinking block, assembled verbatim from its token
 *    deltas (never one entry per delta).
 *  - `tool` — a tool the turn invoked, with its `input` (the actual query/command,
 *    persisted untrimmed) and, when the tool returned before the turn ended, a
 *    `result` slice (trimmed when large; `truncated` marks that it was cut).
 */
export type DigestEntry =
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly name: string;
      readonly input: unknown;
      readonly result?: string;
      readonly truncated?: boolean;
    };

/** A turn's assembled, block-level reasoning trail (#110). */
export interface ReasoningDigest {
  readonly entries: readonly DigestEntry[];
}

/**
 * Max characters of a tool result retained in the digest before trimming. Tool
 * *inputs* (a command/query) are small and kept whole; tool *results* are the
 * large ones (a file read, a long grep), so only they are capped — head+tail so a
 * post-mortem sees both how the output began and how it ended.
 */
export const MAX_TOOL_RESULT_CHARS = 2000;

/** Trim a large tool result to head+tail with an elision marker; small ones pass through. */
export function trimToolResult(
  text: string,
  max = MAX_TOOL_RESULT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n…[${omitted} chars trimmed]…\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** A reasoning-block whose token deltas are still accumulating in the open message. */
type OpenBlock =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; json: string };

/** A tool entry whose result can be filled in later, once the tool returns. */
type MutableEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; result?: string; truncated?: boolean };

/** Accumulates a turn's NDJSON stream into a {@link ReasoningDigest}. */
export interface ReasoningDigestAssembler {
  /** Feed one raw NDJSON line from the `claude` stream (blank/unparseable lines are ignored). */
  feed(line: string): void;
  /** The digest assembled so far. Call once the run's stream is complete. */
  build(): ReasoningDigest;
}

/** Pull the text out of a `tool_result` block's content (a string, or text parts). */
function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Create a {@link ReasoningDigestAssembler}.
 *
 * It tracks the assistant message's open content blocks by index — `message_start`
 * resets that map (indices restart per message), each `content_block_start` opens a
 * thinking/tool block, the deltas accumulate into it, and `content_block_stop`
 * finalizes it into an ordered entry. A tool's result arrives later, as a separate
 * `user`/`tool_result` line keyed by `tool_use_id`; tool entries are kept in a
 * by-id map (which is *not* cleared per message) so the result attaches to the
 * right one. Text deltas are ignored — the answer text is the `result`, persisted
 * as before; the digest is the reasoning behind it.
 */
export function createReasoningDigestAssembler(): ReasoningDigestAssembler {
  const entries: MutableEntry[] = [];
  // Tool entries by `tool_use_id`, so a later `tool_result` line attaches its
  // output. Holds the same object references that live in `entries`.
  const toolsById = new Map<string, Extract<MutableEntry, { kind: 'tool' }>>();
  // Open blocks of the assistant message currently streaming, keyed by index.
  let open = new Map<number, OpenBlock>();

  const finalize = (block: OpenBlock): void => {
    if (block.kind === 'thinking') {
      // Drop an empty thinking block (some builds stream a redacted block as empty).
      if (block.text.trim()) entries.push({ kind: 'thinking', text: block.text });
      return;
    }
    let input: unknown = {};
    if (block.json.trim()) {
      try {
        input = JSON.parse(block.json);
      } catch {
        input = block.json; // keep the raw partial JSON if it never parsed
      }
    }
    const entry: Extract<MutableEntry, { kind: 'tool' }> = { kind: 'tool', name: block.name, input };
    entries.push(entry);
    if (block.id) toolsById.set(block.id, entry);
  };

  const handleStreamEvent = (event: {
    type?: unknown;
    index?: unknown;
    delta?: unknown;
    content_block?: unknown;
  }): void => {
    if (event.type === 'message_start') {
      open = new Map(); // a new assistant message restarts block indices
      return;
    }
    if (event.type === 'content_block_start') {
      const { index } = event;
      const block = event.content_block as { type?: unknown; id?: unknown; name?: unknown } | null;
      if (typeof index !== 'number' || !block) return;
      if (block.type === 'thinking') {
        open.set(index, { kind: 'thinking', text: '' });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        open.set(index, {
          kind: 'tool',
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name,
          json: '',
        });
      }
      return;
    }
    if (event.type === 'content_block_delta') {
      const { index } = event;
      if (typeof index !== 'number') return;
      const block = open.get(index);
      if (!block) return;
      const delta = event.delta as { type?: unknown; thinking?: unknown; partial_json?: unknown } | null;
      if (!delta) return;
      if (block.kind === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.text += delta.thinking;
      } else if (
        block.kind === 'tool' &&
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        block.json += delta.partial_json;
      }
      return;
    }
    if (event.type === 'content_block_stop') {
      const { index } = event;
      if (typeof index !== 'number') return;
      const block = open.get(index);
      if (!block) return;
      open.delete(index);
      finalize(block);
    }
  };

  const handleToolResults = (message: { content?: unknown }): void => {
    if (!Array.isArray(message.content)) return;
    for (const raw of message.content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const entry = toolsById.get(block.tool_use_id);
      if (!entry) continue;
      const { text, truncated } = trimToolResult(extractResultText(block.content));
      entry.result = text;
      if (truncated) entry.truncated = true;
    }
  };

  return {
    feed(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof obj !== 'object' || obj === null) return;
      const record = obj as { type?: unknown; event?: unknown; message?: unknown };
      if (record.type === 'stream_event' && typeof record.event === 'object' && record.event !== null) {
        handleStreamEvent(record.event as Record<string, unknown>);
      } else if (record.type === 'user' && typeof record.message === 'object' && record.message !== null) {
        handleToolResults(record.message as { content?: unknown });
      }
    },
    build() {
      // Copy each entry so the returned digest can't be mutated by a later feed.
      return { entries: entries.map((entry) => ({ ...entry })) };
    },
  };
}
