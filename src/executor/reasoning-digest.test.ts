import { describe, it, expect } from 'vitest';
import {
  createReasoningDigestAssembler,
  trimToolResult,
  MAX_TOOL_RESULT_CHARS,
  type DigestEntry,
} from './reasoning-digest.ts';

// The exact NDJSON line shapes `claude --output-format stream-json --verbose
// --include-partial-messages` emits, mirrored from the #109 captures.
const streamEvent = (event: unknown) =>
  JSON.stringify({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null, uuid: 'u' });
const userToolResult = (toolUseId: string, content: unknown) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });

/** Feed every line through a fresh assembler and return the built entries. */
function digestOf(lines: string[]): readonly DigestEntry[] {
  const assembler = createReasoningDigestAssembler();
  for (const line of lines) assembler.feed(line);
  return assembler.build().entries;
}

describe('trimToolResult', () => {
  it('passes a small result through untouched', () => {
    expect(trimToolResult('short output')).toEqual({ text: 'short output', truncated: false });
  });

  it('trims a large result to head+tail with an elision marker', () => {
    const big = 'A'.repeat(3000);
    const { text, truncated } = trimToolResult(big);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain('chars trimmed');
    expect(text.startsWith('A')).toBe(true); // head retained
    expect(text.endsWith('A')).toBe(true); // tail retained
  });
});

