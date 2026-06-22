import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectDelegationLedger,
  findByDelegateId,
  findByTaskKey,
  type DelegationEntry,
} from './delegation-ledger.ts';
import { DELEGATION_REQUEST, DELEGATION_RESPONSE } from '../core/delegation-protocol.ts';
import type { Message } from '../core/channel.ts';

/** Serialise a single message as a JSONL line. */
const line = (msg: Message): string => `${JSON.stringify(msg)}\n`;

/** A minimal delegation-request spawn. */
const spawnRequest = (requestId: string, role: string, task: string): Message => ({
  from: 'orch-delegate',
  role: 'executor',
  type: DELEGATION_REQUEST,
  payload: { requestId, action: 'spawn', role, task },
});

/** The host's successful spawn response. */
const spawnResponse = (requestId: string, delegateId: string): Message => ({
  from: 'orch-delegation-host',
  role: 'planner',
  type: DELEGATION_RESPONSE,
  payload: { requestId, delegateId },
});

/** A bridged report from the delegate. */
const report = (delegateId: string, payload: string): Message => ({
  from: delegateId,
  role: 'evaluator',
  type: 'result',
  payload,
});

/** A delegation-request shutdown. */
const shutdownRequest = (requestId: string, delegateId: string): Message => ({
  from: 'orch-delegate',
  role: 'executor',
  type: DELEGATION_REQUEST,
  payload: { requestId, action: 'shutdown', delegateId },
});

/** The host's shutdown response. */
const shutdownResponse = (requestId: string, delegateId: string): Message => ({
  from: 'orch-delegation-host',
  role: 'planner',
  type: DELEGATION_RESPONSE,
  payload: { requestId, delegateId },
});

