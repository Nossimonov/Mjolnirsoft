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
  /** Token generator forwarded to the manager; defaults to a per-wire sequential generator for deterministic ids. */
  readonly generateToken?: () => string;
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
  let n = 0;
  const generateToken = options.generateToken ?? (() => `tok${String(++n).padStart(5, '0')}`);
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

  // The full isolated-worktree delegate (#114, #99) path: a fake stand-in for the
  // extension's real provisioning. It runs a plain responder under the *suffixed*
  // agent seat (`${id}-executor`, as the real wiring does alongside its MCP seats),
  // records the provisioning (including the role and whether it is resuming, so
  // tests can verify correct instructions and the resuming flag would be used),
  // and names that seat via reportFrom.
  const provisioned: Array<{ role: AgentRole; id: string; resuming: boolean }> = [];
  let closedExecutorDelegates = 0;
  const provisionExecutorDelegate: DelegationHostDeps['provisionExecutorDelegate'] =
    options.provisionExecutorDelegate ??
    ((role: AgentRole, id: string, sub: Channel, resuming: boolean): DelegateWiring => {
      provisioned.push({ role, id, resuming });
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
    generateToken,
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
    expect(id).toBe('w1-executor-evaluator-1-tok00001');
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

describe('createDelegationHost — investigator-delegate mode (#166)', () => {
  it('spawns an investigator on the shared-worktree critique-responder path (not isolated worktree)', async () => {
    const { bridge, seen, provisioned, subLogs } = wire();

    const { delegateId: id } = await bridge.spawn('investigator', 'verify what issue #142 decided');
    await flush();

    // The investigator is read-only — it takes the shared-worktree critique-responder
    // path (like the evaluator), not the isolated-worktree provisioning path.
    expect(seen).toEqual([{ role: 'investigator', id }]);
    expect(provisioned).toEqual([]);
    expect(subLogs.get(id!)?.[0]).toMatchObject({
      type: 'text',
      payload: 'verify what issue #142 decided',
    });
  });

  it('bridges the investigator finding up under the clean delegate id, attributed as a (non-authoritative) agent', async () => {
    const { bridge, reports } = wire();

    const { delegateId: id } = await bridge.spawn('investigator', 'verify state');
    await flush();

    expect(reports).toEqual([
      { from: id, role: 'investigator', type: 'result', payload: 'critique by investigator: verify state' },
    ]);
    expect(senderAttribution(reports[0])).toBe(`[Message from agent (id: ${id})]`);
  });
});

describe('createDelegationHost — rewireDelegate (#128)', () => {
  it('re-establishes the bridge for an executor delegate without sending an opening task', async () => {
    // Simulate a reload: a new host is created for the resumed orchestrator. The
    // delegate already has its own sub-channel (its session log), and the host
    // re-provisions it (resuming via #126) and wires the bridge.
    const { host, reports } = wire();

    const delegateId = 'w1-executor-executor-1-rewired';

    // The new host re-wires the bridge for this pre-existing delegate.
    host.rewireDelegate('executor', delegateId);

    // No opening task should have been sent — the delegate is resuming, not starting.
    expect(reports).toEqual([]);
  });

  it('bridges a resumed delegate\'s future reply up to the spawner channel', async () => {
    // After rewiring, when the delegate's agent sends a result (e.g. the resumed
    // claude turn completes), it bridges up under the clean delegate id.
    const { bridge, host, reports } = wire({
      provisionExecutorDelegate: (_role, id, sub) => {
        const agentSeat = `${id}-executor`;
        const agent = runExecutor(
          sub, agentSeat,
          async (m) => ({ type: 'result', payload: `resumed: ${m.payload}` }),
          'executor',
        );
        return { reportFrom: agentSeat, close: agent.close };
      },
    });

    const delegateId = 'w1-executor-executor-1-rewired';
    host.rewireDelegate('executor', delegateId);

    // Send a follow-up via the MCP bridge — routes through the host to manager.send
    // which uses the re-wired driver seat to deliver to the delegate.
    void bridge.message(delegateId, 'continue the task');
    await flush();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      from: delegateId,
      role: 'executor',
      type: 'result',
      payload: 'resumed: continue the task',
    });
  });

  it('skips critique-only roles (evaluator, investigator) — they have no persistent worktree', () => {
    const { host, reports } = wire();

    host.rewireDelegate('evaluator', 'w1-executor-evaluator-1-rewired');
    host.rewireDelegate('investigator', 'w1-executor-investigator-1-rewired');

    expect(reports).toEqual([]);
  });

  it('passes resuming: true on rewire and resuming: false on fresh spawn (#191)', async () => {
    const { bridge, host, provisioned } = wire();

    // A fresh spawn sets resuming: false.
    const { delegateId: spawnId } = await bridge.spawn('executor', 'new task');
    expect(provisioned).toEqual([{ role: 'executor', id: spawnId, resuming: false }]);

    // A rewire (post-reload) sets resuming: true.
    const rewiredId = 'w1-executor-executor-1-rewired-flag';
    host.rewireDelegate('executor', rewiredId);
    expect(provisioned).toEqual([
      { role: 'executor', id: spawnId, resuming: false },
      { role: 'executor', id: rewiredId, resuming: true },
    ]);
  });

  it('is idempotent: re-wiring an already-wired delegate is a no-op', async () => {
    const { bridge, host, reports } = wire();

    // Normal spawn first.
    const { delegateId: id } = await bridge.spawn('executor', 'original task');
    await flush();
    expect(reports).toHaveLength(1);

    // Attempt to rewire the same id — should be silently ignored.
    host.rewireDelegate('executor', id!);
    await flush();
    expect(reports).toHaveLength(1); // no additional message
  });

  it('a rewired delegate is closed by host.close()', async () => {
    const { host, reports, subChannels } = wire({
      provisionExecutorDelegate: (_role, id, sub) => {
        const agentSeat = `${id}-executor`;
        const agent = runExecutor(
          sub, agentSeat,
          async (m) => ({ type: 'result', payload: `done: ${m.payload}` }),
          'executor',
        );
        return { reportFrom: agentSeat, close: agent.close };
      },
    });

    const delegateId = 'w1-executor-executor-1-rewired-close';
    host.rewireDelegate('executor', delegateId);

    host.close();

    // After close the bridge seats are released; a probe on the sub-channel
    // can't reach the spawner's reports any more (same pattern as the existing
    // "ends every live delegate on host close" test).
    const sub = subChannels.get(delegateId)!;
    const probe = sub.join('probe', 'planner', () => {});
    probe.send({ type: 'result', payload: 'too late' });
    await flush();
    expect(reports).toEqual([]);
  });
});

