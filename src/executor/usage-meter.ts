import { type Usage, addUsage, ZERO_USAGE } from './claude-code-responder.ts';

/**
 * A per-session token accumulator (#116). Each turn's {@link Usage} is added in by
 * code (read from the `claude` result line — no agent turn is spent counting); the
 * running total is exposed for a live view and rolled up to a spawner.
 *
 * **Spawner roll-up:** a meter created with an `onAdd` hook forwards every per-turn
 * delta to it, so a parent meter (the orchestrator's) `.add`s the same delta and its
 * total includes all its delegates' usage — recursively, since a delegate's own
 * delegates bubble through it. Host-agnostic and unit-tested directly (no `claude`).
 */
export interface UsageMeter {
  /** Add one turn's usage: accumulates, notifies subscribers, and bubbles the delta up. */
  add(turn: Usage): void;
  /** The running total so far (this session + any rolled-up sub-agents). */
  total(): Usage;
  /** Receive the running total now and on every change; returns an unsubscribe. */
  subscribe(listener: (total: Usage) => void): () => void;
}

/**
 * Create a {@link UsageMeter}. `onAdd` (optional) receives each per-turn delta — pass
 * a parent meter's `add` to roll this session's usage (and its sub-agents') up into
 * the spawner.
 */
export function createUsageMeter(onAdd?: (turn: Usage) => void): UsageMeter {
  let total = ZERO_USAGE;
  const listeners = new Set<(t: Usage) => void>();
  return {
    add(turn) {
      total = addUsage(total, turn);
      // Copy before iterating so a listener that unsubscribes mid-dispatch can't
      // mutate the set under iteration (mirrors the reasoning stream).
      for (const listener of [...listeners]) listener(total);
      onAdd?.(turn); // bubble the delta to a parent meter (spawner roll-up)
    },
    total: () => total,
    subscribe(listener) {
      listeners.add(listener);
      listener(total); // emit the current total now, so a freshly-attached panel isn't blank
      return () => listeners.delete(listener);
    },
  };
}
