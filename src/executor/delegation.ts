import type { Channel, Message, Role } from '../core/channel.ts';
import { acknowledge, runExecutor, type Respond } from './executor-runtime.ts';

/**
 * Agent-to-agent delegation (#88, rung 2 of #85): the transport-free primitive
 * that lets one agent (the *spawner*) delegate to another (a *delegate*) and see
 * the delegate's report on its own channel.
 *
 * Two channels are in play. The **spawner's channel** is where the spawner talks
 * to its orchestrator/architect. Each delegate runs on its **own sub-channel** —
 * a separate session whose log holds the delegate's full exchange, isolated from
 * the spawner's conversation. When the delegate replies on the sub-channel, the
 * manager bridges that reply **up** onto the spawner's channel, posted *as the
 * delegate* so #86 sender attribution marks it a (non-authoritative) agent report
 * — never indistinguishable from the architect's instruction.
 *
 * Mirrors the shape `PermissionBridge` established: transport-free, wired by the
 * caller (who supplies the channels and how a sub-channel is opened), and unit-
 * testable over {@link InMemoryChannel}s with no real `claude`. Rung 2 proves the
 * seam with a stub delegate (the {@link acknowledge} responder); rung 3 swaps a
 * real agent in behind the same {@link DelegationDeps.createResponder} seam, the
 * way `createClaudeCodeResponder` dropped in behind `runExecutor`'s `Respond`.
 */
export interface DelegationManager {
  /**
   * Spawn a delegate of `role` on its own sub-channel, send it `openingTask`, and
   * return the delegate's id **immediately** — without awaiting its reply. The
   * reply arrives later, bridged up onto the spawner's channel.
   */
  spawn(role: Role, openingTask: Omit<Message, 'from' | 'role'>): string;
  /**
   * End the delegate with `id`: leave both its sub-channel seat and its reporting
   * seat on the spawner's channel, and close the sub-channel — releasing the
   * bridge. Unknown ids are a no-op (idempotent).
   */
  shutdown(id: string): void;
}

export interface DelegationDeps {
  /** The spawner's id on its own channel; roots every derived delegate id. */
  readonly spawnerId: string;
  /** The role the spawner holds when it drives a delegate on the sub-channel. */
  readonly spawnerRole: Role;
  /** The spawner's channel; bridged delegate reports are posted here. */
  readonly spawnerChannel: Channel;
  /**
   * Open (creating if needed) the sub-channel for a derived delegate id. Tests
   * pass a factory of {@link InMemoryChannel}s; production passes
   * `(id) => sessionStore.open(id)`, so each delegate gets its own session log.
   */
  readonly openSubChannel: (id: string) => Channel;
  /**
   * Build a delegate's responder. Defaults to the {@link acknowledge} stub (the
   * rung-2 echo delegate). Rung 3 injects a real `claude`-backed responder here.
   */
  readonly createResponder?: (role: Role, id: string) => Respond;
}

/** Create a {@link DelegationManager} for one spawner. */
export function createDelegationManager(deps: DelegationDeps): DelegationManager {
  const { spawnerId, spawnerRole, spawnerChannel, openSubChannel } = deps;
  const createResponder = deps.createResponder ?? (() => acknowledge);

  // Monotonic so a derived id is unique even if a role is spawned repeatedly; the
  // role stays in the id (`<spawner>-<role>-<n>`) for log traceability of lineage.
  let sequence = 0;
  const delegates = new Map<string, { close(): void }>();

  return {
    spawn(role, openingTask) {
      const id = `${spawnerId}-${role}-${++sequence}`;
      const sub = openSubChannel(id);

      // The delegate: responds to tasks on its own sub-channel, in its own role.
      const delegate = runExecutor(sub, id, createResponder(role, id), role);

      // The reporter: the delegate's seat on the *spawner's* channel. Posting the
      // bridged reply through this seat makes the channel stamp it `from: <id>`,
      // `role`, so #86 attribution reads it as an agent report (never the human).
      const reporter = spawnerChannel.join(id, role, () => {});

      // The driver: the spawner's seat on the sub-channel — it sends the opening
      // task and listens for the delegate's reply, which it bridges up verbatim
      // through the reporter. Every message it hears is from the delegate (a
      // channel never echoes a sender to itself); the `from` guard documents that.
      const driver = sub.join(spawnerId, spawnerRole, (message) => {
        if (message.from === id) reporter.send({ type: message.type, payload: message.payload });
      });

      delegates.set(id, {
        close() {
          driver.close();
          reporter.close();
          delegate.close();
          sub.close();
        },
      });

      driver.send(openingTask);
      return id;
    },

    shutdown(id) {
      const delegate = delegates.get(id);
      if (!delegate) return;
      delegates.delete(id);
      delegate.close();
    },
  };
}
