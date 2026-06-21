import { describe, expect, it } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { AgentRole } from '../core/agent-instructions.ts';
import type { Channel, Message, Role } from '../core/channel.ts';
import { senderAttribution } from './claude-code-responder.ts';
import { createDelegationBridge } from './delegation-bridge.ts';
import { createDelegationHost, type DelegationHostDeps } from './delegation-host.ts';
import { runExecutor, type Respond } from './executor-runtime.ts';
import type { DelegateWiring } from './delegation.ts';

/** Let queued microtasks run so the (async) delegate responder's reply delivers. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface WireOptions {
  /** The spawner's id (default `w1-executor`); the orchestrator test passes its own. */
  readonly spawnerId?: string;
  /** The spawner's role (default `executor`); the orchestrator test passes `orchestrator`. */
  readonly spawnerRole?: Role;
  /** Override the shared-worktree critique responder (the evaluator path). */
  readonly makeResponder?: (role: AgentRole, id: string) => Respond;
  /** Override how a full executor delegate (#114) is provisioned on its sub-channel. */
  readonly provisionExecutorDelegate?: DelegationHostDeps['provisionExecutorDelegate'];
}

/**
 * Wire the full live-delegation path transport-free: the spawner's delegation MCP
 * bridge on one seat of the spawner channel, the in-host delegation host on
 * another, an observer standing in for the spawner agent + view (captures the
 * bridged report), and an in-memory sub-channel per delegate that logs its full
 * traffic. Fakes replace the real `claude` (and the real worktree/MCP wiring of a
 * full executor delegate), so the seam is proven with no subprocess.
 */