describe('createDelegationHost — releaseForCompaction (#204)', () => {
  it('does not call close() on executor delegate sessions', async () => {
    const { bridge, host, closedExecutorDelegates } = wire();

    await bridge.spawn('executor', 'do the work');
    await flush();
    expect(closedExecutorDelegates()).toBe(0);

    host.releaseForCompaction();

    expect(closedExecutorDelegates()).toBe(0);
  });

  it('detaches the old bridge so subsequent delegate replies do not reach the spawner', async () => {
    const { bridge, host, reports, subChannels } = wire({
      provisionExecutorDelegate: (_role, id, sub) => {
        const agentSeat = `${id}-executor`;
        const agent = runExecutor(sub, agentSeat, async (m) => ({ type: 'result', payload: `done: ${m.payload}` }), 'executor');
        return { reportFrom: agentSeat, close: agent.close };
      },
    });

    const { delegateId: id } = await bridge.spawn('executor', 'task');
    await flush();
    expect(reports).toHaveLength(1);

    host.releaseForCompaction();

    // Driver is detached; a probe on the sub-channel cannot reach spawner reports.
    const sub = subChannels.get(id!)!;
    const probe = sub.join('probe', 'planner', () => {});
    probe.send({ type: 'result', payload: 'late hand-off' });
    await flush();

    expect(reports).toHaveLength(1); // no double-delivery
  });

  it('a subsequent host.close() after releaseForCompaction does not close delegates', async () => {
    const { bridge, host, closedExecutorDelegates } = wire();

    await bridge.spawn('executor', 'task');
    await flush();

    host.releaseForCompaction();
    host.close(); // spawned set is already clear — safe no-op for delegates

    expect(closedExecutorDelegates()).toBe(0);
  });

  it('a delegate can be rewired after releaseForCompaction and its future replies bridge up', async () => {
    // Simulate a compaction restart: the old host releases for compaction, then a new
    // host (new orchestrator generation) wires the same delegate on a new sub-channel.
    // The new delegate receives a follow-up and its reply bridges up to the spawner.
    const spawnerChannel = new InMemoryChannel();
    const reports: Message[] = [];
    spawnerChannel.join('observer', 'planner', (m) => {
      if (m.type !== 'delegation-request' && m.type !== 'delegation-response') reports.push(m);
    });

    const subChannels = new Map<string, InMemoryChannel>();
    const openSubChannel = (id: string) => {
      const sub = new InMemoryChannel();
      subChannels.set(id, sub);
      return sub;
    };

    let wiredIds: string[] = [];
    const provisionExecutorDelegate: DelegationHostDeps['provisionExecutorDelegate'] = (
      _role, id, sub, resuming,
    ) => {
      wiredIds.push(id);
      const agentSeat = `${id}-executor`;
      const agent = runExecutor(
        sub,
        agentSeat,
        async (m) => ({ type: 'result', payload: resuming ? `resumed: ${String(m.payload)}` : `new: ${String(m.payload)}` }),
        'executor',
      );
      return { reportFrom: agentSeat, close: agent.close };
    };

    // Build old host (first generation).
    const oldHost = createDelegationHost({
      spawnerChannel, spawnerId: 'orch', spawnerRole: 'orchestrator',
      hostId: 'orch-delegation-host',
      openSubChannel,
      createResponder: (_role) => async (m) => ({ type: 'result', payload: String(m.payload) }),
      provisionExecutorDelegate,
    });

    // Spawn a delegate through the old host.
    const mcp = spawnerChannel.join('orch-delegate', 'orchestrator', (m) => bridge.handleMessage(m));
    const bridge = createDelegationBridge(mcp.send);
    const { delegateId: id } = await bridge.spawn('executor', 'initial task');
    await flush();
    expect(reports).toHaveLength(1);

    // Compaction: release without closing delegates.
    oldHost.releaseForCompaction();

    // New orchestrator generation rewires the delegate on the same spawner channel.
    const newHost = createDelegationHost({
      spawnerChannel, spawnerId: 'orch', spawnerRole: 'orchestrator',
      hostId: 'orch-delegation-host-gen2',
      openSubChannel,
      createResponder: (_role) => async (m) => ({ type: 'result', payload: String(m.payload) }),
      provisionExecutorDelegate,
    });
    newHost.rewireDelegate('executor', id!);

    // The rewired delegate's sub-channel has a live agent. Drive it via the sub-channel
    // (simulating the delegate sending its hand-off).
    const sub = subChannels.get(id!)!;
    const driver = sub.join('orch-driver', 'orchestrator', () => {});
    driver.send({ type: 'text', payload: 'follow-up from new generation' });
    await flush();

    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ from: id, role: 'executor', type: 'result', payload: 'resumed: follow-up from new generation' });
  });
});

