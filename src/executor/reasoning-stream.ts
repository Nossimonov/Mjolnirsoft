import type { ViewEvent } from './claude-code-responder.ts';

/**
 * A per-session, in-process bridge for an executor's *live* reasoning (#109).
 *
 * The executor responder is created (and starts running turns) before its view
 * panel exists, and its intermediate events are deliberately **ephemeral** — they
 * must reach the webview without ever touching the durable {@link Channel} or the
 * JSONL log (only the final `result` persists, as today). A plain channel message
 * would be logged and replayed; this seam is the off-channel path instead: the
 * responder pushes {@link ViewEvent}s in via `emit`, and the panel — once open —
 * `subscribe`s to forward them to the webview. Late subscription is fine: events
 * before anyone subscribes are simply dropped (live typing has no value once past).
 *
 * Intentionally tiny and host-agnostic (no VS Code, no I/O) so it's unit-tested
 * directly and the panel/responder wiring stays a thin adapter over it.
 */
export interface ReasoningStream {
  /** Push a live event toward whoever is currently subscribed (no-op if no one is). */
  emit(event: ViewEvent): void;
  /** Receive every subsequent event; returns an unsubscribe to call on panel dispose. */
  subscribe(listener: (event: ViewEvent) => void): () => void;
}

/** Create an independent {@link ReasoningStream} for one session. */
export function createReasoningStream(): ReasoningStream {
  const listeners = new Set<(event: ViewEvent) => void>();
  return {
    emit(event) {
      // Copy before iterating so a listener that unsubscribes mid-dispatch (e.g. the
      // panel closing as an event arrives) can't mutate the set under iteration.
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
