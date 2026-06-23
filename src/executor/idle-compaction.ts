/**
 * Idle-triggered orchestrator self-compaction (#167).
 *
 * The orchestrator's dominant idle is waiting on executor delegates, not the
 * architect pausing. After a configurable threshold (default 210s — well under
 * the 300s prompt-cache TTL), the host injects a "compact now" prompt so the
 * hand-off turn is itself cache-warm, and the eventual post-idle resume starts
 * from a small fresh context.
 *
 * The trigger is time-based ONLY — context size is not a condition (see #167
 * rationale: it is unreliable). The host observes the orchestrator's channel to
 * detect turn boundaries (mid-turn guard) and fires exactly once per session.
 */
import type { Channel } from '../core/channel.ts';
import { deliversToAgent } from './executor-runtime.ts';

/** A handle returned by {@link createIdleCompactionTrigger}; always call `close()` on dispose. */
export interface IdleCompactionTrigger {
  /** Cancel the idle timer and leave the channel. Safe to call more than once. */
  close(): void;
}

/**
 * Watch the orchestrator's channel and call `onFire` exactly once when the
 * orchestrator has been continuously idle for `thresholdMs` milliseconds.
 *
 * Turn-boundary tracking via channel observation:
 *   - Any non-agent message of a conversational type (`deliversToAgent`) marks
 *     the start of a new agent turn (`midTurn = true`).
 *   - A `result` or `error` from `agentId` marks turn completion (`midTurn = false`)
 *     and resets the idle clock.
 *
 * The trigger does not fire until at least one turn has completed, never fires
 * while `midTurn` is true, and fires at most once per session (the session
 * restarts after a compaction, so a new trigger covers the new session).
 */
export function createIdleCompactionTrigger({
  channel,
  agentId,
  thresholdMs,
  participantId,
  onFire,
}: {
  /** The orchestrator's session channel. */
  readonly channel: Channel;
  /** The orchestrator agent's participant id — used to detect turn completion. */
  readonly agentId: string;
  /** Milliseconds of continuous idle before firing. */
  readonly thresholdMs: number;
  /** A unique participant id for this trigger's channel observer seat. */
  readonly participantId: string;
  /** Called once when the idle threshold is reached and the orchestrator is not mid-turn. */
  readonly onFire: () => void;
}): IdleCompactionTrigger {
  let lastTurnCompletedAt: number | undefined;
  let midTurn = false;
  let fired = false;
  let closed = false;

  const observer = channel.join(participantId, 'planner', (msg) => {
    if (closed) return;
    if (msg.from === agentId) {
      // Turn completed — agent sent its result (or error on failure).
      if (msg.type === 'result' || msg.type === 'error') {
        midTurn = false;
        lastTurnCompletedAt = Date.now();
      }
    } else if (deliversToAgent(msg)) {
      // New turn started — a conversational message from a non-agent participant
      // (architect prompt or bridged delegate report).
      midTurn = true;
    }
  });

  const handle = setInterval(() => {
    if (closed || fired) return;
    if (midTurn) return;
    if (lastTurnCompletedAt === undefined) return; // no turn has completed yet
    if (Date.now() - lastTurnCompletedAt < thresholdMs) return;
    fired = true;
    onFire();
  }, 15_000);

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(handle);
      observer.close();
    },
  };
}