function wire(options: WireOptions = {}) {
  const spawnerId = options.spawnerId ?? 'w1-executor';
  const spawnerChannel = new InMemoryChannel();

  // The spawner's MCP-server side: posts spawn/shutdown requests over the bridge.
  const mcp = spawnerChannel.join(`${spawnerId}-delegate`, options.spawnerRole ?? 'executor', (m) =>
    bridge.handleMessage(m),
  );
  const bridge = createDelegationBridge(mcp.send);

  // Stand in for the spawner agent + view: capture every message bridged onto the
  // spawner channel (the delegate's report), excluding the control plumbing.
  const reports: Message[] = [];
  spawnerChannel.join(`${spawnerId}-observer`, options.spawnerRole ?? 'executor', (m) => {
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

  // The evaluator (and any future shared-worktree critique role) path: a fake
  // responder records what was built and echoes a critique.
  const seen: Array<{ role: AgentRole; id: string }> = [];
  const createResponder =
    options.makeResponder ??
    ((role: AgentRole, id: string): Respond => {
      seen.push({ role, id });
      return async (message) => ({ type: 'result', payload: `critique by ${role}: ${String(message.payload)}` });
    });

  // The full executor-delegate (#114) path: a fake stand-in for the extension's
  // real provisioning. It runs a plain responder under the *suffixed* agent seat
  // (`${id}-executor`, as the real wiring does alongside its MCP seats), records
  // the provisioning, and names that seat via reportFrom.
  const provisioned: Array<{ id: string }> = [];
  let closedExecutorDelegates = 0;
  const provisionExecutorDelegate: DelegationHostDeps['provisionExecutorDelegate'] =
    options.provisionExecutorDelegate ??
    ((id: string, sub: Channel): DelegateWiring => {
      provisioned.push({ id });
      const agentSeat = `${id}-executor`;
      const agent = runExecutor(
        sub,
        agentSeat,
        async (message) => ({ type: 'result', payload: `executed: ${String(message.payload)}` }),
        'executor',
      );
      return {
        reportFrom: agentSeat,
        close() {
          closedExecutorDelegates += 1;
          agent.close();
        },
      };
    });

  const host = createDelegationHost({
    spawnerChannel,
    spawnerId,
    spawnerRole: options.spawnerRole,
    hostId: `${spawnerId}-delegation-host`,
    openSubChannel,
    createResponder,
    provisionExecutorDelegate,
  });

  return {
    bridge,
    host,
    reports,
    subChannels,
    subLogs,
    seen,
    provisioned,
    closedExecutorDelegates: () => closedExecutorDelegates,
  };
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

  it('routes a follow-up to a live delegate end-to-end; it replies again (#111)', async () => {
    const { bridge, reports, subLogs } = wire();

    const { delegateId: id } = await bridge.spawn('evaluator', 'review the diff');
    await flush();

    // The spawner answers the live delegate's operational question via the send tool;
    // the host routes it to the delegate's sub-channel and it critiques again.
    const ack = await bridge.message(id!, 'run the suite with PATH=/c/Program Files/nodejs');
    expect(ack.delegateId).toBe(id); // delivered to a live delegate
    await flush();

    // The follow-up landed on the delegate's own sub-channel...
    expect(subLogs.get(id!)).toContainEqual({
      from: 'w1-executor',
      role: 'executor',
      type: 'text',
      payload: 'run the suite with PATH=/c/Program Files/nodejs',
    });
    // ...and both the delegate's replies bridged up, in order.
    expect(reports).toEqual([
      { from: id, role: 'evaluator', type: 'result', payload: 'critique by evaluator: review the diff' },
      {
        from: id,
        role: 'evaluator',
        type: 'result',
        payload: 'critique by evaluator: run the suite with PATH=/c/Program Files/nodejs',
      },
    ]);
  });

  it('reports a follow-up to an unknown delegate as undeliverable (#111)', async () => {
    const { bridge } = wire();
    const response = await bridge.message('w1-executor-evaluator-9', 'anyone there?');
    expect(response.error).toBe('no live delegate: w1-executor-evaluator-9');
    expect(response.delegateId).toBeUndefined();
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

describe('createDelegationHost — executor-delegate mode (#114)', () => {
  it('provisions a full executor delegate (fresh wiring) for the executor role, not the critique responder', async () => {
    const { bridge, provisioned, seen, subLogs } = wire();

    const { delegateId: id } = await bridge.spawn('executor', 'build the feature');
    await flush();

    // The executor role took the provisioning path — a real, attachable session on
    // its own sub-channel — *not* the shared-worktree critique-responder path.
    expect(provisioned).toEqual([{ id }]);
    expect(seen).toEqual([]);
    // The opening task landed on the delegate's own sub-channel.
    expect(subLogs.get(id!)?.[0]).toMatchObject({ type: 'text', payload: 'build the feature' });
  });

  it('bridges the executor delegate\'s hand-off up under the clean delegate id (AC3)', async () => {
    const { bridge, reports } = wire();

    const { delegateId: id } = await bridge.spawn('executor', 'do the work');
    await flush();

    // The delegate's agent ran under its suffixed seat, but the hand-off bridges up
    // attributed to the clean delegate id, read as a (non-authoritative) agent.
    expect(reports).toEqual([
      { from: id, role: 'executor', type: 'result', payload: 'executed: do the work' },
    ]);
    expect(senderAttribution(reports[0])).toBe(`[Message from agent (id: ${id})]`);
  });

  it('drives the delegate\'s sub-channel as the orchestrator when the spawner is one (AC1)', async () => {
    // An orchestrator host stamps its driver seat `orchestrator`, so the executor
    // delegate reads its opening task attributed to its delegating supervisor.
    const { bridge, subLogs } = wire({ spawnerId: 'orch', spawnerRole: 'orchestrator' });

    const { delegateId: id } = await bridge.spawn('executor', 'go');
    await flush();

    expect(id).toBe('orch-executor-1');
    expect(subLogs.get(id!)?.[0]).toMatchObject({ from: 'orch', role: 'orchestrator', payload: 'go' });
  });

  it('answers with an error (no unanswered hang) when provisioning an executor delegate throws', async () => {
    // Provisioning a full executor delegate can fail (e.g. its worktree branch
    // already exists). The spawn must *resolve* with an error rather than leaving
    // the spawner's mcp__delegate__spawn call unanswered, and nothing bridges up.
    const { bridge, reports } = wire({
      provisionExecutorDelegate: () => {
        throw new Error('branch already exists');
      },
    });

    const response = await bridge.spawn('executor', 'do the work');

    expect(response.delegateId).toBeUndefined();
    expect(response.error).toContain('branch already exists');
    await flush();
    expect(reports).toEqual([]);
  });

  it('tears the executor delegate down on shutdown and on host close (AC2)', async () => {
    const { bridge, host, closedExecutorDelegates } = wire();

    const { delegateId: id1 } = await bridge.spawn('executor', 'first');
    await flush();
    await bridge.shutdown(id1!);
    expect(closedExecutorDelegates()).toBe(1); // its full wiring was torn down

    await bridge.spawn('executor', 'second');
    await flush();
    host.close();
    expect(closedExecutorDelegates()).toBe(2); // the remaining one too
  });
});
