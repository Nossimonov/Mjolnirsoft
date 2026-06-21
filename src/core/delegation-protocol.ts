/**
 * The delegation-control vocabulary over the channel (#93).
 *
 * Making delegation *live* mirrors the structured-interaction layer (#65/#66):
 * an executor's `claude` invokes an MCP tool (`spawn`/`shutdown`), the MCP server
 * posts a {@link DelegationRequest} onto the session channel, and the host —
 * which owns the `createDelegationManager` (#88) — answers with a
 * {@link DelegationResponse}. The channel is the bridge, exactly as it is for
 * permission prompts: file-backed and cross-process, so the standalone MCP
 * server and the in-host delegation manager meet on the same session log with no
 * extra transport. These are *control* messages (open/close a delegate), distinct
 * from the delegate's *report*, which the manager bridges up as an ordinary
 * attributed message (#86) — so the executor's responder ignores these two types
 * the way it already ignores interaction messages.
 */

/** Message `type` for an executor → host request to open/close a delegate. */
export const DELEGATION_REQUEST = 'delegation-request';
/** Message `type` for the host → executor response answering a request. */
export const DELEGATION_RESPONSE = 'delegation-response';

/** A request from the executor's MCP server to control a delegate. */
export interface DelegationRequest {
  /** Correlates this request with its {@link DelegationResponse}. */
  readonly requestId: string;
  /** `spawn` opens a new delegate; `message` sends a follow-up to a live one; `shutdown` ends one. */
  readonly action: 'spawn' | 'shutdown' | 'message';
  /** On `spawn`: the delegate's role (e.g. `evaluator`). */
  readonly role?: string;
  /** On `spawn`, the opening task; on `message`, the follow-up text — sent to the delegate on its sub-channel. */
  readonly task?: string;
  /** On `shutdown` or `message`: the id of the delegate to address. */
  readonly delegateId?: string;
}

/** The host's answer to a {@link DelegationRequest}. */
export interface DelegationResponse {
  /** The {@link DelegationRequest.requestId} this answers. */
  readonly requestId: string;
  /** On a successful `spawn`: the spawned delegate's id (its sub-channel id). */
  readonly delegateId?: string;
  /** Set when the request could not be honored (e.g. an unknown role). */
  readonly error?: string;
}
