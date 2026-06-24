import { randomUUID } from 'node:crypto';
import type { Channel, Message, Participant, Role } from '../core/channel.ts';
import { acknowledge, runExecutor, deliversToAgent } from './executor-runtime.ts';

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
 * seam with a stub delegate (the {@link acknowledge} responder); rung 3 swapped a
 * real `claude`-backed agent in behind the {@link DelegationDeps.createDelegate}
 * seam; #114 generalized that seam from "a responder" to "wire the whole delegate
 * on its sub-channel" so an executor delegate can stand up its *own* full wiring
 * (a fresh worktree, permission/delegation MCP, a nested host) there — the
 * evaluator stays a plain responder, an executor brings a session.
 */
export interface DelegationManager {
  /**
   * Spawn a delegate of `role` on its own sub-channel, send it `openingTask`, and
   * return the delegate's id **immediately** — without awaiting its reply. The
   * reply arrives later, bridged up onto the spawner's channel.
   */
  spawn(role: Role, openingTask: Omit<Message, 'from' | 'role'>): string;
  /**
   * Send a follow-up `message` to the live delegate `id` — it continues on its
   * pinned session and its next reply bridges up as usual (#111). Returns whether a
   * live delegate received it (`false` for an unknown/ended id, so the caller can
   * tell the spawner its delegate is gone). The spawner→delegate direction the
   * one-shot spawn/shutdown pair lacked.
   */
  send(id: string, message: Omit<Message, 'from' | 'role'>): boolean;
  /**
   * End the delegate with `id`: leave both its sub-channel seat and its reporting
   * seat on the spawner's channel, and close the sub-channel — releasing the
   * bridge. Unknown ids are a no-op (idempotent).
   */
  shutdown(id: string): void;
  /**
   * Re-establish the bridge for a delegate that survived a reload (#128): wire the
   * reporter seat on the spawner's channel and the driver seat on `sub` without
   * sending an opening task (the delegate is already running and resumes via #126).
   * Future replies from `delegate.reportFrom` on `sub` bridge up to the spawner's
   * channel under `id`, exactly as after a normal spawn. Idempotent: re-wiring an
   * already-live `id` is a no-op.
   */
  rewire(role: Role, id: string, sub: Channel, delegate: DelegateWiring): void;
}

/**
 * What a {@link DelegationDeps.createDelegate} factory returns: how to tear the
 * delegate down, and which sub-channel seat its *report* is posted from.
 */
