import { describe, it, expect, vi } from 'vitest';
import { createUsageMeter } from './usage-meter.ts';
import type { Usage } from './claude-code-responder.ts';

const u = (output: number, cacheRead = 0): Usage => ({
  inputTokens: 0,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: 0,
});

describe('createUsageMeter (#116)', () => {
  it('accumulates per-turn usage into a running total', () => {
    const m = createUsageMeter();
    m.add(u(10, 100));
    m.add(u(5, 50));
    expect(m.total()).toEqual({ inputTokens: 0, outputTokens: 15, cacheReadTokens: 150, cacheCreationTokens: 0 });
  });

  it('notifies subscribers with the running total now and on each add', () => {
    const m = createUsageMeter();
    const seen: number[] = [];
    m.subscribe((t) => seen.push(t.outputTokens));
    m.add(u(10));
    m.add(u(5));
    expect(seen).toEqual([0, 10, 15]); // current-on-subscribe, then after each add
  });

  it('rolls a delegate meter up into its spawner (per-turn deltas bubble)', () => {
    const orchestrator = createUsageMeter();
    const delegate = createUsageMeter(orchestrator.add); // bubble to the spawner
    orchestrator.add(u(3)); // the orchestrator's own turn
    delegate.add(u(20, 200)); // a delegate turn
    delegate.add(u(7));
    expect(delegate.total()).toEqual({ inputTokens: 0, outputTokens: 27, cacheReadTokens: 200, cacheCreationTokens: 0 });
    // The orchestrator's total includes its own turn + every delegate turn.
    expect(orchestrator.total()).toEqual({ inputTokens: 0, outputTokens: 30, cacheReadTokens: 200, cacheCreationTokens: 0 });
  });

  it('stops notifying after unsubscribe', () => {
    const m = createUsageMeter();
    const listener = vi.fn();
    const off = m.subscribe(listener);
    off();
    m.add(u(1));
    expect(listener).toHaveBeenCalledTimes(1); // only the current-on-subscribe call
  });
});
