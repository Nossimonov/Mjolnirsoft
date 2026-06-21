import { describe, expect, it } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message, Role } from '../core/channel.ts';
import { senderAttribution } from './claude-code-responder.ts';
import { runExecutor } from './executor-runtime.ts';
import { createDelegationManager, type DelegationDeps } from './delegation.ts';

/** Let queued microtasks/timers run so the stub delegate's async reply delivers. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Wire a spawner on an in-memory channel with an orchestrator watching it, and an
 * in-memory sub-channel per delegate that logs its full traffic — the way a real
 * deployment has the spawner on its session channel and each delegate on its own
 * session log, but synchronous and transport-free.
 */
function wire(createDelegate?: DelegationDeps['createDelegate']) {
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

  const manager = createDelegationManager({
    spawnerId: 'spawner',
    spawnerRole: 'executor',
    spawnerChannel,
    openSubChannel,
    createDelegate,
  });

  return { manager, orchestratorInbox, subChannels, subLogs };
}

describe('createDelegationManager', () => {
  it('spawns a delegate on its own sub-channel with the opening task, returning immediately (AC1)', async () => {
    const { manager, orchestratorInbox, subLogs } = wire();

    const id = manager.spawn('executor', { type: 'text', payload: 'review the diff' });

    // The id is the derived sub-channel id, returned synchronously...
    expect(id).toBe('spawner-executor-1');
    // ...before the delegate has replied (spawn does not await the round-trip).
    expect(orchestratorInbox).toEqual([]);

    await flush();

    // The opening task landed on the delegate's own sub-channel.
    expect(subLogs.get(id)?.[0]).toMatchObject({ from: 'spawner', type: 'text', payload: 'review the diff' });
  });

  it('bridges the delegate\'s reply up onto the spawner\'s channel, attributed as an agent (AC3, reuses #86)', async () => {
    const { manager, orchestratorInbox } = wire();

    manager.spawn('executor', { type: 'text', payload: 'do X' });
    await flush();

    expect(orchestratorInbox).toEqual([
      { from: 'spawner-executor-1', role: 'executor', type: 'ack', payload: 'received: do X' },
    ]);
    // The bridged report carries the delegate's id+role, so #86 attribution marks
    // it a (non-authoritative) agent — never indistinguishable from the architect.
    expect(senderAttribution(orchestratorInbox[0])).toBe('[Message from agent (id: spawner-executor-1)]');
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
    const { manager, orchestratorInbox, subChannels } = wire();

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

  it('gives each delegate its own sub-channel and a distinct attributed report', async () => {
    const { manager, orchestratorInbox } = wire();

    const id1 = manager.spawn('executor', { type: 'text', payload: 'first' });
    const id2 = manager.spawn('executor', { type: 'text', payload: 'second' });
    await flush();

    expect([id1, id2]).toEqual(['spawner-executor-1', 'spawner-executor-2']);
    expect(orchestratorInbox).toEqual([
      { from: 'spawner-executor-1', role: 'executor', type: 'ack', payload: 'received: first' },
      { from: 'spawner-executor-2', role: 'executor', type: 'ack', payload: 'received: second' },
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

    expect(seen).toEqual([{ role: 'executor', id: 'spawner-executor-1' }]);
    expect(orchestratorInbox).toEqual([
      { from: 'spawner-executor-1', role: 'executor', type: 'result', payload: 'handled: go' },
    ]);
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
