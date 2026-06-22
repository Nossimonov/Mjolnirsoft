/**
 * Delegation ledger (#168): a projection over the durable channel JSONL that
 * yields, per delegate id, the original hand-off task and any bridged-back
 * reports — keyed for on-demand retrieval without in-context memory.
 *
 * Two tiers, both derived from the channel:
 *  - Active delegations: those spawned but not yet shut down (the acute case
 *    after a compaction or reload — the orchestrator re-projects from the same
 *    durable file and recovers the full picture).
 *  - Historical record: every delegation ever spawned on the session, keyed by
 *    delegate id and searchable by task text (e.g. an issue number like #168).
 *
 * The ledger is a pure read of the JSONL; it never writes a separate record, so
 * it cannot drift from what was actually sent over the channel.
 */
import { readFileSync } from 'node:fs';
import type { Message } from '../core/channel.ts';
import {
  DELEGATION_REQUEST,
  DELEGATION_RESPONSE,
  type DelegationRequest,
  type DelegationResponse,
} from '../core/delegation-protocol.ts';
import { deliversToAgent } from './executor-runtime.ts';

/** A single bridged report — the result, text, or error a delegate sent back. */
export interface DelegationReport {
  readonly type: string;
  readonly payload: unknown;
}

/** One delegation's full record as projected from the channel log. */
export interface DelegationEntry {
  /** The delegate id assigned by the host on spawn. */
  readonly delegateId: string;
  /** The delegate's role (e.g. "evaluator", "executor"). */
  readonly role: string;
  /** The original hand-off task text sent to the delegate. */
  readonly task: string;
  /** Bridged-back reports from the delegate, in order of arrival. */
  readonly reports: readonly DelegationReport[];
  /** True while the delegate is live; false after a successful shutdown. */
  readonly active: boolean;
}

/**
 * Read `logPath` and project every delegation spawned on that session.
 * Returns an empty array if the file is absent or unreadable.
 * Safe to call repeatedly on the same log — each call re-reads from disk,
 * so a reattaching orchestrator always recovers the current picture.
 */
export function projectDelegationLedger(logPath: string): DelegationEntry[] {
  let content: string;
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }

  const messages: Message[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      // skip malformed lines
    }
  }

  // Pending spawn requests awaiting their response: requestId → { role, task }
  const pendingSpawns = new Map<string, { role: string; task: string }>();
  // Pending shutdown requests awaiting their response: requestId → delegateId
  const pendingShutdowns = new Map<string, string>();
  // Mutable builders keyed by delegateId; finalised into DelegationEntry at the end.
  const builders = new Map<
    string,
    { delegateId: string; role: string; task: string; reports: DelegationReport[]; active: boolean }
  >();

  for (const msg of messages) {
    if (msg.type === DELEGATION_REQUEST) {
      const req = msg.payload as DelegationRequest | undefined;
      if (!req || typeof req.requestId !== 'string') continue;
      if (req.action === 'spawn') {
        pendingSpawns.set(req.requestId, { role: req.role ?? '', task: req.task ?? '' });
      } else if (req.action === 'shutdown' && req.delegateId) {
        pendingShutdowns.set(req.requestId, req.delegateId);
      }
      continue;
    }

    if (msg.type === DELEGATION_RESPONSE) {
      const res = msg.payload as DelegationResponse | undefined;
      if (!res || typeof res.requestId !== 'string') continue;

      const spawn = pendingSpawns.get(res.requestId);
      if (spawn && res.delegateId && !res.error) {
        pendingSpawns.delete(res.requestId);
        builders.set(res.delegateId, {
          delegateId: res.delegateId,
          role: spawn.role,
          task: spawn.task,
          reports: [],
          active: true,
        });
        continue;
      }

      const shutdownId = pendingShutdowns.get(res.requestId);
      if (shutdownId && !res.error) {
        pendingShutdowns.delete(res.requestId);
        const b = builders.get(shutdownId);
        if (b) b.active = false;
      }
      continue;
    }

    // Any other message from a known delegate that passes the agent-prompt filter
    // is a bridged report (the same gate the delegation manager uses, #116).
    const b = builders.get(msg.from);
    if (b && deliversToAgent(msg)) {
      b.reports.push({ type: msg.type, payload: msg.payload });
    }
  }

  return Array.from(builders.values()).map((b) => ({
    delegateId: b.delegateId,
    role: b.role,
    task: b.task,
    reports: b.reports,
    active: b.active,
  }));
}

/** Return the single entry whose delegateId matches exactly, or `undefined`. */
export function findByDelegateId(entries: DelegationEntry[], id: string): DelegationEntry | undefined {
  return entries.find((e) => e.delegateId === id);
}

/**
 * Return all entries whose task text contains `key` as a case-insensitive
 * substring. Supports searching by issue number ("#168"), a keyword, or any
 * fragment of the original hand-off instruction.
 */
export function findByTaskKey(entries: DelegationEntry[], key: string): DelegationEntry[] {
  const lower = key.toLowerCase();
  return entries.filter((e) => e.task.toLowerCase().includes(lower));
}
