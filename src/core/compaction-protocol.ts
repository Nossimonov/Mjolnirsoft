/**
 * The compaction-control vocabulary over the channel (#165).
 *
 * When the orchestrator's context has grown past the configured threshold, it writes
 * a self-hand-off summarising the current goal, recently-integrated tasks, and
 * pointers to primary sources, then calls mcp__compact__request. The compaction MCP
 * server posts a CompactionRequest on the session channel; the host answers with a
 * CompactionResponse, increments the generation counter (persisted via
 * COMPACTION_GENERATION), tears down the old orchestrator session, and relaunches
 * from the hand-off in a fresh claude conversation keyed by the new generation.
 *
 * The COMPACTION_GENERATION message persists the current generation in the session
 * JSONL so inspectSession can recover it after a window reload — ensuring a reload
 * after a compaction resumes the correct generation's claude session, not the
 * pre-compaction one.
 */

/** Message type for an orchestrator → host request to compact the session. */
export const COMPACTION_REQUEST = 'compaction-request';
/** Message type for the host → orchestrator response acknowledging the request. */
export const COMPACTION_RESPONSE = 'compaction-response';
/**
 * Bookkeeping message type persisting the current compaction generation in the
 * session JSONL. Written before each restart so inspectSession recovers the right
 * generation after a window reload, matching the live claude session id.
 */
export const COMPACTION_GENERATION = 'compaction-generation';

/** A request from the orchestrator's compaction MCP server to compact the session. */
export interface CompactionRequest {
  /** Correlates this request with its CompactionResponse. */
  readonly requestId: string;
  /**
   * The self-hand-off the orchestrator composed: current goal, recently-integrated
   * issues/PRs, and pointers to primary sources. The host uses this as the fresh
   * session's first turn, so the restarted orchestrator picks up without drift.
   */
  readonly handoff: string;
}

/** The host's answer to a CompactionRequest. */
export interface CompactionResponse {
  /** The requestId from the matching CompactionRequest. */
  readonly requestId: string;
  /** Set if the host cannot honour the request (e.g. compaction already pending). */
  readonly error?: string;
}

/** Payload for the COMPACTION_GENERATION bookkeeping message. */
export interface CompactionGenerationPayload {
  /** The new generation index, starting at 1 after the first compaction. */
  readonly generation: number;
}
