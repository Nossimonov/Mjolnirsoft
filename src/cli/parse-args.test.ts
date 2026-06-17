import { describe, it, expect } from 'vitest';
import { parseArgs, CliUsageError } from './parse-args.ts';

describe('parseArgs', () => {
  it('parses a role and defaults the id (AC1)', () => {
    expect(parseArgs(['planner'])).toEqual({ role: 'planner', id: 'planner-1' });
    expect(parseArgs(['worker'])).toEqual({ role: 'worker', id: 'worker-1' });
  });

  it('accepts an explicit participant id', () => {
    expect(parseArgs(['worker', 'w-7'])).toEqual({ role: 'worker', id: 'w-7' });
  });

  it('rejects a missing role (AC1)', () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
  });

  it('rejects an invalid role (AC1)', () => {
    expect(() => parseArgs(['boss'])).toThrow(CliUsageError);
  });

  it('parses a --log path for a shared file-backed channel', () => {
    expect(parseArgs(['worker', '--log', '/tmp/s.jsonl'])).toEqual({
      role: 'worker',
      id: 'worker-1',
      logPath: '/tmp/s.jsonl',
    });
    expect(parseArgs(['planner', 'p-2', '-l', '/tmp/s.jsonl'])).toEqual({
      role: 'planner',
      id: 'p-2',
      logPath: '/tmp/s.jsonl',
    });
  });

  it('rejects --log without a value', () => {
    expect(() => parseArgs(['worker', '--log'])).toThrow(CliUsageError);
  });

  it('parses --replay (attach with history) when a log is given', () => {
    expect(parseArgs(['planner', 'observer', '--log', '/tmp/s.jsonl', '--replay'])).toEqual({
      role: 'planner',
      id: 'observer',
      logPath: '/tmp/s.jsonl',
      replay: true,
    });
  });

  it('rejects --replay without --log', () => {
    expect(() => parseArgs(['planner', '--replay'])).toThrow(CliUsageError);
  });

  it('parses --auto (automated worker)', () => {
    expect(parseArgs(['worker', 'w1', '--log', '/tmp/s.jsonl', '--auto'])).toEqual({
      role: 'worker',
      id: 'w1',
      logPath: '/tmp/s.jsonl',
      auto: true,
    });
  });
});
