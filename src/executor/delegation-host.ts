import type { Channel, Message } from '../core/channel.ts';
import { type AgentRole, isAgentRole } from '../core/agent-instructions.ts';
import {
  DELEGATION_REQUEST,
  DELEGATION_RESPONSE,
  type DelegationRequest,
  type DelegationResponse,
} from '../core/delegation-protocol.ts';
import { createDelegationManager } from './delegation.ts';
import type { Respond } from './executor-runtime.ts';

export interface DelegationHostDeps {
  /** The spawner's (executor's) channel — where requests arrive and reports bridge up. */
  readonly spawnerChannel: Channel;
  /** The spawner's id; roots every derived delegate id and drives each sub-channel. */
  readonly spawnerId: string;
  /** This host's seat on the spawner's channel — receives requests, sends responses. */
  readonly hostId: string;
  /**
   * Open (creating if needed) the sub-channel for a derived delegate id —
   * production passes `(id) => sessionStore.open(id)`, so each delegate gets its
   * own session log.
   */
  readonly openSubChannel: (id: string) => Channel;
  /** Build a delegate's responder for its (validated) agent role — production passes a `claude`-backed one. */
  readonly createResponder: (role: AgentRole, id: string) => Respond;
}

/** A running delegation host; `close()` ends all its delegates and leaves the channel. */
export interface DelegationHost {
  close(): void;
}

/**
 * The host side of live delegation (#93): owns a {@link createDelegationManager}
 * and answers the executor's {@link DelegationRequest}s arriving over the channel
 * from its delegation MCP server. On `spawn` it validates the role is a real
 * agent role, opens the delegate (which runs the injected `claude`-backed
 * responder on its own sub-channel, reporting back up the spawner's channel), and
 * returns the new id; on `shutdown` it ends that delegate. The manager already
 * mirrors `PermissionBridge`'s transport-free shape, so this host is unit-testable
 * over an {@link InMemoryChannel} with a fake responder and no real `claude`.
 *
 * The spawn is automatic — no human decision gates it (unlike a permission
 * prompt): concurrency and read-only safety are handled by *protocol and role*
 * (the spawner delegates at a quiescent point; the evaluator role is critique-only),
 * not by machinery here.
 */
export function createDelegationHost(deps: DelegationHostDeps): DelegationHost {
  const { spawnerChannel, spawnerId, hostId, openSubChannel } = deps;

  const manager = createDelegationManager({
    spawnerId,
    spawnerRole: 'executor',
    spawnerChannel,
    openSubChannel,
    // The role reaching the manager is always validated to an AgentRole below
    // before spawn is called, so this narrowing cast is safe.
    createResponder: (role, id) => deps.createResponder(role as AgentRole, id),
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
      const id = manager.spawn(role, { type: 'text', payload: request.task ?? '' });
      spawned.add(id);
      respond({ delegateId: id });
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
