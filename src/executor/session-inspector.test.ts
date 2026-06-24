/**
 * Tests for inspectSession — role and lifetime-usage recovery from a session log (#126).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSession } from './session-inspector.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-inspect-'));
  tempDirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('inspectSession — role recovery (#126)', () => {
  it('returns undefined role when log is empty', () => {
    expect(inspectSession(tempLog([]), 'orchestrator').role).toBeUndefined();
  });

  it('reads the role from the agent seat message', () => {
    const logPath = tempLog([
      JSON.stringify({ from: 'orchestrator-executor', role: 'orchestrator', type: 'result', payload: 'hi' }),
    ]);
    expect(inspectSession(logPath, 'orchestrator').role).toBe('orchestrator');
  });

  it('reads executor role', () => {
    const logPath = tempLog([
      JSON.stringify({ from: 'my-session-executor', role: 'executor', type: 'result', payload: 'done' }),
    ]);
    expect(inspectSession(logPath, 'my-session').role).toBe('executor');
  });

  it('ignores messages from other participants', () => {
    const logPath = tempLog([
      JSON.stringify({ from: 'other-executor', role: 'orchestrator', type: 'result', payload: 'hi' }),
    ]);
    // The agent seat is `${sessionId}-executor`; 'other-executor' is not the agent seat for 'orchestrator'
    expect(inspectSession(logPath, 'orchestrator').role).toBeUndefined();
  });

  it('returns undefined role when log is missing', () => {
    expect(inspectSession('/nonexistent/path.jsonl', 'session').role).toBeUndefined();
  });
});

describe('inspectSession — lifetime usage (#116/#126)', () => {
  it('returns zero usage for an empty log', () => {
    const meta = inspectSession(tempLog([]), 'orchestrator');
    expect(meta.lifetimeUsage.inputTokens).toBe(0);
    expect(meta.lifetimeUsage.outputTokens).toBe(0);
  });

  it('sums all usage messages into lifetimeUsage', () => {
    const u1 = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 10 };
    const u2 = { inputTokens: 30, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 5 };
    const logPath = tempLog([
      JSON.stringify({ from: 'orchestrator-usage', role: 'orchestrator', type: 'usage', payload: u1 }),
      JSON.stringify({ from: 'orchestrator-usage', role: 'orchestrator', type: 'usage', payload: u2 }),
    ]);
    const meta = inspectSession(logPath, 'orchestrator');
    expect(meta.lifetimeUsage.inputTokens).toBe(130);
    expect(meta.lifetimeUsage.outputTokens).toBe(70);
    expect(meta.lifetimeUsage.cacheReadTokens).toBe(250);
    expect(meta.lifetimeUsage.cacheCreationTokens).toBe(15);
  });

  it('skips malformed lines without throwing', () => {
    const u = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const logPath = tempLog([
      'not json',
      '',
      JSON.stringify({ from: 'orchestrator-usage', role: 'orchestrator', type: 'usage', payload: u }),
      '{ broken',
    ]);
    expect(inspectSession(logPath, 'orchestrator').lifetimeUsage.inputTokens).toBe(10);
  });

  it('reads both role and lifetimeUsage from the same log', () => {
    const u = { inputTokens: 50, outputTokens: 25, cacheReadTokens: 100, cacheCreationTokens: 0 };
    const logPath = tempLog([
      JSON.stringify({ from: 'orchestrator-executor', role: 'orchestrator', type: 'result', payload: 'hi' }),
      JSON.stringify({ from: 'orchestrator-usage', role: 'orchestrator', type: 'usage', payload: u }),
    ]);
    const meta = inspectSession(logPath, 'orchestrator');
    expect(meta.role).toBe('orchestrator');
    expect(meta.lifetimeUsage.inputTokens).toBe(50);
  });
});
