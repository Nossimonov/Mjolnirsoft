import { describe, it, expect } from 'vitest';
import { parseArgs, CliUsageError } from './parse-args.ts';

describe('parseArgs', () => {
  it('parses a role and defaults the id', () => {
    expect(parseArgs(['planner'])).toEqual({ role: 'planner', id: 'planner-1' });
    expect(parseArgs(['executor'])).toEqual({ role: 'executor', id: 'executor-1' });
  });

  it('accepts an explicit participant id', () => {
    expect(parseArgs(['executor', 'w-7'])).toEqual({ role: 'executor', id: 'w-7' });
  });

  it('rejects a missing role', () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
  });

  it('rejects an invalid role', () => {
    expect(() => parseArgs(['boss'])).toThrow(CliUsageError);
  });

  it('parses --session to join a shared session by id', () => {
    expect(parseArgs(['executor', '--session', 'demo'])).toEqual({
      role: 'executor',
      id: 'executor-1',
      sessionId: 'demo',
    });
    expect(parseArgs(['planner', 'p-2', '-s', 'demo'])).toEqual({
      role: 'planner',
      id: 'p-2',
      sessionId: 'demo',
    });
  });

  it('rejects --session without an id', () => {
    expect(() => parseArgs(['executor', '--session'])).toThrow(CliUsageError);
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

  it('parses --auto (automated executor)', () => {
    expect(parseArgs(['executor', 'w1', '--session', 'demo', '--auto'])).toEqual({
      role: 'executor',
      id: 'w1',
      sessionId: 'demo',
      auto: true,
    });
  });
});
