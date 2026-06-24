import { describe, it, expect } from 'vitest';
import { parseTurns, sumTurns, weightedByKind } from './usage-report.ts';

const usage = (i: number, o: number, cr: number, cc: number) =>
  JSON.stringify({
    from: 'orchestrator-usage',
    role: 'orchestrator',
    type: 'usage',
    payload: { inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc },
  });
const text = (payload: string, role = 'planner') =>
  JSON.stringify({ from: 'vscode-view', role, type: 'text', payload });

describe('parseTurns (#233)', () => {
  it('extracts one TurnUsage per usage message, weighted by the canonical weights', () => {
    // 10*1 + 2*5 + 100*0.1 + 4*1.25 = 35
    const turns = parseTurns([usage(10, 2, 100, 4)]);
    expect(turns).not.toBeNull();
    expect(turns!).toHaveLength(1);
    expect(turns![0].usage).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 4 });
    expect(turns![0].weighted).toBe(35);
  });

  it('tags each turn with the most recent conversational message before it', () => {
    const turns = parseTurns([text('do the thing'), usage(1, 1, 0, 0)])!;
    expect(turns[0].context).toEqual({ type: 'text', role: 'planner', text: 'do the thing' });
  });

  it('ignores infrastructure lines and blank/unparseable lines', () => {
    const reasoning = JSON.stringify({ from: 'x', role: 'orchestrator', type: 'reasoning-digest', payload: { entries: [] } });
    const turns = parseTurns(['', 'not json', reasoning, usage(1, 1, 0, 0)])!;
    expect(turns).toHaveLength(1);
    expect(turns[0].context).toBeUndefined(); // a reasoning-digest is not a context type
  });

  it('with an anchor, counts only the anchor line and everything after it', () => {
    const lines = [text('before'), usage(99, 99, 99, 99), text('GO from here'), usage(2, 0, 0, 0)];
    const turns = parseTurns(lines, 'GO from here')!;
    expect(turns).toHaveLength(1);
    expect(turns[0].usage.inputTokens).toBe(2);
    expect(turns[0].context?.text).toBe('GO from here'); // the anchor line itself labels the first turn
  });

  it('returns null when the anchor is never found (so the caller can report it)', () => {
    expect(parseTurns([text('a'), usage(1, 1, 1, 1)], 'no such line')).toBeNull();
  });
});

describe('sumTurns + weightedByKind (#233)', () => {
  it('sums turns field-wise', () => {
    const turns = parseTurns([usage(1, 2, 3, 4), usage(10, 20, 30, 40)])!;
    expect(sumTurns(turns)).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 });
  });

  it('splits a tally into per-kind weighted contributions whose sum is the total weight', () => {
    const by = weightedByKind({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 4 });
    expect(by).toEqual({ input: 10, output: 10, cacheRead: 10, cacheCreation: 5, total: 35 });
  });
});
