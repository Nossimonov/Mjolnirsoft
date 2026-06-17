import { describe, it, expect } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message } from '../core/channel.ts';
import { runWorker } from './worker-runtime.ts';

describe('runWorker', () => {
  it('auto-acknowledges a task, completing the orchestrator round-trip (AC1/AC3)', () => {
    const channel = new InMemoryChannel();
    const orchestratorInbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => orchestratorInbox.push(m));
    runWorker(channel, 'worker-1');

    orchestrator.send({ type: 'text', payload: 'implement #88' });

    expect(orchestratorInbox).toEqual([
      { from: 'worker-1', type: 'ack', payload: 'received: implement #88' },
    ]);
  });

  it('uses a replaceable respond behavior', () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runWorker(channel, 'worker-1', (task) => ({ type: 'result', payload: `done: ${task.payload}` }));

    orchestrator.send({ type: 'text', payload: 'X' });

    expect(inbox).toEqual([{ from: 'worker-1', type: 'result', payload: 'done: X' }]);
  });

  it('sends no reply when the behavior returns undefined', () => {
    const channel = new InMemoryChannel();
    const inbox: Message[] = [];
    const orchestrator = channel.join('orchestrator', 'planner', (m) => inbox.push(m));
    runWorker(channel, 'worker-1', () => undefined);

    orchestrator.send({ type: 'text', payload: 'X' });

    expect(inbox).toEqual([]);
  });
});
