import { describe, it, expect } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message } from '../core/channel.ts';
import { runExecutor } from './executor-runtime.ts';

/** Let queued microtasks/timers run so an async respond can deliver its reply. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runExecutor', () => {
  it('auto-acknowledges a task, completing the orchestrator round-trip (AC1/AC3)', async () => {
    const channel = new InMemoryChannel();
    const orchestratorInbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => orchestratorInbox.push(m));
    runExecutor(channel, 'executor-1');

    orchestrator.send({ type: 'text', payload: 'implement #88' });
    await flush();

    expect(orchestratorInbox).toEqual([
      { from: 'executor-1', role: 'executor', type: 'ack', payload: 'received: implement #88' },
    ]);
  });

  it('uses a replaceable async respond behavior', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runExecutor(channel, 'executor-1', async (task) => ({ type: 'result', payload: `done: ${task.payload}` }));

    orchestrator.send({ type: 'text', payload: 'X' });
    await flush();

    expect(inbox).toEqual([{ from: 'executor-1', role: 'executor', type: 'result', payload: 'done: X' }]);
  });

  it('posts an error message on the channel when respond rejects (AC1/AC3)', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runExecutor(channel, 'executor-1', async () => {
      throw new Error('claude exited 401');
    });

    orchestrator.send({ type: 'text', payload: 'X' });
    await flush();

    // The failure surfaces as an attributed `error` turn — reaching every host
    // and the durable log, and stopping the view's "working" indicator (#89).
    expect(inbox).toEqual([
      {
        from: 'executor-1',
        role: 'executor',
        type: 'error',
        payload: 'executor executor-1 failed to respond: Error: claude exited 401',
      },
    ]);
  });

  it('serializes turns: a message arriving mid-turn runs only after the first settles (AC5)', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runExecutor(channel, 'executor-1', async (task) => {
      const payload = task.payload as string;
      events.push(`start:${payload}`);
      // The first turn parks on a gate while in-flight (modelling a pending
      // permission card / a long claude run); the second must not start until released.
      if (payload === 'A') await firstGate;
      events.push(`end:${payload}`);
      return { type: 'result', payload: `done: ${payload}` };
    });

    // Both messages land while turn A is still in-flight.
    orchestrator.send({ type: 'text', payload: 'A' });
    orchestrator.send({ type: 'text', payload: 'B' });
    await flush();

    // A has started but is parked; B has NOT started — no concurrent turn.
    expect(events).toEqual(['start:A']);

    releaseFirst();
    await flush();

    // Strict order: A fully settles before B begins, and replies arrive in order.
    expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
    expect(inbox).toEqual([
      { from: 'executor-1', role: 'executor', type: 'result', payload: 'done: A' },
      { from: 'executor-1', role: 'executor', type: 'result', payload: 'done: B' },
    ]);
  });

  it('a failed turn does not wedge the queue; a later turn still runs (AC4)', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));

    runExecutor(channel, 'executor-1', async (task) => {
      if (task.payload === 'boom') throw new Error('claude exited 401');
      return { type: 'result', payload: `done: ${task.payload}` };
    });

    orchestrator.send({ type: 'text', payload: 'boom' });
    orchestrator.send({ type: 'text', payload: 'ok' });
    await flush();

    // The failed turn posts its #89 error turn, and the queued turn still runs after it.
    expect(inbox).toEqual([
      {
        from: 'executor-1',
        role: 'executor',
        type: 'error',
        payload: 'executor executor-1 failed to respond: Error: claude exited 401',
      },
      { from: 'executor-1', role: 'executor', type: 'result', payload: 'done: ok' },
    ]);
  });

  it('sends every message of a multi-message reply to the channel, in order (#110 digest + result)', async () => {
    // A turn may reply with a reasoning digest followed by the result; both must
    // land on the durable channel, the digest first, distinct from the result.
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runExecutor(channel, 'executor-1', async () => [
      { type: 'reasoning-digest', payload: { entries: [{ kind: 'thinking', text: 'why' }] } },
      { type: 'result', payload: 'the answer' },
    ]);

    orchestrator.send({ type: 'text', payload: 'X' });
    await flush();

    expect(inbox).toEqual([
      { from: 'executor-1', role: 'executor', type: 'reasoning-digest', payload: { entries: [{ kind: 'thinking', text: 'why' }] } },
      { from: 'executor-1', role: 'executor', type: 'result', payload: 'the answer' },
    ]);
  });

  it('sends no reply when the behavior resolves undefined', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runExecutor(channel, 'executor-1', async () => undefined);

    orchestrator.send({ type: 'text', payload: 'X' });
    await flush();

    expect(inbox).toEqual([]);
  });
});
