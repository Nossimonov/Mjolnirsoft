import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createClaudeCodeResponder,
  resolveClaudeBin,
  buildClaudeArgs,
  senderAttribution,
  interpretClaudeResult,
  extractUsage,
  addUsage,
  weightedUsage,
  claudeSessionIdFor,
  permissionPolicyFor,
  parseStreamEvent,
  createStreamReader,
  DEFAULT_EXECUTOR_ROLE,
  EXECUTOR_PERMISSIONS,
  type ViewEvent,
} from './claude-code-responder.ts';
import { isAuthError } from './auth-error.ts';
import { SHARED_CORE, EXECUTOR_INSERT } from '../core/agent-instructions.ts';
import type { ReasoningDigest } from './reasoning-digest.ts';

const task = { from: 'orchestrator', role: 'planner', type: 'text', payload: 'write a haiku to haiku.md' } as const;

describe('claudeSessionIdFor (#126)', () => {
  it('is deterministic — the same session name always yields the same id (so a reload resumes it)', () => {
    expect(claudeSessionIdFor('coordinate-feature-x')).toBe(claudeSessionIdFor('coordinate-feature-x'));
  });

  it('distinguishes different session names', () => {
    expect(claudeSessionIdFor('a')).not.toBe(claudeSessionIdFor('b'));
  });

  it('is a well-formed RFC-4122 UUID (claude requires one for --session-id)', () => {
    expect(claudeSessionIdFor('any-session')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('interpretClaudeResult', () => {
  it('returns the result on a successful run', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'wrote haiku.md' });
    expect(interpretClaudeResult(stdout, '', 0)).toBe('wrote haiku.md');
  });

  it('surfaces the JSON `result` on failure — where claude puts the error, not stderr (#90)', () => {
    // The actual shape `claude -p --output-format json` emits when logged out:
    // exit 1, empty stderr, the error in stdout's `result` with is_error:true.
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
    let message = '';
    try {
      interpretClaudeResult(stdout, '', 1);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('Not logged in · Please run /login');
    // The whole point: the surfaced failure now carries the auth signal, so the
    // re-login card (#90) classifies it instead of seeing a blank stderr.
    expect(isAuthError(message)).toBe(true);
  });

  it('treats is_error:true as a failure even on a zero exit', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'OAuth token has expired' });
    expect(() => interpretClaudeResult(stdout, '', 0)).toThrow(/OAuth token has expired/);
  });

  it('falls back to a code message when neither stdout nor stderr carries detail', () => {
    expect(() => interpretClaudeResult('', '', 1)).toThrow(/exit 1/);
  });

  it('reports unparseable output on an otherwise-clean exit', () => {
    expect(() => interpretClaudeResult('not json', '', 0)).toThrow(/could not parse/);
  });
});

