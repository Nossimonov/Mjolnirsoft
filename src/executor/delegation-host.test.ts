import { describe, expect, it } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { AgentRole } from '../core/agent-instructions.ts';
import type { Message } from '../core/channel.ts';
import { senderAttribution } from './claude-code-responder.ts';
import { createDelegationBridge } from './delegation-bridge.ts';
import { createDelegationHost } from './delegation-host.ts';
import type { Respond } from './executor-runtime.ts';

/** Let queued microtasks run so the (async) delegate responder's reply delivers. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Wire the full live-delegation path transport-free: the executor's delegation
 * MCP bridge on one seat of the spawner channel, the in-host delegation host on
 * another, an observer standing in for the executor+view (captures the bridged
 * report), and an in-memory sub-channel per delegate that logs its full traffic.
 * A fake `createResponder` replaces the real `claude`, so the seam is proven with
 * no subprocess.
 */
function wire(makeResponder?: (role: AgentRole, id: string) => Respond) {
  const spawnerChannel = new InMemoryChannel();

  // The executor's MCP-server side: posts spawn/shutdown requests over the bridge.
  const mcp = spawnerChannel.join('w1-delegate', 'executor', (m) => bridge.handleMessage(m));
  const bridge = createDelegationBridge(mcp.send);

  // Stand in for the executor + view: capture every message bridged onto the
  // spawner channel (the delegate's report), excluding the control plumbing.
  const reports: Message[] = [];
  spawnerChannel.join('w1-executor-observer', 'executor', (m) => {
    if (m.type !== 'delegation-request' && m.type !== 'delegation-response') reports.push(m);
  });

  const subChannels = new Map<string, InMemoryChannel>();
  const subLogs = new Map<string, Message[]>();
  const openSubChannel = (id: string) => {
    const sub = new InMemoryChannel();
    const log: Message[] = [];
    sub.join(`log-${id}`, 'planner', (m) => log.push(m));
    subChannels.set(id, sub);
    subLogs.set(id, log);
    return sub;
  };

  const seen: Array<{ role: AgentRole; id: string }> = [];
  const createResponder =
    makeResponder ??
    ((role: AgentRole, id: string): Respond => {
      seen.push({ role, id });
      return async (message) => ({ type: 'result', payload: `critique by ${role}: ${String(message.payload)}` });
    });

  const host = createDelegationHost({
    spawnerChannel,
    spawnerId: 'w1-executor',
    hostId: 'w1-delegation-host',
    openSubChannel,
    createResponder,
  });

  return { bridge, host, reports, subChannels, subLogs, seen };
}

describe('createDelegationHost (#93)', () => {
  it('spawns a real-shaped delegate on its own sub-channel and bridges its finding up, attributed (AC1, AC3, AC5)', async () => {
    const { bridge, reports, subLogs, seen } = wire();

    const response = await bridge.spawn('evaluator', 'review the diff under review');
    const id = response.delegateId!;

    // The host derived the delegate id off the spawner and built its responder
    // for the validated agent role.
    expect(id).toBe('w1-executor-evaluator-1');
    expect(seen).toEqual([{ role: 'evaluator', id }]);

    await flush();

    // The opening task landed on the delegate's own sub-channel session log...
    expect(subLogs.get(id)?.[0]).toMatchObject({
      from: 'w1-executor',
      type: 'text',
      payload: 'review the diff under review',
    });
    // ...and the delegate's finding bridged up onto the spawner channel, stamped
    // with the delegate's evaluator role so #86 reads it as a (non-authoritative) agent.
    expect(reports).toEqual([
      { from: id, role: 'evaluator', type: 'result', payload: 'critique by evaluator: review the diff under review' },
    ]);
    expect(senderAttribution(reports[0])).toBe(`[Message from agent (id: ${id})]`);
  });

  it('keeps the delegate\'s full exchange on its sub-channel; only the finding crosses up (AC4)', async () => {
    const { bridge, reports, subLogs } = wire();

    const { delegateId: id } = await bridge.spawn('evaluator', 'task');
    await flush();

    // Both the opening task and the reply live on the sub-channel...
    expect(subLogs.get(id!)).toHaveLength(2);
    // ...but only the single distilled finding crossed up to the spawner.
    expect(reports).toHaveLength(1);
  });

  it('refuses an unknown role with an error and spawns nothing', async () => {
    const { bridge, reports, subChannels } = wire();

    const response = await bridge.spawn('wizard', 'cast a spell');

    expect(response.delegateId).toBeUndefined();
    expect(response.error).toContain('wizard');
    expect(subChannels.size).toBe(0);
    expect(reports).toEqual([]);
  });

  it('shuts a delegate down, releasing its bridge (AC2)', async () => {
    const { bridge, reports, subChannels } = wire();

    const { delegateId: id } = await bridge.spawn('evaluator', 'task');
    await flush();
    expect(reports).toHaveLength(1);

    await bridge.shutdown(id!);

    // The sub-channel is closed: a would-be delegate message no longer bridges up.
    const sub = subChannels.get(id!)!;
    const probe = sub.join('probe', 'planner', () => {});
    probe.send({ type: 'text', payload: 'still there?' });
    await flush();
    expect(reports).toHaveLength(1);
  });

  it('ends every live delegate on host close', async () => {
    const { bridge, host, reports, subChannels } = wire();

    const { delegateId: id } = await bridge.spawn('evaluator', 'task');
    await flush();

    host.close();

    const sub = subChannels.get(id!)!;
    const probe = sub.join('probe', 'planner', () => {});
    probe.send({ type: 'text', payload: 'after close' });
    await flush();
    // No new report after close — the delegate's bridge was released.
    expect(reports).toHaveLength(1);
  });
});
