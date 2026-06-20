import { describe, it, expect } from 'vitest';
import { attachInvitation } from './attach.ts';

describe('attachInvitation', () => {
  it('produces the attach handle and command for a spawned executor', () => {
    expect(attachInvitation({ id: 'executor-1', sessionId: 'demo' })).toEqual({
      executorId: 'executor-1',
      sessionId: 'demo',
      command: 'npm run session -- planner user --session demo --replay',
    });
  });

  it('uses a given user id', () => {
    expect(attachInvitation({ id: 'w', sessionId: 'demo' }, 'kevin').command).toBe(
      'npm run session -- planner kevin --session demo --replay',
    );
  });
});