describe('extractUsage / addUsage (#116)', () => {
  const resultLine = (usage: unknown) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage });

  it('reads token usage from the result line', () => {
    const u = extractUsage(
      resultLine({ input_tokens: 3, output_tokens: 3827, cache_read_input_tokens: 18286, cache_creation_input_tokens: 7837 }),
    );
    expect(u).toEqual({ inputTokens: 3, outputTokens: 3827, cacheReadTokens: 18286, cacheCreationTokens: 7837 });
  });

  it('treats missing token fields as 0', () => {
    expect(extractUsage(resultLine({ output_tokens: 10 }))).toEqual({
      inputTokens: 0,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('returns undefined with no usage or unparseable input (an unmeasured turn isn\'t counted)', () => {
    expect(extractUsage(JSON.stringify({ type: 'result', result: 'ok' }))).toBeUndefined();
    expect(extractUsage('not json')).toBeUndefined();
  });

  it('sums tallies field-wise (per-session accumulation + spawner roll-up)', () => {
    expect(
      addUsage(
        { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
        { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
      ),
    ).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 });
  });
});

describe('weightedUsage (#133)', () => {
  it('computes the cost-equivalent weight: input×1 + output×5 + cacheRead×0.1 + cacheCreation×1.25', () => {
    // input 100×1=100, output 200×5=1000, cacheRead 50×0.1=5, cacheCreation 40×1.25=50 → 1155
    expect(
      weightedUsage({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 40 }),
    ).toBe(1155);
  });

  it('returns 0 for a zero tally', () => {
    expect(weightedUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });

  it('weights output tokens at 5× — a 90% cache-read session looks much lighter than its raw total', () => {
    // 512K raw: 10K input + 2K output + 490K cacheRead + 10K cacheCreation
    // weighted: 10000×1 + 2000×5 + 490000×0.1 + 10000×1.25 = 10000+10000+49000+12500 = 81500
    expect(
      weightedUsage({ inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 490_000, cacheCreationTokens: 10_000 }),
    ).toBe(81_500);
  });
});

describe('parseStreamEvent (NDJSON → live view event, #109)', () => {
  // The exact line shapes `claude --output-format stream-json --verbose
  // --include-partial-messages` emits, captured live (#109).
  const sid = '15c3f03f';
  const streamEvent = (event: unknown) =>
    JSON.stringify({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: 'u' });

  it('reads a text_delta as streaming answer text', () => {
    const line = streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi there fri' } });
    expect(parseStreamEvent(line)).toEqual({ kind: 'text', text: 'Hi there fri' });
  });

  it('reads a thinking_delta as streaming reasoning', () => {
    const line = streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '91 = 7 × 13' } });
    expect(parseStreamEvent(line)).toEqual({ kind: 'thinking', text: '91 = 7 × 13' });
  });

  it('reads a tool_use content_block_start as a tool-use by name', () => {
    const line = streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } });
    expect(parseStreamEvent(line)).toEqual({ kind: 'tool-use', name: 'Bash' });
  });

  it('returns the terminal result line as a raw marker for interpretClaudeResult', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hi there friend.' });
    expect(parseStreamEvent(line)).toEqual({ kind: 'result', raw: line });
    // The raw it carries round-trips through interpretClaudeResult unchanged.
    const parsed = parseStreamEvent(line);
    expect(parsed?.kind === 'result' && interpretClaudeResult(parsed.raw, '', 0)).toBe('Hi there friend.');
  });

  it('ignores lifecycle/bookkeeping lines the live view does not render', () => {
    const ignored = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
      // The periodic `assistant` snapshot restates the whole message — streaming it
      // would double-render against the token deltas, so it must be skipped.
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there friend.' }] } }),
      streamEvent({ type: 'message_start', message: { id: 'msg_01' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command": "echo' } }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      streamEvent({ type: 'message_stop' }),
    ];
    for (const line of ignored) expect(parseStreamEvent(line)).toBeNull();
  });

  it('returns null for blank and unparseable lines (chunk boundaries, banners)', () => {
    expect(parseStreamEvent('')).toBeNull();
    expect(parseStreamEvent('   ')).toBeNull();
    expect(parseStreamEvent('not json')).toBeNull();
    expect(parseStreamEvent('42')).toBeNull();
  });
});

describe('createStreamReader (NDJSON line-buffering, #109)', () => {
  const textLine = (t: string) =>
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
  const resultLine = (r: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: r });

  function collect(): { reader: ReturnType<typeof createStreamReader>; events: ViewEvent[]; results: string[] } {
    const events: ViewEvent[] = [];
    const results: string[] = [];
    const reader = createStreamReader({ onEvent: (e) => events.push(e), onResult: (raw) => results.push(raw) });
    return { reader, events, results };
  }

  it('emits a parsed event only once its line is complete (chunk split mid-line)', () => {
    const { reader, events } = collect();
    const line = textLine('hello');
    const cut = line.length - 4;
    reader.feed(line.slice(0, cut)); // first chunk ends mid-line — nothing parses yet
    expect(events).toEqual([]);
    reader.feed(line.slice(cut) + '\n'); // rest arrives, line completes
    expect(events).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('parses several newline-delimited lines from a single chunk, in order', () => {
    const { reader, events } = collect();
    reader.feed(`${textLine('a')}\n${textLine('b')}\n${textLine('c')}\n`);
    expect(events).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
      { kind: 'text', text: 'c' },
    ]);
  });

  it('captures a final result line that arrives without a trailing newline via flush()', () => {
    const { reader, events, results } = collect();
    reader.feed(`${textLine('done')}\n`);
    reader.feed(resultLine('done')); // no trailing newline, as the CLI often emits it
    expect(results).toEqual([]); // not parsed until flushed
    reader.flush();
    expect(results).toEqual([resultLine('done')]);
    expect(events).toEqual([{ kind: 'text', text: 'done' }]);
  });

  it('tolerates CRLF line endings and blank lines', () => {
    const { reader, events } = collect();
    reader.feed(`${textLine('x')}\r\n\r\n${textLine('y')}\r\n`);
    expect(events).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'text', text: 'y' },
    ]);
  });
});

