import { describe, it, expect } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message } from '../core/channel.ts';
import { runWorker } from './worker-runtime.ts';

/** Let queued microtasks/timers run so an async respond can deliver its reply. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runWorker', () => {
  it('auto-acknowledges a task, completing the orchestrator round-trip (AC1/AC3)', async () => {
    const channel = new InMemoryChannel();
    const orchestratorInbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => orchestratorInbox.push(m));
    runWorker(channel, 'worker-1');

    orchestrator.send({ type: 'text', payload: 'implement #88' });
    await flush();

    expect(orchestratorInbox).toEqual([
      { from: 'worker-1', type: 'ack', payload: 'received: implement #88' },
    ]);
  });

  it('uses a replaceable async respond behavior', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runWorker(channel, 'worker-1', async (task) => ({ type: 'result', payload: `done: ${task.payload}` }));

    orchestrator.send({ type: 'text', payload: 'X' });
    await flush();

    expect(inbox).toEqual([{ from: 'worker-1', type: 'result', payload: 'done: X' }]);
  });

  it('sends no reply when the behavior resolves undefined', async () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runWorker(channel, 'worker-1', async () => undefined);

    orchestrator.send({ type: 'text', payload: 'X' });
    await flush();

    expect(inbox).toEqual([]);
  });
});