describe('createDelegationHost — arbitrator-delegate mode (#99)', () => {
  it('provisions an arbitrator on the isolated-worktree path (not the critique responder)', async () => {
    const { bridge, provisioned, seen, subLogs } = wire();

    const { delegateId: id } = await bridge.spawn('arbitrator', 'reconcile branch-a and branch-b');
    await flush();

    // The arbitrator role takes the provisionExecutorDelegate path (isolated worktree),
    // not the shared-worktree critique-responder path; the role is passed through so
    // the provisioner can compose the correct instructions.
    expect(provisioned).toEqual([{ role: 'arbitrator', id, resuming: false }]);
    expect(seen).toEqual([]);
    expect(subLogs.get(id!)?.[0]).toMatchObject({ type: 'text', payload: 'reconcile branch-a and branch-b' });
  });

  it('bridges the arbitrator hand-off up under the clean delegate id, attributed as a (non-authoritative) agent', async () => {
    const { bridge, reports } = wire();

    const { delegateId: id } = await bridge.spawn('arbitrator', 'reconcile');
    await flush();

    expect(reports).toEqual([
      { from: id, role: 'arbitrator', type: 'result', payload: 'executed: reconcile' },
    ]);
    expect(senderAttribution(reports[0])).toBe(`[Message from agent (id: ${id})]`);
  });
});

describe('createDelegationHost — executor-delegate mode (#114)', () => {
  it('provisions a full executor delegate (fresh wiring) for the executor role, not the critique responder', async () => {
    const { bridge, provisioned, seen, subLogs } = wire();

    const { delegateId: id } = await bridge.spawn('executor', 'build the feature');
    await flush();

    // The executor role took the provisioning path — a real, attachable session on
    // its own sub-channel — *not* the shared-worktree critique-responder path.
    expect(provisioned).toEqual([{ role: 'executor', id, resuming: false }]);
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

    expect(id).toBe('orch-executor-1-tok00001');
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