describe('DEFAULT_EXECUTOR_ROLE (executor instructions)', () => {
  it('composes the shared model, the executor insert, and operational guidance (#71)', () => {
    expect(DEFAULT_EXECUTOR_ROLE).toContain(SHARED_CORE);
    expect(DEFAULT_EXECUTOR_ROLE).toContain(EXECUTOR_INSERT);
  });

  it('carries the design-integrity classification and escalate-when-unsure bias (#71)', () => {
    expect(SHARED_CORE).toContain('route it up; never invent it');
    expect(SHARED_CORE).toContain('no agent self-approves');
    expect(SHARED_CORE).toContain('treat it as the more-escalated kind');
  });

  it('preserves the executor operational guidance', () => {
    expect(DEFAULT_EXECUTOR_ROLE).toContain('Read widely, write narrowly');
    expect(DEFAULT_EXECUTOR_ROLE).toContain('Commit your work to your branch before handing off');
  });
});

describe('createClaudeCodeResponder', () => {
  it('runs Claude Code with the task and the default executor-role prompt, replying with its result', async () => {
    const run = vi.fn().mockResolvedValue('Created haiku.md with a haiku.');
    const respond = createClaudeCodeResponder({ workdir: '/tmp/executor-1', run });

    const reply = await respond(task);

    expect(reply).toEqual({ type: 'result', payload: 'Created haiku.md with a haiku.' });
    expect(run).toHaveBeenCalledWith(
      '[Message from architect — authoritative (id: orchestrator)]\n\nwrite a haiku to haiku.md',
      expect.objectContaining({ cwd: '/tmp/executor-1', appendSystemPrompt: DEFAULT_EXECUTOR_ROLE, resume: false }),
    );
  });

  it('prefixes the prompt with the sender attribution so the agent knows who it is hearing from (#86)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });

    // From the authoritative human (planner role) vs. a peer agent (executor role).
    await respond(task);
    await respond({ from: 'executor-2', role: 'executor', type: 'text', payload: 'please review' });

    expect(run.mock.calls[0][0]).toBe(
      '[Message from architect — authoritative (id: orchestrator)]\n\nwrite a haiku to haiku.md',
    );
    expect(run.mock.calls[1][0]).toBe('[Message from agent (id: executor-2)]\n\nplease review');
  });

  it('carries a multi-line payload through to the executor with its newlines intact (#95 regression guard)', async () => {
    // The #95 fix is display-only (the VS Code view renders newlines as <br>); the
    // transported payload must keep every newline so the executor reads the message
    // as composed, not collapsed to one line.
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    await respond({ from: 'orchestrator', role: 'planner', type: 'text', payload: 'line one\nline two\n\npara two' });
    expect(run.mock.calls[0][0]).toContain('line one\nline two\n\npara two');
  });

  it('lets the caller override the appended executor-role prompt', async () => {
    const run = vi.fn().mockResolvedValue('done');
    const respond = createClaudeCodeResponder({ workdir: '/w', appendSystemPrompt: 'on branch X', run });
    await respond(task);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/w', appendSystemPrompt: 'on branch X' }),
    );
  });

  it('pins a Claude session: creates it on the first turn, resumes it on the next', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });
    await respond(task);
    await respond(task);
    expect(run.mock.calls[0][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: false });
    expect(run.mock.calls[1][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true });
  });

  it('resumes from the first turn when re-attaching an interrupted session (#126)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', resume: true, run });
    await respond(task);
    await respond(task);
    // A reload left this conversation behind, so even the *first* turn resumes it
    // rather than colliding on create.
    expect(run.mock.calls[0][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true });
    expect(run.mock.calls[1][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true });
  });

  it('falls back to creating fresh when there is no conversation to resume (#126)', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude failed (exit 1): No conversation found with session ID: fixed-uuid'))
      .mockResolvedValue('ok'); // the fallback create, and every turn after, succeed
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', resume: true, run });

    // The resume finds nothing (old/pre-deterministic session), so the turn doesn't
    // dead-end — it retries as a create on the same id and succeeds.
    await expect(respond(task)).resolves.toBeDefined();
    expect(run.mock.calls[0][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true }); // tried to resume
    expect(run.mock.calls[1][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: false }); // fell back to create
    // And the next turn resumes the now-created conversation.
    await respond(task);
    expect(run.mock.calls[2][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true });
  });

  it('keeps the same session id after a non-retryable first-turn failure (no rotation) (#90/#141)', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude failed (exit 1): Not logged in · Please run /login'))
      .mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });

    await expect(respond(task)).rejects.toThrow(); // first turn fails (logged out) — surfaced for the #90 re-login card
    await respond(task); // retry, after the user logs in

    // The id is never rotated — a collision on retry is handled by resuming, not by
    // abandoning the conversation for a fresh id (see the next test).
    expect(run.mock.calls[1][1].sessionId).toBe('fixed-uuid');
    expect(run.mock.calls[0][1].sessionId).toBe('fixed-uuid');
  });

  it('rides out a transient overload (529) within the turn instead of failing it (#141)', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude failed (exit 1): API Error: 529 Overloaded. server-side'))
      .mockRejectedValueOnce(new Error('claude failed (exit 1): API Error: 529 Overloaded. server-side'))
      .mockResolvedValue('done');
    const respond = createClaudeCodeResponder({
      workdir: '/w',
      claudeSessionId: 'fixed-uuid',
      run,
      sleep: () => Promise.resolve(), // no real backoff in the test
    });

    // The turn doesn't dead-end on the overload — it retries and completes the task.
    await expect(respond(task)).resolves.toBeDefined();
    expect(run).toHaveBeenCalledTimes(3);
    // Same session id throughout (never rotated); after the create attempt it switches
    // to resume, so a re-create can't collide with the id claude may have registered.
    expect(run.mock.calls.map((c) => c[1].sessionId)).toEqual(['fixed-uuid', 'fixed-uuid', 'fixed-uuid']);
    expect(run.mock.calls[0][1].resume).toBe(false);
    expect(run.mock.calls[1][1].resume).toBe(true);
  });

  it('resumes an existing session when a create collides with an already-registered id (#90/#141)', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude failed (exit 1): Session ID fixed-uuid is already in use'))
      .mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });

    await expect(respond(task)).resolves.toBeDefined();
    expect(run.mock.calls[0][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: false }); // tried to create
    expect(run.mock.calls[1][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true }); // …collided, so resumed it
  });

  it('keeps the session id after an established session, resuming on a later failure (#90)', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('ok') // first turn establishes the session
      .mockRejectedValueOnce(new Error('claude failed (exit 1): transient'))
      .mockResolvedValueOnce('ok'); // a later retry
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });

    await respond(task);
    await expect(respond(task)).rejects.toThrow();
    await respond(task);

    // Once established, the id is kept and later turns resume — context preserved.
    const ids = run.mock.calls.map((c) => c[1].sessionId);
    expect(ids).toEqual(['fixed-uuid', 'fixed-uuid', 'fixed-uuid']);
    expect(run.mock.calls[2][1].resume).toBe(true);
  });

  it('forwards each run\'s live reasoning snapshots to the onReasoningChange seam, ephemerally (#109/#110)', async () => {
    const snapshots: ReasoningDigest[] = [];
    // The injected run plays the role of the streaming CLI: it pushes block-level
    // digest snapshots through the live seam, then returns the final result (the
    // only thing that reaches the channel). The seam must receive each, untouched.
    const run = vi.fn(async (_prompt: string, options: { onReasoningChange?: (d: ReasoningDigest) => void }) => {
      options.onReasoningChange?.({ entries: [{ kind: 'thinking', text: 'is 91 prime?' }] });
      options.onReasoningChange?.({
        entries: [
          { kind: 'thinking', text: 'is 91 prime?' },
          { kind: 'tool', name: 'Bash', input: { command: 'factor 91' } },
        ],
      });
      return 'No, 7 × 13.';
    });
    const respond = createClaudeCodeResponder({ workdir: '/w', run, onReasoningChange: (d) => snapshots.push(d) });

    const reply = await respond(task);

    expect(snapshots).toEqual([
      { entries: [{ kind: 'thinking', text: 'is 91 prime?' }] },
      {
        entries: [
          { kind: 'thinking', text: 'is 91 prime?' },
          { kind: 'tool', name: 'Bash', input: { command: 'factor 91' } },
        ],
      },
    ]);
    // The reply is still just the final result text — streaming changed nothing here.
    expect(reply).toEqual({ type: 'result', payload: 'No, 7 × 13.' });
  });

  it('persists the assembled reasoning digest as its own message, before the result (#110)', async () => {
    // The injected run plays the streaming CLI: it hands back a block-level digest
    // through the onDigest seam, then returns the final result text.
    const digest = {
      entries: [
        { kind: 'thinking', text: 'is 91 prime?' },
        { kind: 'tool', name: 'Bash', input: { command: 'factor 91' }, result: '91: 7 13\n' },
      ],
    } as const;
    const run = vi.fn(async (_prompt: string, options: { onDigest?: (d: ReasoningDigest) => void }) => {
      options.onDigest?.(digest);
      return 'No, 7 × 13.';
    });
    const respond = createClaudeCodeResponder({ workdir: '/w', run });

    const reply = await respond(task);

    // Two messages, in order: the durable digest (distinct type) then the result.
    expect(reply).toEqual([
      { type: 'reasoning-digest', payload: digest },
      { type: 'result', payload: 'No, 7 × 13.' },
    ]);
  });

  it('omits the digest message when the turn assembled no reasoning (no log noise) (#110)', async () => {
    // An empty digest (no thinking, no tools) must not post a message — the reply
    // stays the bare result object, exactly as a non-streaming run.
    const run = vi.fn(async (_prompt: string, options: { onDigest?: (d: ReasoningDigest) => void }) => {
      options.onDigest?.({ entries: [] });
      return 'done';
    });
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    expect(await respond(task)).toEqual({ type: 'result', payload: 'done' });
  });

  it('returns undefined when Claude Code produces no result', async () => {
    const respond = createClaudeCodeResponder({ workdir: '/tmp/executor-1', run: async () => '   ' });
    expect(await respond(task)).toBeUndefined();
  });

  it('drops the digest on a resultless turn — it rides with a result, never alone (#110)', async () => {
    // A lone digest message wouldn't settle the turn's "working" indicator (only
    // the result does, #100), so a resultless turn replies with nothing — as before.
    const run = vi.fn(async (_prompt: string, options: { onDigest?: (d: ReasoningDigest) => void }) => {
      options.onDigest?.({ entries: [{ kind: 'thinking', text: 'hm' }] });
      return '   '; // trims to empty
    });
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    expect(await respond(task)).toBeUndefined();
  });

  // Filtering infrastructure (interaction/delegation/usage) out of an agent's turns
  // is no longer the responder's job — the agent runtime's allowlist does it upstream
  // (`deliversToAgent`, see executor-runtime.test.ts). The responder now assumes it
  // only ever receives conversation, so it has no side-channel denylist to test (#116).

  it('passes the permission-prompt tool and MCP config through to the run (#66)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({
      workdir: '/w',
      permissionPromptTool: 'mcp__perm__approve',
      mcpConfigPath: '/cfg.json',
      run,
    });
    await respond(task);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ permissionPromptTool: 'mcp__perm__approve', mcpConfigPath: '/cfg.json' }),
    );
  });
});

