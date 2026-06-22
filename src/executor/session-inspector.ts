import { readFileSync } from 'node:fs';
import type { Message } from '../core/channel.ts';
import { isAgentRole, type AgentRole } from '../core/agent-instructions.ts';
import { USAGE_MESSAGE, addUsage, ZERO_USAGE, type Usage } from './claude-code-responder.ts';
import { COMPACTION_GENERATION, type CompactionGenerationPayload } from '../core/compaction-protocol.ts';

/** Metadata recovered from a session's durable log for a resume or reattach. */
export interface SessionMetadata {
  /** The agent role, read from the session's own agent seat. Absent if not yet started. */
  readonly role?: AgentRole;
  /**
   * All-time accumulated token usage across every compaction generation (#116/#9).
   * Use this to seed the header "cost so far" meter so the tally never resets on
   * compaction.
   */
  readonly lifetimeUsage: Usage;
  /**
   * The raw token usage from the **most recent turn in the current compaction
   * generation** (#9). The sum of `inputTokens + cacheReadTokens +
   * cacheCreationTokens` gives the context-window occupancy for that turn — a
   * per-turn snapshot, not a running total. `undefined` when the current generation
   * has no completed turns yet (fresh start or immediately post-compaction).
   * Used to seed the context-note snapshot on a VS Code reload so the first
   * post-reload turn shows a meaningful context size.
   */
  readonly lastTurnUsage: Usage | undefined;
  /**
   * The current compaction generation (#165). 0 = the original pre-compaction session
   * (uses `claudeSessionIdFor(sessionId)`). N > 0 = the Nth compacted conversation
   * (uses `claudeSessionIdFor(sessionId + ':' + N)`). Read from the latest
   * COMPACTION_GENERATION message in the log.
   */
  readonly generation: number;
}

/**
 * Recover from a session's durable log what the in-host registry lost on a reload
 * (#126): the agent's role (so a resume re-provisions it as the right kind of agent),
 * its own usage so far (so the resumed meter continues), and the current compaction
 * generation (#165) (so a reload after a compaction resumes the correct claude
 * conversation, not the pre-compaction one). One pass over the JSONL.
 * Missing/unreadable log → zero values.
 */
export function inspectSession(logPath: string, sessionId: string): SessionMetadata {
  const agentSeat = `${sessionId}-executor`;
  let lifetimeUsage = ZERO_USAGE;           // all-time sum; never resets
  let lastTurnUsage: Usage | undefined;     // last turn in current generation; resets at compaction
  let role: AgentRole | undefined;
  let generation = 0;
  let lines: string[];
  try {
    lines = readFileSync(logPath, 'utf8').split('\n');
  } catch {
    return { lifetimeUsage, lastTurnUsage, generation };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    if (msg.type === USAGE_MESSAGE) {
      const delta = msg.payload as Usage;
      lifetimeUsage = addUsage(lifetimeUsage, delta);
      lastTurnUsage = delta; // keep only the most recent (#9: snapshot, not cumulative)
    }
    // Role and compaction-generation checks are independent (not else-if) so a message
    // that matches both by coincidence — e.g. a COMPACTION_GENERATION sent from the
    // executor seat — is dispatched to each branch that applies, not just the first.
    if (!role && msg.from === agentSeat && isAgentRole(msg.role)) {
      role = msg.role;
    }
    if (msg.type === COMPACTION_GENERATION) {
      const payload = msg.payload as CompactionGenerationPayload | undefined;
      if (typeof payload?.generation === 'number') {
        generation = payload.generation;
        lastTurnUsage = undefined; // new conversation; no prior turns in this generation (#9)
      }
    }
  }
  return { role, lifetimeUsage, lastTurnUsage, generation };
}

/**
 * Derive the stable `claude --session-id` for an orchestrator at a given compaction
 * generation (#165). Generation 0 is backward-compatible with the pre-compaction id
 * (derived from the plain session id). Generation N > 0 uses a generation-suffixed
 * key so the new session is a blank context, distinct from the old one.
 */
export function orchestratorSessionKey(sessionId: string, generation: number): string {
  return generation > 0 ? `${sessionId}:${generation}` : sessionId;
}