describe('delegation-ledger (#168)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mjolnir-ledger-'));
    logPath = join(dir, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array for a missing log file', () => {
    expect(projectDelegationLedger(join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('returns empty array for an empty log', () => {
    writeFileSync(logPath, '');
    expect(projectDelegationLedger(logPath)).toEqual([]);
  });

  it('projects a spawn request+response into an entry with the hand-off task (AC1 derivation)', () => {
    // Write a JSONL log directly — simulating what the FileChannel produces.
    // The ledger derives from this file alone; no delegation manager is involved.
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'evaluator', 'review the diff for issue #168')) +
        line(spawnResponse('req-1', 'orch-evaluator-1-abc')),
    );

    const entries = projectDelegationLedger(logPath);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      delegateId: 'orch-evaluator-1-abc',
      role: 'evaluator',
      task: 'review the diff for issue #168',
      reports: [],
      active: true,
    });
  });

  it('attaches bridged reports to the matching entry (AC1 — hand-off + report)', () => {
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'evaluator', 'review the diff')) +
        line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
        line(report('orch-evaluator-1-abc', 'looks good')),
    );

    const entries = projectDelegationLedger(logPath);

    expect(entries[0].reports).toEqual([{ type: 'result', payload: 'looks good' }]);
  });

  it('marks an entry inactive after a successful shutdown', () => {
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'evaluator', 'review the diff')) +
        line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
        line(report('orch-evaluator-1-abc', 'looks good')) +
        line(shutdownRequest('req-2', 'orch-evaluator-1-abc')) +
        line(shutdownResponse('req-2', 'orch-evaluator-1-abc')),
    );

    const entries = projectDelegationLedger(logPath);

    expect(entries[0].active).toBe(false);
    expect(entries[0].reports).toHaveLength(1); // report still accessible
    expect(entries[0].task).toBe('review the diff'); // hand-off still accessible
  });

  it('ignores infrastructure messages (non-AGENT_PROMPT_TYPES) as reports', () => {
    const infraMsg: Message = {
      from: 'orch-evaluator-1-abc',
      role: 'evaluator',
      type: 'usage',     // infrastructure type — not in the agent-prompt allowlist
      payload: { inputTokens: 100 },
    };
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'evaluator', 'review')) +
        line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
        line(infraMsg),
    );

    const entries = projectDelegationLedger(logPath);

    expect(entries[0].reports).toHaveLength(0);
  });

  it('ignores a spawn response with an error (failed spawn produces no entry)', () => {
    const errResponse: Message = {
      from: 'orch-delegation-host',
      role: 'planner',
      type: DELEGATION_RESPONSE,
      payload: { requestId: 'req-1', error: 'cannot spawn unknown role: wizard' },
    };
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'wizard', 'cast a spell')) + line(errResponse),
    );

    expect(projectDelegationLedger(logPath)).toHaveLength(0);
  });

  it('a shutdown response carrying an error does NOT mark the entry inactive', () => {
    const errorResponse: Message = {
      from: 'orch-delegation-host',
      role: 'planner',
      type: DELEGATION_RESPONSE,
      payload: { requestId: 'req-2', error: 'shutdown failed: delegate already gone' },
    };
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'evaluator', 'review')) +
        line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
        line(shutdownRequest('req-2', 'orch-evaluator-1-abc')) +
        line(errorResponse),
    );

    const entries = projectDelegationLedger(logPath);

    // The shutdown response carried an error: the delegate remains active.
    expect(entries[0].active).toBe(true);
  });

  it('handles multiple delegations on the same log (each entry is independent)', () => {
    writeFileSync(
      logPath,
      line(spawnRequest('req-1', 'evaluator', 'review diff')) +
        line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
        line(report('orch-evaluator-1-abc', 'critique A')) +
        line(spawnRequest('req-2', 'executor', 'build the feature for #999')) +
        line(spawnResponse('req-2', 'orch-executor-2-xyz')) +
        line(report('orch-executor-2-xyz', 'done')),
    );

    const entries = projectDelegationLedger(logPath);

    expect(entries).toHaveLength(2);
    expect(entries[0].delegateId).toBe('orch-evaluator-1-abc');
    expect(entries[1].delegateId).toBe('orch-executor-2-xyz');
    expect(entries[0].reports[0].payload).toBe('critique A');
    expect(entries[1].reports[0].payload).toBe('done');
  });

  describe('findByDelegateId', () => {
    let entries: DelegationEntry[];

    beforeEach(() => {
      writeFileSync(
        logPath,
        line(spawnRequest('req-1', 'evaluator', 'review for #168')) +
          line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
          line(report('orch-evaluator-1-abc', 'LGTM')),
      );
      entries = projectDelegationLedger(logPath);
    });

    it('retrieves the entry by exact delegate id (AC1 — no in-context history needed)', () => {
      const entry = findByDelegateId(entries, 'orch-evaluator-1-abc');
      expect(entry).toBeDefined();
      expect(entry!.task).toBe('review for #168');
      expect(entry!.reports[0].payload).toBe('LGTM');
    });

    it('returns undefined for an unknown id', () => {
      expect(findByDelegateId(entries, 'ghost')).toBeUndefined();
    });
  });

  describe('findByTaskKey', () => {
    let entries: DelegationEntry[];

    beforeEach(() => {
      writeFileSync(
        logPath,
        line(spawnRequest('req-1', 'evaluator', 'review the diff for issue #168')) +
          line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
          line(spawnRequest('req-2', 'executor', 'build the feature for issue #999')) +
          line(spawnResponse('req-2', 'orch-executor-2-xyz')),
      );
      entries = projectDelegationLedger(logPath);
    });

    it('finds entries by issue number in the task text (AC4 — historical keyed retrieval)', () => {
      const matches = findByTaskKey(entries, '#168');
      expect(matches).toHaveLength(1);
      expect(matches[0].delegateId).toBe('orch-evaluator-1-abc');
    });

    it('finds entries by keyword (case-insensitive)', () => {
      const matches = findByTaskKey(entries, 'ISSUE');
      expect(matches).toHaveLength(2);
    });

    it('returns empty array when nothing matches', () => {
      expect(findByTaskKey(entries, 'wizard')).toHaveLength(0);
    });
  });

  describe('active-tier survival across simulated reload (AC3)', () => {
    it('re-projecting from the same log after a simulated reload recovers active delegations', () => {
      // Write a log with one live (not shut down) delegation.
      writeFileSync(
        logPath,
        line(spawnRequest('req-1', 'executor', 'build the feature for #168')) +
          line(spawnResponse('req-1', 'orch-executor-1-abc')) +
          line(report('orch-executor-1-abc', 'working on it')),
      );

      // Simulate first-load: project the ledger.
      const first = projectDelegationLedger(logPath);
      expect(first).toHaveLength(1);
      expect(first[0].active).toBe(true);

      // Simulate reload (new call with no in-memory state — like the orchestrator
      // reattaching after a compaction): project again from the same durable file.
      const afterReload = projectDelegationLedger(logPath);
      expect(afterReload).toHaveLength(1);
      expect(afterReload[0].active).toBe(true);
      expect(afterReload[0].task).toBe('build the feature for #168');
      expect(afterReload[0].reports[0].payload).toBe('working on it');
    });

    it('projection after reload correctly shows a delegation that completed before reload as inactive', () => {
      writeFileSync(
        logPath,
        line(spawnRequest('req-1', 'evaluator', 'review')) +
          line(spawnResponse('req-1', 'orch-evaluator-1-abc')) +
          line(report('orch-evaluator-1-abc', 'done')) +
          line(shutdownRequest('req-2', 'orch-evaluator-1-abc')) +
          line(shutdownResponse('req-2', 'orch-evaluator-1-abc')),
      );

      const afterReload = projectDelegationLedger(logPath);
      expect(afterReload[0].active).toBe(false);
      // Task and report are still retrievable.
      expect(afterReload[0].task).toBe('review');
      expect(afterReload[0].reports[0].payload).toBe('done');
    });
  });

  describe('derivation from channel (not a separate writer)', () => {
    it('the hand-off text comes directly from the delegation-request payload on the log (no separate store)', () => {
      // Write raw JSONL as if the FileChannel produced it — no delegation manager
      // or any other machinery involved. The projection must read this and surface
      // the task verbatim.
      const rawLog =
        `${JSON.stringify({ from: 'orch-delegate', role: 'executor', type: DELEGATION_REQUEST, payload: { requestId: 'r1', action: 'spawn', role: 'evaluator', task: 'the exact task text from the channel' } })}\n` +
        `${JSON.stringify({ from: 'orch-delegation-host', role: 'planner', type: DELEGATION_RESPONSE, payload: { requestId: 'r1', delegateId: 'delegate-123' } })}\n`;
      writeFileSync(logPath, rawLog);

      const entries = projectDelegationLedger(logPath);

      // The projected task is exactly what was in the payload — no transformation.
      expect(entries[0].task).toBe('the exact task text from the channel');
    });
  });
});
