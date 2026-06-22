import { describe, expect, it } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message, Role } from '../core/channel.ts';
import { senderAttribution } from './claude-code-responder.ts';
import { runExecutor } from './executor-runtime.ts';
import { createDelegationManager, type DelegationDeps } from './delegation.ts';

/** Let queued microtasks/timers run so the stub delegate's async reply delivers. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A realistic delegate: it reports with a `result` — the conversational type a real
 * agent emits and the only kind that bridges up (#116). The bare `acknowledge`
 * default replies `ack`, which is transport-only and deliberately does *not* bridge,
 * so tests that exercise the bridge use this instead.
 */
const resultDelegate: DelegationDeps['createDelegate'] = (role, id, sub) => ({
  close: runExecutor(sub, id, async (m) => ({ type: 'result', payload: `received: ${m.payload}` }), role).close,
});

/**
 * Wire a spawner on an in-memory channel with an orchestrator watching it, and an
 * in-memory sub-channel per delegate that logs its full traffic — the way a real
 * deployment has the spawner on its session channel and each delegate on its own
 * session log, but synchronous and transport-free.
 *
 * `generateToken` defaults to a per-wire sequential generator so ids are
 * deterministic and predictable across each test (tok00001, tok00002, …).
 */
function wire(createDelegate?: DelegationDeps['createDelegate'], generateToken?: () => string) {
  const spawnerChannel = new InMemoryChannel();
  const orchestratorInbox: Message[] = [];
  spawnerChannel.join('orchestrator', 'planner', (m) => orchestratorInbox.push(m));

  const subChannels = new Map<string, InMemoryChannel>();
  const subLogs = new Map<string, Message[]>();
  const openSubChannel = (id: string) => {
    const sub = new InMemoryChannel();
    const log: Message[] = [];
    // A passive observer captures everything that crosses the sub-channel — the
    // stand-in for the session's persisted log.
    sub.join(`log-${id}`, 'planner', (m) => log.push(m));
    subChannels.set(id, sub);
    subLogs.set(id, log);
    return sub;
  };

  let n = 0;
  const manager = createDelegationManager({
    spawnerId: 'spawner',
    spawnerRole: 'executor',
    spawnerChannel,
    openSubChannel,
    createDelegate,
    generateToken: generateToken ?? (() => `tok${String(++n).padStart(5, '0')}`),
  });

  return { manager, orchestratorInbox, subChannels, subLogs };
}

