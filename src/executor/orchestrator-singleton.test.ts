/**
 * Tests for the singleton orchestrator lifecycle guard (#215):
 *   - createOrchestratorSingleton basic behaviour (evict/register)
 *   - Integration: relaunch while a prior generation is registered closes the predecessor
 *   - Pre-evicted relaunch: eviction is a safe no-op after onDispose already ran (evicted=true)
 *   - Abort + relaunch: eviction closes remaining resources when onDispose has not yet run
 *   - Reload: fresh singleton (no registration) → evict is a no-op for the new generation
 */
import { describe, it, expect } from 'vitest';
import { createOrchestratorSingleton } from './orchestrator-singleton.ts';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import { runExecutor } from './executor-runtime.ts';
import type { Message } from '../core/channel.ts';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// createOrchestratorSingleton unit tests (#215)
// ---------------------------------------------------------------------------

describe('createOrchestratorSingleton (#215)', () => {
  it('evict() calls the registered close function', () => {
    const singleton = createOrchestratorSingleton();
    let closed = false;
    singleton.register(() => { closed = true; });
    singleton.evict();
    expect(closed).toBe(true);
  });

  it('evict() clears the registration so a second evict is a no-op', () => {
    const singleton = createOrchestratorSingleton();
    let closeCount = 0;
    singleton.register(() => { closeCount++; });
    singleton.evict();
    singleton.evict(); // no prior registration — must not call close again
    expect(closeCount).toBe(1);
  });

  it('evict() is a no-op when nothing is registered (reload path)', () => {
    const singleton = createOrchestratorSingleton();
    expect(() => singleton.evict()).not.toThrow();
  });

  it('register() replaces a prior registration', () => {
    const singleton = createOrchestratorSingleton();
    let first = false;
    let second = false;
    singleton.register(() => { first = true; });
    singleton.register(() => { second = true; }); // replaces first
    singleton.evict();
    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it('evict() clears registration even when the close function throws', () => {
    // A throwing close must not prevent the registration from being cleared.
    const singleton = createOrchestratorSingleton();
    singleton.register(() => { throw new Error('close failed'); });
    expect(() => singleton.evict()).toThrow('close failed');
    // No re-registration here — the next evict must be a no-op.
    let callCount = 0;
    singleton.evict(); // nothing registered, must not throw or call anything
    expect(callCount).toBe(0);
    // Re-registration after a throwing evict works normally.
    singleton.register(() => { callCount++; });
    singleton.evict();
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: relaunch while a prior generation is still registered (#215)
// Simulates the abort + relaunch and reload paths.
// ---------------------------------------------------------------------------

describe('relaunch while prior generation is registered (#215)', () => {
  it('predecessor generation is closed/superseded before the new generation binds', async () => {
    const singleton = createOrchestratorSingleton();

    // --- Generation 1: set up a channel and a running orchestrator agent ---
    const channel1 = new InMemoryChannel();
    const gen1Inbox: Message[] = [];
    const planner1 = channel1.join('planner', 'planner', (m) => gen1Inbox.push(m));
    const gen1Agent = runExecutor(channel1, 'orchestrator-executor', async () => ({
      type: 'result',
      payload: 'gen1-response',
    }));

    let gen1AgentClosed = false;
    let gen1ChannelClosed = false;
    const gen1AgentClose = gen1Agent.close;
    gen1Agent.close = () => { gen1AgentClosed = true; gen1AgentClose(); };

    // Register gen1's teardown (mirrors what launchSession does after wiring).
    let gen1Evicted = false;
    singleton.register((): void => {
      if (gen1Evicted) return; // idempotent: already cleaned up by onDispose
      gen1Evicted = true;
      gen1Agent.close();
      gen1ChannelClosed = true;
      channel1.close();
    });

    // Gen1 is live: send a message and verify it responds.
    planner1.send({ type: 'text', payload: 'hello gen1' });
    await flush();
    expect(gen1Inbox).toMatchObject([{ payload: 'gen1-response' }]);

    // --- Generation 2: evict gen1, then bind gen2 ---
    // This mirrors the sequence in launchSession() for the orchestrator role.
    singleton.evict(); // ← ENFORCEMENT POINT: closes gen1 before gen2 opens

    expect(gen1AgentClosed).toBe(true);
    expect(gen1ChannelClosed).toBe(true);

    const channel2 = new InMemoryChannel();
    const gen2Inbox: Message[] = [];
    const planner2 = channel2.join('planner', 'planner', (m) => gen2Inbox.push(m));
    runExecutor(channel2, 'orchestrator-executor', async () => ({
      type: 'result',
      payload: 'gen2-response',
    }));

    // Gen2 is now the sole live orchestrator.
    planner2.send({ type: 'text', payload: 'hello gen2' });
    await flush();
    expect(gen2Inbox).toMatchObject([{ payload: 'gen2-response' }]);

    // Gen1's channel is closed — any write to it is a no-op; gen2 does not
    // receive messages from gen1's channel.
    expect(gen2Inbox).toHaveLength(1); // only the one we just sent
  });

  it('pre-evicted relaunch: eviction is a safe no-op when onDispose already ran (evicted=true)', () => {
    // Mirrors the path where the panel's onDispose fires (user closes panel) and sets
    // evicted=true before a relaunch calls launchSession() → evict(). The registration
    // function must be a no-op because the resources were already released by onDispose.
    const singleton = createOrchestratorSingleton();

    let closeCalled = 0;
    let evicted = false;

    singleton.register((): void => {
      if (evicted) return; // onDispose already cleaned up
      evicted = true;
      closeCalled++;
    });

    // Simulate onDispose running first: sets evicted=true.
    evicted = true; // ← onDispose sets this before the user triggers a relaunch

    // New launchSession calls evict() — must be a safe no-op.
    singleton.evict();
    expect(closeCalled).toBe(0); // eviction bailed out because evicted=true
  });

  it('abort + relaunch: eviction closes remaining resources when onDispose has not yet run', () => {
    // Mirrors: user aborts the orchestrator and relaunches before the panel's onDispose
    // fires. launchSession calls evict() — must close provisioned session + channel.
    const singleton = createOrchestratorSingleton();

    const closed: string[] = [];
    let evicted = false;

    singleton.register((): void => {
      if (evicted) return;
      evicted = true;
      closed.push('provisioned-close');
      closed.push('channel-close');
    });

    // onDispose has NOT fired (panel still open or abort path bypasses it).
    // The singleton holds the registration.

    // Relaunch: launchSession calls evict() — must run the teardown.
    singleton.evict();
    expect(closed).toEqual(['provisioned-close', 'channel-close']);
    expect(evicted).toBe(true);

    // A second evict (e.g. the same launchSession called twice) is a no-op.
    closed.length = 0;
    singleton.evict();
    expect(closed).toHaveLength(0);
  });

  it('two consecutive relaunches: only the immediately-prior generation is evicted', () => {
    const singleton = createOrchestratorSingleton();

    const gen1Closed: string[] = [];
    const gen2Closed: string[] = [];

    // Gen 1 registers
    singleton.register(() => gen1Closed.push('gen1'));

    // Gen 2 launches: evicts gen1, registers gen2
    singleton.evict(); // closes gen1
    singleton.register(() => gen2Closed.push('gen2'));

    // Gen 3 launches: evicts gen2 (not gen1 again)
    singleton.evict(); // closes gen2

    expect(gen1Closed).toEqual(['gen1']); // closed exactly once
    expect(gen2Closed).toEqual(['gen2']); // closed exactly once
  });
});