describe('createReasoningDigestAssembler (#110 durable digest)', () => {
  it('assembles a thinking block VERBATIM from its token deltas — one block, not one entry per delta', () => {
    const entries = digestOf([
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Is 91 ' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'prime? ' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'No — 7×13.' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
    ]);
    // Block-level, not per-token: three deltas coalesce into ONE thinking entry,
    // assembled verbatim. This is the "per-token deltas are NOT persisted" AC.
    expect(entries).toEqual([{ kind: 'thinking', text: 'Is 91 prime? No — 7×13.' }]);
  });

  it('captures a tool-use with its input (assembled from input_json_delta) and trimmed result', () => {
    const entries = digestOf([
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' "echo hi"}' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      // The tool returns on a later user line, keyed by tool_use_id.
      userToolResult('toolu_1', 'hi\n'),
    ]);
    expect(entries).toEqual([
      { kind: 'tool', name: 'Bash', input: { command: 'echo hi' }, result: 'hi\n' },
    ]);
  });

  it('attaches a string-or-text-parts tool result and trims a large one', () => {
    const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    const entries = digestOf([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file":"a.ts"}' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      // Result delivered as text parts (the other tool_result content shape).
      userToolResult('toolu_2', [{ type: 'text', text: big }]),
    ]);
    expect(entries).toHaveLength(1);
    const tool = entries[0];
    expect(tool.kind === 'tool' && tool.truncated).toBe(true);
    expect(tool.kind === 'tool' && (tool.result?.length ?? 0)).toBeLessThan(big.length);
  });

  it('interleaves thinking and tools in order, across multiple assistant messages (indices restart)', () => {
    const entries = digestOf([
      // First assistant message: think, then call a tool at index 1.
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check the file' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'Grep', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pattern":"foo"}' } }),
      streamEvent({ type: 'content_block_stop', index: 1 }),
      userToolResult('toolu_a', 'foo found'),
      // Second assistant message: index 0 reused for a *new* block — must not collide.
      streamEvent({ type: 'message_start', message: { id: 'm2' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'now answer' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(entries).toEqual([
      { kind: 'thinking', text: 'check the file' },
      { kind: 'tool', name: 'Grep', input: { pattern: 'foo' }, result: 'foo found' },
      { kind: 'thinking', text: 'now answer' },
    ]);
  });

  it('interleaves thinking, response text, and tools in stream order — a faithful copy of the live trail', () => {
    const entries = digestOf([
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should grep.' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Searching now.' } }),
      streamEvent({ type: 'content_block_stop', index: 1 }),
      streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_x', name: 'Grep', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pattern":"foo"}' } }),
      streamEvent({ type: 'content_block_stop', index: 2 }),
      userToolResult('toolu_x', 'foo found'),
    ]);
    expect(entries).toEqual([
      { kind: 'thinking', text: 'I should grep.' },
      { kind: 'text', text: 'Searching now.' },
      { kind: 'tool', name: 'Grep', input: { pattern: 'foo' }, result: 'foo found' },
    ]);
  });

  it('excludes the final (trailing) text block — it is the answer and renders in the result bubble', () => {
    // A turn whose only content is a text block: that text IS the answer, so the
    // digest is empty (the answer shows in its own bubble, not the reasoning box).
    const entries = digestOf([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer ' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is 42.' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(entries).toEqual([]);
  });

  it('keeps interim text (followed by more work) but drops the trailing text after it', () => {
    const entries = digestOf([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file":"a"}' } }),
      streamEvent({ type: 'content_block_stop', index: 1 }),
      streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found it: 42.' } }),
      streamEvent({ type: 'content_block_stop', index: 2 }),
    ]);
    // The first text is interim (a tool followed) → kept; the last text is the
    // answer (nothing followed) → dropped.
    expect(entries).toEqual([
      { kind: 'text', text: 'Let me check.' },
      { kind: 'tool', name: 'Read', input: { file: 'a' } },
    ]);
  });

  it('drops an empty text block (opened but never filled)', () => {
    const entries = digestOf([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(entries).toEqual([]);
  });

  it('ignores blank, unparseable, and bookkeeping lines without throwing', () => {
    const entries = digestOf([
      '',
      '   ',
      'not json',
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
    ]);
    expect(entries).toEqual([]);
  });

  it('drops an empty (redacted) thinking block', () => {
    const entries = digestOf([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(entries).toEqual([]);
  });

  it('keeps a tool-use with no result yet (the tool had not returned when the turn ended)', () => {
    const entries = digestOf([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_3', name: 'Write', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file":"x"}' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(entries).toEqual([{ kind: 'tool', name: 'Write', input: { file: 'x' } }]);
  });

  it('drives the live view via onChange — block-level snapshots that exclude the held trailing text', () => {
    const snapshots: DigestEntry[][] = [];
    const assembler = createReasoningDigestAssembler({
      onChange: (d) => snapshots.push(d.entries.map((e) => ({ ...e }))),
    });
    const feed = (event: unknown) => assembler.feed(streamEvent(event));
    feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } });
    feed({ type: 'content_block_stop', index: 0 }); // → snapshot [thinking]
    feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } });
    feed({ type: 'content_block_stop', index: 1 }); // → snapshot [thinking, tool]
    assembler.feed(userToolResult('t1', 'data')); // result attaches → snapshot [thinking, tool(+result)]
    feed({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
    feed({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'done: data' } });
    feed({ type: 'content_block_stop', index: 2 }); // final text → held, NO snapshot

    // One snapshot per visible change; the trailing text never appears live.
    expect(snapshots).toEqual([
      [{ kind: 'thinking', text: 'plan' }],
      [{ kind: 'thinking', text: 'plan' }, { kind: 'tool', name: 'Read', input: {} }],
      [{ kind: 'thinking', text: 'plan' }, { kind: 'tool', name: 'Read', input: {}, result: 'data' }],
    ]);
    // build() agrees with the last live snapshot — same data, no swap.
    expect(assembler.build().entries).toEqual(snapshots[snapshots.length - 1]);
  });

  it('does not mutate an already-built digest when fed more lines', () => {
    const assembler = createReasoningDigestAssembler();
    assembler.feed(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    assembler.feed(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first' } }));
    assembler.feed(streamEvent({ type: 'content_block_stop', index: 0 }));
    const snapshot = assembler.build();
    assembler.feed(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    assembler.feed(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'second' } }));
    assembler.feed(streamEvent({ type: 'content_block_stop', index: 0 }));
    expect(snapshot.entries).toEqual([{ kind: 'thinking', text: 'first' }]);
  });
});
