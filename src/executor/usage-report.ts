import type { Message } from '../core/channel.ts';
import { USAGE_MESSAGE, addUsage, ZERO_USAGE, weightedUsage, type Usage } from './claude-code-responder.ts';

/**
 * Pure analysis over a session log's JSONL (#233): turn a log into weighted
 * per-turn usage, totals, and a per-kind weighted breakdown — the post-hoc
 * counterpart to the live per-turn meter (#116) and the in-product weighted
 * figure (#133). It deliberately **reuses {@link weightedUsage}**, the one
 * canonical weighting, so this CLI and the panel can never report different
 * numbers. I/O lives in the CLI (`src/cli/usage.ts`); everything here is pure
 * and unit-tested directly against fixture lines.
 */

/** One turn's usage with its weighted value and the message that preceded it. */
export interface TurnUsage {
  readonly usage: Usage;
  readonly weighted: number;
  /** The last conversational message before this turn's usage — a label for "what this turn was". */
  readonly context?: { readonly type: string; readonly role: string; readonly text: string };
}

/** Message types that label a turn (the thing the orchestrator/executor was reacting to or produced). */
const CONTEXT_TYPES = new Set(['text', 'result', 'delegation-request', 'error']);

/**
 * Parse a session log's turns from its JSONL `lines`. Each {@link USAGE_MESSAGE}
 * becomes one {@link TurnUsage}, tagged with the most recent conversational
 * message before it. With `anchor`, only the anchor line and everything after it
 * is considered; returns `null` when the anchor is given but never found, so the
 * caller can say "anchor not in this file" rather than silently reporting zero.
 */
export function parseTurns(lines: readonly string[], anchor?: string): TurnUsage[] | null {
  let started = anchor === undefined;
  const turns: TurnUsage[] = [];
  let pendingContext: TurnUsage['context'];
  for (const raw of lines) {
    if (!started) {
      if (raw.includes(anchor as string)) started = true; // include the anchor line onward
      else continue;
    }
    const line = raw.trim();
    if (!line) continue;
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    if (CONTEXT_TYPES.has(msg.type)) {
      const text = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
      pendingContext = { type: msg.type, role: String(msg.role), text };
    }
    if (msg.type === USAGE_MESSAGE) {
      const usage = msg.payload as Usage;
      turns.push({ usage, weighted: weightedUsage(usage), context: pendingContext });
      pendingContext = undefined;
    }
  }
  return started ? turns : null;
}

/** Field-wise sum of every turn's raw usage. */
export function sumTurns(turns: readonly TurnUsage[]): Usage {
  return turns.reduce((acc, t) => addUsage(acc, t.usage), ZERO_USAGE);
}

/** Per-kind weighted contribution of a usage tally, using the canonical {@link weightedUsage} weights. */
export interface WeightedByKind {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly total: number;
}

/**
 * Split a usage tally into its weighted contribution per kind. Each kind is
 * weighted by running {@link weightedUsage} over a single-field tally, so the
 * weights are never duplicated here — there is exactly one source of truth.
 */
export function weightedByKind(u: Usage): WeightedByKind {
  const only = (field: keyof Usage): number => weightedUsage({ ...ZERO_USAGE, [field]: u[field] });
  const input = only('inputTokens');
  const output = only('outputTokens');
  const cacheRead = only('cacheReadTokens');
  const cacheCreation = only('cacheCreationTokens');
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}
