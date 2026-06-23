/**
 * Singleton orchestrator lifecycle guard (#215).
 *
 * At most one orchestrator generation may be bound to the session channel at a
 * time. This module tracks the active generation's teardown function and calls
 * it before a new generation binds, covering the compaction-relaunch,
 * window-reload, and abort + relaunch paths.
 *
 * The enforcement point is `evict()`, called at the start of every new
 * orchestrator launch (before the new channel is opened). The current
 * generation registers its teardown via `register()` after all its channel
 * participants are wired up.
 */

export interface OrchestratorSingleton {
  /**
   * Evict the currently-registered generation (if any) by calling its close
   * function, then clear the registration. Call this at the START of
   * launching a new generation, before opening the new channel — ensures the
   * old generation is unsubscribed from the channel before the new one joins.
   * No-op if no generation is currently registered.
   */
  evict(): void;
  /**
   * Register the teardown function for the just-launched generation. Call
   * this AFTER all channel participants for the new generation are wired
   * (compaction host, idle trigger, agent) so the eviction function is
   * complete when the next generation calls `evict()`. The close function
   * must be idempotent — it may be called after the normal `onDispose` path
   * has already cleaned up.
   */
  register(close: () => void): void;
}

export function createOrchestratorSingleton(): OrchestratorSingleton {
  let currentClose: (() => void) | undefined;
  return {
    evict(): void {
      const close = currentClose;
      currentClose = undefined;
      close?.();
    },
    register(close: () => void): void {
      currentClose = close;
    },
  };
}
