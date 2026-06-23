/**
 * Tests for the idle-triggered orchestrator self-compaction trigger (#167).
 *
 * The trigger fires when the orchestrator has been continuously idle for a
 * configurable threshold, using channel observation to detect turn boundaries.
 * Tests use vitest fake timers to control Date.now() and setInterval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import { createIdleCompactionTrigger } from './idle-compaction.ts';

const AGENT_ID = 'orchestrator-executor';
const THRESHOLD_MS = 210_000; // 3.5 min — the default idle threshold

/** Wire a trigger + helper seats for a test, returning them all. */
function setup(thresholdMs = THRESHOLD_MS) {
  const channel = new InMemoryChannel();
  const fired: number[] = [];
  const trigger = createIdleCompactionTrigger({
    channel,
    agentId: AGENT_ID,
    thresholdMs,
    participantId: 'idle-observer',
    onFire: () => fired.push(Date.now()),
  });
  const agentSeat = channel.join(AGENT_ID, 'orchestrator', () => {});
  const plannerSeat = channel.join('planner', 'planner', () => {});
  return { channel, trigger, fired, agentSeat, plannerSeat };
}

describe('createIdleCompactionTrigger (#167)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic fire / no-fire
  // -------------------------------------------------------------------------

  it('does not fire before the threshold elapses', () => {
    const { fired, agentSeat, trigger } = setup();
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(THRESHOLD_MS - 1);
    expect(fired).toHaveLength(0);
    trigger.close();
  });

  it('fires after idle for the threshold duration', () => {
    const { fired, agentSeat, trigger } = setup();
    agentSeat.send({ type: 'result', payload: 'done' });
    // advance past threshold + one check interval
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(1);
    trigger.close();
  });

  it('does not fire when no turn has ever completed', () => {
    const { fired, trigger } = setup();
    vi.advanceTimersByTime(THRESHOLD_MS + 30_000);
    expect(fired).toHaveLength(0);
    trigger.close();
  });

  it('fires at most once per session even with many check intervals', () => {
    const { fired, agentSeat, trigger } = setup();
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000 * 10);
    expect(fired).toHaveLength(1);
    trigger.close();
  });

  // -------------------------------------------------------------------------
  // Mid-turn guard
  // -------------------------------------------------------------------------

  it('does not fire while the orchestrator is mid-turn (architect prompt in flight)', () => {
    const { fired, agentSeat, plannerSeat, trigger } = setup();
    // Complete one turn so lastTurnCompletedAt is set
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(100);
    // Architect sends a new task → mid-turn = true
    plannerSeat.send({ type: 'text', payload: 'new task' });
    // Advance past threshold — still mid-turn (agent has not responded yet)
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(0);
    trigger.close();
  });

  it('fires after the in-flight turn completes and the threshold elapses', () => {
    const { fired, agentSeat, plannerSeat, trigger } = setup();
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(100);
    plannerSeat.send({ type: 'text', payload: 'new task' });
    // Complete the turn
    agentSeat.send({ type: 'result', payload: 'done 2' });
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(1);
    trigger.close();
  });

  it('treats an agent error as a turn completion (not perpetually mid-turn)', () => {
    const { fired, agentSeat, plannerSeat, trigger } = setup();
    plannerSeat.send({ type: 'text', payload: 'task' });
    // Agent errors out instead of sending result
    agentSeat.send({ type: 'error', payload: 'claude failed' });
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(1);
    trigger.close();
  });

  // -------------------------------------------------------------------------
  // Idle clock reset on new turn completion
  // -------------------------------------------------------------------------

  it('does not fire if a turn completes less than threshold ms ago', () => {
    const { fired, agentSeat, trigger } = setup();
    // First turn completes
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(THRESHOLD_MS / 2);
    // Second turn completes, resetting the idle clock
    agentSeat.send({ type: 'result', payload: 'done 2' });
    // Only THRESHOLD_MS/2 has elapsed since the second turn — below threshold
    vi.advanceTimersByTime(THRESHOLD_MS / 2 + 15_000);
    expect(fired).toHaveLength(0);
    trigger.close();
  });

  it('fires after threshold elapses from the most recent turn completion', () => {
    const { fired, agentSeat, trigger } = setup();
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(THRESHOLD_MS / 2);
    agentSeat.send({ type: 'result', payload: 'done 2' });
    // Advance full threshold from the second turn
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(1);
    trigger.close();
  });

  // -------------------------------------------------------------------------
  // Delegate-wait case (the dominant orchestrator idle — see #167)
  // -------------------------------------------------------------------------

  it('treats bridged delegate result as a new turn (mid-turn = true during delegate-wait)', () => {
    const channel = new InMemoryChannel();
    const fired: boolean[] = [];
    const trigger = createIdleCompactionTrigger({
      channel,
      agentId: AGENT_ID,
      thresholdMs: THRESHOLD_MS,
      participantId: 'idle-observer',
      onFire: () => fired.push(true),
    });
    const agentSeat = channel.join(AGENT_ID, 'orchestrator', () => {});
    const delegateSeat = channel.join('orchestrator-executor-1', 'executor', () => {});

    // Orchestrator completed a turn (spawned a delegate, sent result)
    agentSeat.send({ type: 'result', payload: 'spawned delegate' });
    vi.advanceTimersByTime(100);

    // Delegate returns — bridged onto spawner channel as result from delegate's seat
    delegateSeat.send({ type: 'result', payload: 'delegate done' });
    // Now mid-turn = true (orchestrator is processing the delegate report)
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(0); // mid-turn → no fire

    // Orchestrator processes the report and sends its result → idle clock resets
    agentSeat.send({ type: 'result', payload: 'integrated' });
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(1); // now idle → fires

    trigger.close();
    channel.close();
  });

  it('fires during delegate-wait when orchestrator has been idle after spawning', () => {
    const channel = new InMemoryChannel();
    const fired: boolean[] = [];
    const trigger = createIdleCompactionTrigger({
      channel,
      agentId: AGENT_ID,
      thresholdMs: THRESHOLD_MS,
      participantId: 'idle-observer',
      onFire: () => fired.push(true),
    });
    const agentSeat = channel.join(AGENT_ID, 'orchestrator', () => {});

    // Orchestrator completed its delegation turn and is now waiting for the delegate
    agentSeat.send({ type: 'result', payload: 'spawned delegate, waiting' });
    // No further messages — the orchestrator is idle (delegate is working in its sub-channel)
    vi.advanceTimersByTime(THRESHOLD_MS + 15_000);
    expect(fired).toHaveLength(1); // idle during delegate-wait → fires

    trigger.close();
    channel.close();
  });

  // -------------------------------------------------------------------------
  // close() cancels the trigger
  // -------------------------------------------------------------------------

  it('does not fire after close() is called', () => {
    const { fired, agentSeat, trigger } = setup();
    agentSeat.send({ type: 'result', payload: 'done' });
    trigger.close();
    vi.advanceTimersByTime(THRESHOLD_MS + 30_000);
    expect(fired).toHaveLength(0);
  });

  it('close() is idempotent', () => {
    const { trigger } = setup();
    expect(() => { trigger.close(); trigger.close(); }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Threshold = 0 (disabled sentinel — callers must guard against this)
  // -------------------------------------------------------------------------

  it('threshold of 0 would fire on the next check after any turn (callers must not instantiate with 0)', () => {
    const { fired, agentSeat, trigger } = setup(0);
    agentSeat.send({ type: 'result', payload: 'done' });
    vi.advanceTimersByTime(15_000); // one check interval
    expect(fired).toHaveLength(1);
    trigger.close();
  });
});
