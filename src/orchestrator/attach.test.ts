import { describe, it, expect } from 'vitest';
import { attachInvitation } from './attach.ts';

describe('attachInvitation', () => {
  it('produces the attach handle and command for a spawned worker (AC1)', () => {
    expect(attachInvitation({ id: 'worker-1', logPath: '/sessions/worker-1.jsonl' })).toEqual({
      workerId: 'worker-1',
      sessionLog: '/sessions/worker-1.jsonl',
      command: 'npm run session -- planner user --log "/sessions/worker-1.jsonl" --replay',
    });
  });

  it('uses a given user id', () => {
    expect(attachInvitation({ id: 'w', logPath: '/s/w.jsonl' }, 'alice').command).toBe(
      'npm run session -- planner alice --log "/s/w.jsonl" --replay',
    );
  });
});
