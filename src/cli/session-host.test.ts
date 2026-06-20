import { describe, it, expect } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message } from '../core/channel.ts';
import { hostSession, renderIncoming } from './session-host.ts';

async function* lines(...items: string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

describe('renderIncoming', () => {
  it('renders a text message as a single line', () => {
    expect(renderIncoming({ from: 'planner-1', type: 'text', payload: 'hi' })).toBe('planner-1 [text] hi');
  });
});

describe('hostSession', () => {
  it('reports the role it joined as (AC2)', async () => {
    const output: string[] = [];
    await hostSession(new InMemoryChannel(), { id: 'planner-1', role: 'planner' }, {
      input: lines(),
      output: (l) => output.push(l),
    });
    expect(output[0]).toBe('joined channel as planner (planner-1)');
  });

  it('sends each input line as a message to other participants (AC3)', async () => {
    const channel = new InMemoryChannel();
    const executorInbox: Message[] = [];
    channel.join('executor-1', 'executor', (m) => executorInbox.push(m));

    await hostSession(channel, { id: 'planner-1', role: 'planner' }, {
      input: lines('build it', 'ship it'),
      output: () => {},
    });

    expect(executorInbox).toEqual([
      { from: 'planner-1', type: 'text', payload: 'build it' },
      { from: 'planner-1', type: 'text', payload: 'ship it' },
    ]);
  });

  it('writes messages received from the channel to the output (AC3)', async () => {
    const channel = new InMemoryChannel();
    const output: string[] = [];
    const executor = channel.join('executor-1', 'executor', () => {});

    // The executor sends while the session is still active (the input generator
    // runs inside hostSession's loop, before it closes the participant).
    async function* sendWhileActive(): AsyncIterable<string> {
      executor.send({ type: 'text', payload: 'on it' });
      // yield nothing: input ends, session closes
    }

    await hostSession(channel, { id: 'planner-1', role: 'planner' }, {
      input: sendWhileActive(),
      output: (l) => output.push(l),
    });

    expect(output).toContain('executor-1 [text] on it');
  });
});
