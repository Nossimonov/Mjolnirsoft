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
});
