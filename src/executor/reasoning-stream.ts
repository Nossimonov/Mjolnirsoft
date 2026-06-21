import type { ReasoningDigest } from './reasoning-digest.ts';

/**
 * A per-session, in-process bridge for an executor's *live* reasoning (#109/#110).
 *
 * The executor responder is created (and starts running turns) before its view
 * panel exists, and its intermediate snapshots are deliberately **ephemeral** — they
 * must reach the webview without ever touching the durable {@link Channel} or the
 * JSONL log (only the final `result` and the durable digest persist). A plain
 * channel message would be logged and replayed; this seam is the off-channel path
 * instead: the responder pushes block-level {@link ReasoningDigest} snapshots in via
 * `emit` as the trail grows, and the panel — once open — `subscribe`s to forward the
 * latest to the webview. Late subscription is fine: snapshots before anyone
 * subscribes are simply dropped (the next one carries the full trail so far).
 *
 * Intentionally tiny and host-agnostic (no VS Code, no I/O) so it's unit-tested
 * directly and the panel/responder wiring stays a thin adapter over it.
 */
export interface ReasoningStream {
  /** Push a live snapshot toward whoever is currently subscribed (no-op if no one is). */
  emit(snapshot: ReasoningDigest): void;
  /** Receive every subsequent snapshot; returns an unsubscribe to call on panel dispose. */
  subscribe(listener: (snapshot: ReasoningDigest) => void): () => void;
}

/** Create an independent {@link ReasoningStream} for one session. */
export function createReasoningStream(): ReasoningStream {
  const listeners = new Set<(snapshot: ReasoningDigest) => void>();
  return {
    emit(snapshot) {
      // Copy before iterating so a listener that unsubscribes mid-dispatch (e.g. the
      // panel closing as a snapshot arrives) can't mutate the set under iteration.
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
