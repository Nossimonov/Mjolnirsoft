/**
 * The structured-interaction layer over the channel (#65).
 *
 * A worker's agent sometimes needs a human decision mid-run: permission for a
 * tool use it isn't pre-allowed to make, or an `AskUserQuestion` clarification.
 * Claude Code surfaces both through one `--permission-prompt-tool` contract —
 * the tool is called with `{ tool_name, input, tool_use_id }` and returns an
 * allow/deny verdict — so we mirror that as one channel vocabulary rather than a
 * type per interaction. An {@link InteractionRequest} carries the request onto
 * the channel; an {@link InteractionDecision} carries the human's answer back.
 * The view dispatches on `toolName`: a permission renders allow/deny, an
 * `AskUserQuestion` (a later rung) renders its choices — same envelope either way.
 */

/** Message `type` for a worker → human request needing a decision. */
export const INTERACTION_REQUEST = 'interaction-request';
/** Message `type` for the human → worker decision answering a request. */
export const INTERACTION_DECISION = 'interaction-decision';

/** An agent-initiated tool request awaiting a human decision. */
export interface InteractionRequest {
  /** Correlates this request with its {@link InteractionDecision}. */
  readonly requestId: string;
  /** The tool Claude wants to use, e.g. `Write`, `Bash`, `AskUserQuestion`. */
  readonly toolName: string;
  /** The tool's input. Shape varies by tool; the view renders/dispatches on it. */
  readonly input: unknown;
  /** Claude's id for the pending tool use, echoed for traceability. */
  readonly toolUseId?: string;
}

/** A human's verdict for an {@link InteractionRequest}. */
export interface InteractionDecision {
  /** The {@link InteractionRequest.requestId} this answers. */
  readonly requestId: string;
  /** Whether the tool use may proceed. */
  readonly behavior: 'allow' | 'deny';
  /** On allow: the (possibly edited) input to run with; omitted means unchanged. */
  readonly updatedInput?: unknown;
  /** On deny: the reason Claude sees (and may adapt to). */
  readonly message?: string;
}

/**
 * The value Claude's `--permission-prompt-tool` must return (serialized as the
 * tool's text content). Verified live against the CLI: allow proceeds with
 * `updatedInput`; deny blocks and surfaces `message`. See #66.
 */
export type PermissionVerdict =
  | { readonly behavior: 'allow'; readonly updatedInput: unknown }
  | { readonly behavior: 'deny'; readonly message: string };

/** Map a human {@link InteractionDecision} to the verdict Claude's tool returns. */
export function decisionToVerdict(request: InteractionRequest, decision: InteractionDecision): PermissionVerdict {
  if (decision.behavior === 'allow') {
    // Echo the original input when the human didn't edit it, so the tool runs as Claude intended.
    return { behavior: 'allow', updatedInput: decision.updatedInput ?? request.input };
  }
  return { behavior: 'deny', message: decision.message ?? 'Denied by the architect.' };
}