export interface DelegateWiring {
  /** End the delegate and everything wired for it on the sub-channel. */
  close(): void;
  /**
   * The sub-channel seat whose messages are the delegate's report to bridge up.
   * Defaults to the delegate id — a plain {@link runExecutor} delegate (the stub
   * and the evaluator) joins as `id`. A *full executor delegate* runs its agent
   * under a distinct seat (`${id}-executor`, alongside its `${id}-perms` /
   * `${id}-delegate` MCP seats) and names that here, so the bridge tracks the
   * agent's reply rather than one of its own MCP seats (#114).
   */
  reportFrom?: string;
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
   * Wire a delegate of `role` on its sub-channel `sub`, returning a closer (and,
   * optionally, the seat its report is posted from). Defaults to a plain
   * {@link runExecutor} delegate driven by the {@link acknowledge} stub — the
   * rung-2 echo. A real deployment passes a factory that runs a `claude`-backed
   * critique delegate (an evaluator on the spawner's worktree) or stands up full
   * executor wiring (#114). The manager owns the bridge (reporter + driver) around
   * whatever this wires.
   */
  readonly createDelegate?: (role: Role, id: string, sub: Channel) => DelegateWiring;
  /**
   * Generate a short unique token appended to each derived delegate id. Defaults to
   * 8 hex chars from {@link randomUUID} — unique by construction, never colliding
   * across reloads or with leftover branches even when the in-memory sequence resets
   * to 0. Injectable so tests can drive it deterministically.
   */
  readonly generateToken?: () => string;
}

/** Create a {@link DelegationManager} for one spawner. */
export function createDelegationManager(deps: DelegationDeps): DelegationManager {
  const { spawnerId, spawnerRole, spawnerChannel, openSubChannel } = deps;
  const createDelegate: NonNullable<DelegationDeps['createDelegate']> =
    deps.createDelegate ?? ((role, id, sub) => ({ close: runExecutor(sub, id, acknowledge, role).close }));
  // Short random hex suffix — unique by construction so the id never collides with a
  // leftover branch or a prior-session id even when `sequence` resets on a reload.
  // The injectable seam lets tests drive it deterministically.
  const generateToken = deps.generateToken ?? (() => randomUUID().replace(/-/g, '').slice(0, 8));

  // Per-manager monotonic counter — cosmetic only (keeps the role legible in logs
  // and gives a human-readable spawn order). Uniqueness comes from `generateToken`.
  let sequence = 0;
  // Each live delegate keeps its `close`, its `driver` (the spawner's seat on the
  // sub-channel), and its `reporter` (the delegate's seat on the spawner's channel).
  // Storing the reporter alongside the driver enables detachBridgeForCompaction to
  // close both bridge seats without touching the delegate session (#204).
  const delegates = new Map<string, { close(): void; driver: Participant; reporter: Participant }>();

  return {
    spawn(role, openingTask) {
      const id = `${spawnerId}-${role}-${++sequence}-${generateToken()}`;
      const sub = openSubChannel(id);

      // The delegate: whatever the factory wires on the sub-channel — a plain
      // responder (stub/evaluator) or a full executor session (#114). It must join
      // its agent seat before the opening task is sent (below). Provisioning a full
      // executor delegate can fail (e.g. its worktree branch already exists), so if
      // the factory throws, close the just-opened sub-channel before rethrowing —
      // otherwise the sub leaks and the caller's spawn dead-ends (#114).
      let delegate: DelegateWiring;
      try {
        delegate = createDelegate(role, id, sub);
      } catch (error) {
        sub.close();
        throw error;
      }
      const reportFrom = delegate.reportFrom ?? id;

      // The reporter: the delegate's seat on the *spawner's* channel. Posting the
      // bridged reply through this seat makes the channel stamp it `from: <id>`,
      // `role`, so #86 attribution reads it as an agent report (never the human) —
      // and uses the clean delegate id even when the agent's own seat is suffixed.
      const reporter = spawnerChannel.join(id, role, () => {});

      // The driver: the spawner's seat on the sub-channel — it sends the opening
      // task and listens for the delegate's reply, which it bridges up verbatim
      // through the reporter.
      const driver = sub.join(spawnerId, spawnerRole, (message) => {
        // Only the delegate's distilled *report* (its result/error) crosses up to the
        // spawner, as a turn the spawner reacts to. Two filters, both allowlists by
        // design (#116): `reportFrom` keeps a full executor delegate's own MCP-seat
        // traffic (permission cards, delegation control, per-turn usage) on the
        // sub-channel; `deliversToAgent` admits only conversational types, so the
        // delegate's reasoning digest (#110) and any other infrastructure it emits
        // stay on its own sub-channel log for post-mortem rather than becoming a
        // spawner turn. New infra types are excluded automatically, not by a denylist.
        if (message.from === reportFrom && deliversToAgent(message)) {
          reporter.send({ type: message.type, payload: message.payload });
        }
      });

      delegates.set(id, {
        driver,
        reporter,
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

    send(id, message) {
      const delegate = delegates.get(id);
      if (!delegate) return false; // unknown/ended — the caller tells the spawner it's gone
      // Drive the follow-up onto the sub-channel from the spawner's seat, exactly as
      // the opening task: the delegate's responder takes it as another turn (it pins a
      // claude session and `--resume`s), and its reply bridges up through the reporter.
      delegate.driver.send(message);
      return true;
    },

    shutdown(id) {
      const delegate = delegates.get(id);
      if (!delegate) return;
      delegates.delete(id);
      delegate.close();
    },

    rewire(role, id, sub, delegate) {
      if (delegates.has(id)) return; // already wired — idempotent
      const reportFrom = delegate.reportFrom ?? id;
      const reporter = spawnerChannel.join(id, role, () => {});
      const driver = sub.join(spawnerId, spawnerRole, (message) => {
        if (message.from === reportFrom && deliversToAgent(message)) {
          reporter.send({ type: message.type, payload: message.payload });
        }
      });
      delegates.set(id, {
        driver,
        reporter,
        close() {
          driver.close();
          reporter.close();
          delegate.close();
          sub.close();
        },
      });
    },

  };
}
