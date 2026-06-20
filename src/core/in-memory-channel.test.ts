import { describe, it, expect } from 'vitest';
import { InMemoryChannel } from './in-memory-channel.ts';
import type { Message } from './channel.ts';

describe('InMemoryChannel', () => {
  it('lets a participant join the channel in a role (AC1)', () => {
    const channel = new InMemoryChannel();
    const planner = channel.join('planner-1', 'planner', () => {});
    expect(planner.id).toBe('planner-1');
    expect(planner.role).toBe('planner');
  });

  it('delivers a message from one participant to another (AC2)', () => {
    const channel = new InMemoryChannel();
    const executorInbox: Message[] = [];
    channel.join('executor-1', 'executor', (m) => executorInbox.push(m));
    const planner = channel.join('planner-1', 'planner', () => {});

    planner.send({ type: 'task', payload: { id: 42 } });

    expect(executorInbox).toEqual([{ from: 'planner-1', role: 'planner', type: 'task', payload: { id: 42 } }]);
  });

  it('does not echo a message back to its sender', () => {
    const channel = new InMemoryChannel();
    const plannerInbox: Message[] = [];
    const planner = channel.join('planner-1', 'planner', (m) => plannerInbox.push(m));
    channel.join('executor-1', 'executor', () => {});

    planner.send({ type: 'ping' });

    expect(plannerInbox).toEqual([]);
  });

  it('rejects joining with a duplicate participant id', () => {
    const channel = new InMemoryChannel();
    channel.join('dup', 'planner', () => {});
    expect(() => channel.join('dup', 'executor', () => {})).toThrow(/already joined/);
  });
});