describe('senderAttribution', () => {
  it('marks the planner (human/architect) as the authoritative sender (#86)', () => {
    expect(senderAttribution({ from: 'orchestrator', role: 'planner' })).toBe(
      '[Message from architect — authoritative (id: orchestrator)]',
    );
  });

  it('labels an executor sender as a (non-authoritative) agent, distinct from the architect (#86)', () => {
    const attribution = senderAttribution({ from: 'executor-2', role: 'executor' });
    expect(attribution).toBe('[Message from agent (id: executor-2)]');
    expect(attribution).not.toContain('authoritative');
  });

  it('labels an evaluator delegate\'s report as a (non-authoritative) agent too (#93)', () => {
    // A delegate's bridged finding carries its `evaluator` role; it must read as a
    // non-authoritative agent, never able to borrow the architect's authority.
    const attribution = senderAttribution({ from: 'w1-executor-evaluator-1', role: 'evaluator' });
    expect(attribution).toBe('[Message from agent (id: w1-executor-evaluator-1)]');
    expect(attribution).not.toContain('authoritative');
  });

  it('distinguishes an orchestrator as the (non-authoritative) delegating supervisor (#114)', () => {
    // An orchestrator addressing its executor delegate is the task-giver, so it
    // reads distinctly from a peer/subordinate agent — but it is *not* authoritative
    // (only the architect is), so an executor still routes decisions past it.
    const attribution = senderAttribution({ from: 'orch-executor', role: 'orchestrator' });
    expect(attribution).toBe('[Message from orchestrator — delegating (id: orch-executor)]');
    expect(attribution).not.toContain('authoritative');
  });
});

