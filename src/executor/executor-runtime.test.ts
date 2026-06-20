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
