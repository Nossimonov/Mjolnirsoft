import type { Channel, Message, Role } from '../core/channel.ts';
import { type AgentRole, isAgentRole } from '../core/agent-instructions.ts';
import {
  DELEGATION_REQUEST,
  DELEGATION_RESPONSE,
  type DelegationRequest,
  type DelegationResponse,
} from '../core/delegation-protocol.ts';
import { createDelegationManager, type DelegateWiring } from './delegation.ts';
import { runExecutor, type Respond } from './executor-runtime.ts';

export interface DelegationHostDeps {
  /** The spawner's channel — where requests arrive and reports bridge up. */
  readonly spawnerChannel: Channel;
  /** The spawner's id; roots every derived delegate id and drives each sub-channel. */
  readonly spawnerId: string;
  /**
   * The spawner's own role, stamped on the seat that drives a delegate's
   * sub-channel — so the delegate reads its opening task attributed to its actual
   * supervisor (an `orchestrator` delegating to an executor, an `executor`
   * delegating to an evaluator). Defaults to `executor` (the original caller shape).
   */
  readonly spawnerRole?: Role;
  /** This host's seat on the spawner's channel — receives requests, sends responses. */
  readonly hostId: string;
  /**
   * Open (creating if needed) the sub-channel for a derived delegate id —
   * production passes `(id) => sessionStore.open(id)`, so each delegate gets its
   * own session log.
   */
  readonly openSubChannel: (id: string) => Channel;
  /**
   * Provision a full **executor delegate** on its own sub-channel (#114): a fresh
   * isolated worktree + full executor wiring (responder, permission/delegation MCP,
   * a nested host) — distinct from the evaluator's shared, no-worktree review mode.
   * Production wires this from the extension's session-provisioning helper; returns
   * the delegate wiring (its closer + its agent's report seat).
   */
  readonly provisionExecutorDelegate: (id: string, sub: Channel) => DelegateWiring;
  /**
   * Build a shared-worktree **critique delegate's** responder for its (validated,
   * non-executor) agent role — production passes a `claude`-backed one running on
   * the spawner's own worktree (the evaluator that cold-reads "what is").
   */
  readonly createResponder: (role: AgentRole, id: string) => Respond;
}

/** A running delegation host; `close()` ends all its delegates and leaves the channel. */
export interface DelegationHost {
  close(): void;
}

/**
 * The host side of live delegation (#93): owns a {@link createDelegationManager}
 * and answers the spawner's {@link DelegationRequest}s arriving over the channel
 * from its delegation MCP server. On `spawn` it validates the role is a real agent
 * role, then provisions the delegate by **role** (#114): an `executor` gets a
 * fresh isolated worktree + full executor wiring (a real, attachable session) via
 * {@link DelegationHostDeps.provisionExecutorDelegate}, while a critique role (the
 * evaluator) runs a plain `claude`-backed responder on the *spawner's own*
 * worktree (reviewing "what is"). Either way the delegate runs on its own
 * sub-channel and its distilled report bridges back up the spawner's channel; on
 * `shutdown` it ends that delegate. The manager mirrors `PermissionBridge`'s
 * transport-free shape, so this host is unit-testable over an {@link InMemoryChannel}
 * with fakes and no real `claude`.
 *
 * The spawn is automatic — no human decision gates it (unlike a permission
 * prompt): concurrency and read-only safety are handled by *protocol and role*
 * (the spawner delegates at a quiescent point; the evaluator role is critique-only;
 * an executor delegate is confined to its own worktree), not by machinery here.
 */
export function createDelegationHost(deps: DelegationHostDeps): DelegationHost {
  const { spawnerChannel, spawnerId, hostId, openSubChannel } = deps;

  const manager = createDelegationManager({
    spawnerId,
    spawnerRole: deps.spawnerRole ?? 'executor',
    spawnerChannel,
    openSubChannel,
    // The role reaching the manager is always validated to an AgentRole below
    // before spawn is called, so the narrowing cast is safe. Executor delegates get
    // a fresh worktree + full wiring (a real, attachable session); every other
    // critique role (the evaluator) is a plain responder on the spawner's worktree.
    createDelegate: (role, id, sub) => {
      if (role === 'executor') return deps.provisionExecutorDelegate(id, sub);
      return { close: runExecutor(sub, id, deps.createResponder(role as AgentRole, id), role).close };
    },
  });

  // Track spawned ids so close() can end every delegate (the manager keeps its
  // own map but doesn't expose it); shutdown removes them as they end.
  const spawned = new Set<string>();

  const host = spawnerChannel.join(hostId, 'planner', (message: Message) => {
    if (message.type !== DELEGATION_REQUEST) return;
    const request = message.payload as DelegationRequest | undefined;
    if (!request || typeof request.requestId !== 'string') return;

    const respond = (response: Omit<DelegationResponse, 'requestId'>) =>
      host.send({ type: DELEGATION_RESPONSE, payload: { requestId: request.requestId, ...response } });

    if (request.action === 'spawn') {
      const role = request.role ?? '';
      if (!isAgentRole(role)) {
        respond({ error: `cannot spawn unknown role: ${role || '(none)'}` });
        return;
      }
      // Provisioning a full executor delegate (#114) can fail (its worktree branch
      // may already exist); answer with an error rather than letting the throw
      // propagate unanswered and hang the spawner's `mcp__delegate__spawn` call.
      let id: string;
      try {
        id = manager.spawn(role, { type: 'text', payload: request.task ?? '' });
      } catch (error) {
        respond({ error: `failed to spawn ${role} delegate: ${String(error)}` });
        return;
      }
      spawned.add(id);
      respond({ delegateId: id });
    } else if (request.action === 'message') {
      // A follow-up to a live delegate (#111): route it to the delegate's sub-channel.
      // Report back whether a live delegate received it, so the spawner learns when its
      // delegate is already gone rather than silently waiting for a reply that won't come.
      const id = request.delegateId ?? '';
      const delivered = id ? manager.send(id, { type: 'text', payload: request.task ?? '' }) : false;
      respond(delivered ? { delegateId: id } : { error: `no live delegate: ${id || '(none)'}` });
    } else if (request.action === 'shutdown') {
      const id = request.delegateId;
      if (id) {
        manager.shutdown(id);
        spawned.delete(id);
      }
      respond({ delegateId: id });
    }
  });

  return {
    close() {
      for (const id of spawned) manager.shutdown(id);
      spawned.clear();
      host.close();
    },
  };
}