describe('createDelegationManager', () => {
  it('spawns a delegate on its own sub-channel with the opening task, returning immediately (AC1)', async () => {
    const { manager, orchestratorInbox, subLogs } = wire();

    const id = manager.spawn('executor', { type: 'text', payload: 'review the diff' });

    // The id is the derived sub-channel id, returned synchronously...
    expect(id).toBe('spawner-executor-1-tok00001');
    // ...before the delegate has replied (spawn does not await the round-trip).
    expect(orchestratorInbox).toEqual([]);

    await flush();

    // The opening task landed on the delegate's own sub-channel.
    expect(subLogs.get(id)?.[0]).toMatchObject({ from: 'spawner', type: 'text', payload: 'review the diff' });
  });

  it('bridges the delegate\'s reply up onto the spawner\'s channel, attributed as an agent (AC3, reuses #86)', async () => {
    const { manager, orchestratorInbox } = wire(resultDelegate);

    manager.spawn('executor', { type: 'text', payload: 'do X' });
    await flush();

    expect(orchestratorInbox).toEqual([
      { from: 'spawner-executor-1-tok00001', role: 'executor', type: 'result', payload: 'received: do X' },
    ]);
    // The bridged report carries the delegate's id+role, so #86 attribution marks
    // it a (non-authoritative) agent — never indistinguishable from the architect.
    expect(senderAttribution(orchestratorInbox[0])).toBe('[Message from agent (id: spawner-executor-1-tok00001)]');
  });

  it('keeps the delegate\'s full exchange in its own session log (AC4)', async () => {
    const { manager, subLogs } = wire();

    const id = manager.spawn('executor', { type: 'text', payload: 'task' });
    await flush();

    // Both the opening task and the delegate's reply live on the sub-channel.
    expect(subLogs.get(id)).toEqual([
      { from: 'spawner', role: 'executor', type: 'text', payload: 'task' },
      { from: id, role: 'executor', type: 'ack', payload: 'received: task' },
    ]);
  });

  it('shutdown ends the delegate and releases its bridge (AC2)', async () => {
    const { manager, orchestratorInbox, subChannels } = wire(resultDelegate);

    const id = manager.spawn('executor', { type: 'text', payload: 'task' });
    await flush();
    expect(orchestratorInbox).toHaveLength(1); // the initial report bridged up

    manager.shutdown(id);

    // The delegate is gone (no reply on the sub-channel) and the bridge is
    // released (a would-be delegate message no longer reaches the spawner).
    const sub = subChannels.get(id)!;
    const probeInbox: Message[] = [];
    const probe = sub.join('probe', 'planner', (m) => probeInbox.push(m));
    probe.send({ type: 'text', payload: 'still there?' });
    await flush();

    expect(probeInbox).toEqual([]);
    expect(orchestratorInbox).toHaveLength(1);
  });

  it('is idempotent for an unknown delegate id (AC2)', () => {
    const { manager } = wire();
    expect(() => manager.shutdown('never-spawned')).not.toThrow();
  });

  it('sends a follow-up to a live delegate; it continues on its session and replies again (#111)', async () => {
    const { manager, orchestratorInbox } = wire(resultDelegate);

    const id = manager.spawn('executor', { type: 'text', payload: 'start' });
    await flush();

    // The spawner answers/steers the live delegate; it takes another turn and reports again.
    expect(manager.send(id, { type: 'text', payload: 'how do I run the suite?' })).toBe(true);
    await flush();

    expect(orchestratorInbox).toEqual([
      { from: id, role: 'executor', type: 'result', payload: 'received: start' },
      { from: id, role: 'executor', type: 'result', payload: 'received: how do I run the suite?' },
    ]);
  });

  it('reports a send to an unknown/ended delegate as not delivered (#111)', () => {
    const { manager } = wire(resultDelegate);
    expect(manager.send('never-spawned', { type: 'text', payload: 'hi' })).toBe(false);
  });

  it('gives each delegate its own sub-channel and a distinct attributed report', async () => {
    const { manager, orchestratorInbox } = wire(resultDelegate);

    const id1 = manager.spawn('executor', { type: 'text', payload: 'first' });
    const id2 = manager.spawn('executor', { type: 'text', payload: 'second' });
    await flush();

    expect([id1, id2]).toEqual(['spawner-executor-1-tok00001', 'spawner-executor-2-tok00002']);
    expect(orchestratorInbox).toEqual([
      { from: id1, role: 'executor', type: 'result', payload: 'received: first' },
      { from: id2, role: 'executor', type: 'result', payload: 'received: second' },
    ]);
  });

  it('wires any delegate behind the createDelegate seam, bridging from its report seat (AC5)', async () => {
    // Proves the swap point: a factory wires the delegate on its sub-channel — here
    // a plain responder via runExecutor — and the manager bridges its report up.
    const seen: Array<{ role: Role; id: string }> = [];
    const { manager, orchestratorInbox } = wire((role, id, sub) => {
      seen.push({ role, id });
      const responder = runExecutor(
        sub,
        id,
        async (message) => ({ type: 'result', payload: `handled: ${message.payload}` }),
        role,
      );
      return { close: responder.close };
    });

    manager.spawn('executor', { type: 'text', payload: 'go' });
    await flush();

    expect(seen).toEqual([{ role: 'executor', id: 'spawner-executor-1-tok00001' }]);
    expect(orchestratorInbox).toEqual([
      { from: 'spawner-executor-1-tok00001', role: 'executor', type: 'result', payload: 'handled: go' },
    ]);
  });

  it('generates a distinct id for each spawn — two delegates of the same role never share an id', () => {
    // Each call to generateToken returns a different value, so even the same role
    // spawned twice cannot collide. Uniqueness comes from the token, not the counter.
    const tokens = ['aaaa0001', 'bbbb0002'];
    let call = 0;
    const { manager } = wire(undefined, () => tokens[call++]);

    const id1 = manager.spawn('executor', { type: 'text', payload: 'first' });
    const id2 = manager.spawn('executor', { type: 'text', payload: 'second' });

    expect(id1).not.toBe(id2);
    expect(id1).toContain('aaaa0001');
    expect(id2).toContain('bbbb0002');
  });

  it('stays unique across a manager restart (simulated reload): a fresh counter never reproduces a prior id', () => {
    // A window reload destroys the extension host and creates a new manager, so the
    // in-memory sequence resets to 0. The token is the only uniqueness guarantee.
    const tokens = ['cccc0001', 'dddd0002'];
    let call = 0;
    const generateToken = () => tokens[call++];

    // First session — spawns 'spawner-executor-1-cccc0001'.
    const { manager: m1 } = wire(undefined, generateToken);
    const id1 = m1.spawn('executor', { type: 'text', payload: 'before reload' });

    // Second session (simulated reload) — sequence also starts at 1, but the token differs.
    const { manager: m2 } = wire(undefined, generateToken);
    const id2 = m2.spawn('executor', { type: 'text', payload: 'after reload' });

    expect(id2).not.toBe(id1); // no collision despite sequence reset
    expect(id2).toContain('dddd0002');
  });

  describe('rewire (#128)', () => {
    it('re-establishes the bridge without sending an opening task, and routes follow-ups', async () => {
      // A reload tears the old manager down. The new manager creates a fresh bridge
      // via `rewire` — the delegate is already running and resumes; no opening task.
      const { manager, orchestratorInbox } = wire();
      const sub = new InMemoryChannel();
      const delegateId = 'spawner-executor-1-rewired';
      const agentSeat = `${delegateId}-executor`;

      // Wire up a delegate agent on the sub-channel *before* calling rewire — just
      // as provisionSession wires the real agent before the bridge is re-established.
      const agent = runExecutor(
        sub,
        agentSeat,
        async (m) => ({ type: 'result', payload: `resumed: ${m.payload}` }),
        'executor',
      );

      manager.rewire('executor', delegateId, sub, { reportFrom: agentSeat, close: agent.close });

      // No opening task should have been sent (the delegate is resuming, not starting).
      expect(orchestratorInbox).toEqual([]);

      // Use manager.send to route a follow-up through the re-wired driver seat —
      // exactly how the spawner communicates with a live delegate after spawning.
      manager.send(delegateId, { type: 'text', payload: 'what is the status?' });
      await flush();

      expect(orchestratorInbox).toEqual([
        { from: delegateId, role: 'executor', type: 'result', payload: 'resumed: what is the status?' },
      ]);
    });

    it('is idempotent: re-wiring an already-wired id is a no-op', async () => {
      const { manager, orchestratorInbox } = wire(resultDelegate);

      // First: spawn normally.
      const id = manager.spawn('executor', { type: 'text', payload: 'task' });
      await flush();
      expect(orchestratorInbox).toHaveLength(1);

      // Second: try to rewire the same id — should silently no-op (does not throw
      // or replace the existing bridge with the new sub-channel).
      const sub2 = new InMemoryChannel();
      manager.rewire('executor', id, sub2, { close: () => {} });
      // The original bridge still holds. Sending via manager.send still routes to
      // the original delegate (since the rewire for `id` was ignored).
      manager.send(id, { type: 'text', payload: 'follow-up' });
      await flush();
      expect(orchestratorInbox).toHaveLength(2); // original + follow-up, NOT from sub2
    });

    it('a rewired delegate can be shut down, releasing the bridge', async () => {
      const { manager, orchestratorInbox } = wire();
      const sub = new InMemoryChannel();
      const delegateId = 'spawner-executor-rewired-shutdown';
      const agentSeat = `${delegateId}-executor`;
      const agent = runExecutor(
        sub, agentSeat,
        async (m) => ({ type: 'result', payload: `done: ${m.payload}` }),
        'executor',
      );

      manager.rewire('executor', delegateId, sub, { reportFrom: agentSeat, close: agent.close });

      // Drive a follow-up through the re-wired driver — it bridges up.
      manager.send(delegateId, { type: 'text', payload: 'go' });
      await flush();
      expect(orchestratorInbox).toHaveLength(1);

      // Shutdown releases the bridge: manager.send returns false and no further
      // messages cross up to the spawner's channel.
      manager.shutdown(delegateId);
      expect(manager.send(delegateId, { type: 'text', payload: 'too late' })).toBe(false);
      await flush();
      expect(orchestratorInbox).toHaveLength(1); // no new message
    });
  });

  it('bridges from a distinct report seat when the delegate names one (#114 full-executor shape)', async () => {
    // A full executor delegate runs its agent under `${id}-executor` (alongside its
    // own MCP seats) and names that seat via reportFrom — so the manager bridges the
    // agent's reply, attributed under the clean delegate id, even though the agent
    // joined the sub-channel under a suffixed seat (not `id` itself).
    const { manager, orchestratorInbox, subLogs } = wire((role, id, sub) => {
      const agentSeat = `${id}-executor`;
      const agent = runExecutor(
        sub,
        agentSeat,
        async (message) => ({ type: 'result', payload: `did: ${message.payload}` }),
        role,
      );
      return { reportFrom: agentSeat, close: agent.close };
    });

    const id = manager.spawn('executor', { type: 'text', payload: 'task' });
    await flush();

    // The agent replied under its suffixed seat on the sub-channel...
    expect(subLogs.get(id)).toContainEqual({
      from: `${id}-executor`,
      role: 'executor',
      type: 'result',
      payload: 'did: task',
    });
    // ...and the manager bridged it up under the clean delegate id (not the seat).
    expect(orchestratorInbox).toEqual([
      { from: id, role: 'executor', type: 'result', payload: 'did: task' },
    ]);
  });
});
