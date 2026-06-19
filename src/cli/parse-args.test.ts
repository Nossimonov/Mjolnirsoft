import { describe, it, expect } from 'vitest';
import { parseArgs, CliUsageError } from './parse-args.ts';

describe('parseArgs', () => {
  it('parses a role and defaults the id', () => {
    expect(parseArgs(['planner'])).toEqual({ role: 'planner', id: 'planner-1' });
    expect(parseArgs(['worker'])).toEqual({ role: 'worker', id: 'worker-1' });
  });

  it('accepts an explicit participant id', () => {
    expect(parseArgs(['worker', 'w-7'])).toEqual({ role: 'worker', id: 'w-7' });
  });

  it('rejects a missing role', () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
  });

  it('rejects an invalid role', () => {
    expect(() => parseArgs(['boss'])).toThrow(CliUsageError);
  });

  it('parses --session to join a shared session by id', () => {
    expect(parseArgs(['worker', '--session', 'demo'])).toEqual({
      role: 'worker',
      id: 'worker-1',
      sessionId: 'demo',
    });
    expect(parseArgs(['planner', 'p-2', '-s', 'demo'])).toEqual({
      role: 'planner',
      id: 'p-2',
      sessionId: 'demo',
    });
  });

  it('rejects --session without an id', () => {
    expect(() => parseArgs(['worker', '--session'])).toThrow(CliUsageError);
  });

  it('parses --replay (attach with history) when a session is given', () => {
    expect(parseArgs(['planner', 'observer', '--session', 'demo', '--replay'])).toEqual({
      role: 'planner',
      id: 'observer',
      sessionId: 'demo',
      replay: true,
    });
  });

  it('rejects --replay without --session', () => {
    expect(() => parseArgs(['planner', '--replay'])).toThrow(CliUsageError);
  });

  it('parses --auto (automated worker)', () => {
    expect(parseArgs(['worker', 'w1', '--session', 'demo', '--auto'])).toEqual({
      role: 'worker',
      id: 'w1',
      sessionId: 'demo',
      auto: true,
    });
  });
});