describe('buildClaudeArgs', () => {
  it('streams as NDJSON with token-level partial messages, omitting --append-system-prompt with no role (#109)', () => {
    const args = buildClaudeArgs('do it');
    expect(args).toEqual([
      '-p',
      'do it',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--settings',
      EXECUTOR_PERMISSIONS,
    ]);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('does NOT pass --bare — it would suppress CLAUDE.md but also break subscription OAuth (#121)', () => {
    // --bare skips OAuth/keychain reads, so it breaks the subscription login.
    // CLAUDE.md exclusion must come from a mechanism that leaves auth intact.
    expect(buildClaudeArgs('go', { mcpConfigPath: '/cfg.json' })).not.toContain('--bare');
  });

  it('passes --model per role when set, and inherits the default when omitted (#119)', () => {
    const args = buildClaudeArgs('go', { model: 'sonnet' });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(buildClaudeArgs('go')).not.toContain('--model'); // omitted → user's default model
  });

  it('applies the executor permission policy — commands allowed, foot-guns denied', () => {
    const policy = JSON.parse(EXECUTOR_PERMISSIONS) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(policy.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'Edit(./**)', 'Read']));
    expect(policy.permissions.deny).toEqual(expect.arrayContaining(['Bash(rm -rf *)', 'Bash(git push *)']));
    // The native sub-agent tool is denied (a bare deny strips it) so a spawned agent
    // can't spin up its own ad-hoc sub-agents — our `mcp__delegate__*` is the delegation path (#131).
    expect(policy.permissions.deny).toContain('Agent');
    expect(policy.permissions.allow).toEqual(expect.arrayContaining(['mcp__delegate__spawn', 'mcp__delegate__send']));
  });

  it('excludes every CLAUDE.md via --settings so a spawned agent loads only its role layer (#121)', () => {
    // claudeMdExcludes rides --settings (not --bare), so it drops the project's
    // architect-grade CLAUDE.md without touching OAuth auth.
    const policy = JSON.parse(EXECUTOR_PERMISSIONS) as { claudeMdExcludes: string[] };
    expect(policy.claudeMdExcludes).toEqual(expect.arrayContaining(['**/CLAUDE.md', '**/CLAUDE.local.md']));
  });

  it('disables built-in auto-memory so a spawned agent does not write notes that orphan with its worktree (#132)', () => {
    const policy = JSON.parse(EXECUTOR_PERMISSIONS) as { autoMemoryEnabled: boolean };
    expect(policy.autoMemoryEnabled).toBe(false);
  });

  it('lets the orchestrator git push (to open PRs) but not force-push; executors keep the no-push base (#137)', () => {
    const deny = (role: string) => (JSON.parse(permissionPolicyFor(role)) as { permissions: { deny: string[] } }).permissions.deny;
    // Executor/evaluator/investigator: the base policy — blanket git push denied (they hand off, never push).
    expect(permissionPolicyFor('executor')).toBe(EXECUTOR_PERMISSIONS);
    expect(permissionPolicyFor('evaluator')).toBe(EXECUTOR_PERMISSIONS);
    expect(permissionPolicyFor('investigator')).toBe(EXECUTOR_PERMISSIONS);
    expect(deny('executor')).toContain('Bash(git push *)');
    // Orchestrator: normal push allowed (the blanket deny lifted), force-push still denied.
    expect(deny('orchestrator')).not.toContain('Bash(git push *)');
    expect(deny('orchestrator')).toEqual(expect.arrayContaining(['Bash(git push --force *)', 'Bash(git push -f *)']));
    // It keeps the rest of the base floor (Agent #131, foot-guns).
    expect(deny('orchestrator')).toEqual(expect.arrayContaining(['Agent', 'Bash(rm -rf *)', 'Bash(git reset --hard *)']));
  });

  it('always spawns with the exact base policy — learned "Always" rules are not merged here (#70)', () => {
    // #70's remembering is consumed in the permission MCP server's approve, not
    // in --settings (a learned allow rule doesn't reach out-of-cwd writes), so the
    // spawn policy is unconditionally the base EXECUTOR_PERMISSIONS.
    expect(buildClaudeArgs('go')[buildClaudeArgs('go').indexOf('--settings') + 1]).toBe(EXECUTOR_PERMISSIONS);
  });

  it('appends --append-system-prompt with the role text when given', () => {
    const args = buildClaudeArgs('do it', { appendSystemPrompt: 'be an executor' });
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'be an executor']);
  });

  it('pins a new session with --session-id, and resumes an existing one with --resume', () => {
    expect(buildClaudeArgs('go', { sessionId: 'sid' }).slice(-2)).toEqual(['--session-id', 'sid']);
    expect(buildClaudeArgs('go', { sessionId: 'sid', resume: true }).slice(-2)).toEqual(['--resume', 'sid']);
  });

  it('wires the permission-prompt tool and its MCP config when given (#66)', () => {
    const args = buildClaudeArgs('go', { permissionPromptTool: 'mcp__perm__approve', mcpConfigPath: '/cfg.json' });
    const tool = args.indexOf('--permission-prompt-tool');
    expect(tool).toBeGreaterThan(-1);
    expect(args[tool + 1]).toBe('mcp__perm__approve');
    expect(args.slice(-2)).toEqual(['--mcp-config', '/cfg.json']);
  });

  it('omits the permission-prompt flags when not given', () => {
    const args = buildClaudeArgs('go');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(args).not.toContain('--mcp-config');
  });
});

describe('resolveClaudeBin', () => {
  const original = process.env.CLAUDE_BIN;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = original;
  });

  it('prefers CLAUDE_BIN when set, read at call time', () => {
    process.env.CLAUDE_BIN = 'C:\\tools\\claude.exe';
    expect(resolveClaudeBin()).toBe('C:\\tools\\claude.exe');
  });

  it('falls back to a PATH-resolved command when CLAUDE_BIN is unset', () => {
    delete process.env.CLAUDE_BIN;
    expect(resolveClaudeBin()).toBe(process.platform === 'win32' ? 'claude.exe' : 'claude');
  });
});
