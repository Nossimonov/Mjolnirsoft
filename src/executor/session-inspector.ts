import { readFileSync } from 'node:fs';
import type { Message } from '../core/channel.ts';
import { isAgentRole, type AgentRole } from '../core/agent-instructions.ts';
import { USAGE_MESSAGE, addUsage, ZERO_USAGE, type Usage } from './claude-code-responder.ts';

/** Metadata recovered from a session's durable log for a resume or reattach. */
export interface SessionMetadata {
  /** The agent role, read from the session's own agent seat. Absent if not yet started. */
  readonly role?: AgentRole;
  /**
   * All-time accumulated token usage across the session's lifetime (#116).
   * Use this to seed the header "cost so far" meter so the tally continues across reloads.
   */
  readonly lifetimeUsage: Usage;
}

/**
 * Recover from a session's durable log what the in-host registry lost on a reload
 * (#126): the agent's role (so a resume re-provisions it as the right kind of agent)
 * and its own usage so far (so the resumed meter continues). One pass over the JSONL.
 * Missing/unreadable log → zero values.
 */
export function inspectSession(logPath: string, sessionId: string): SessionMetadata {
  const agentSeat = `${sessionId}-executor`;
  let lifetimeUsage = ZERO_USAGE;
  let role: AgentRole | undefined;
  let lines: string[];
  try {
    lines = readFileSync(logPath, 'utf8').split('\n');
  } catch {
    return { lifetimeUsage };
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
      lifetimeUsage = addUsage(lifetimeUsage, msg.payload as Usage);
    }
    if (!role && msg.from === agentSeat && isAgentRole(msg.role)) {
      role = msg.role;
    }
  }
  return { role, lifetimeUsage };
}
