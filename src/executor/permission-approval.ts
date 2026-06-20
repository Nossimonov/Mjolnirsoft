/**
 * The approve-tool decision (#66 escalation + #70 "Always" auto-allow).
 *
 * Extracted from `permission-mcp-server.ts` so the branch the server runs on
 * every `approve` call — auto-allow a remembered request, otherwise escalate to
 * the human — is unit-testable without standing up the stdio MCP server (which
 * exits on import when its env isn't set). The server is the thin wiring; this is
 * the logic.
 */
import { matchesLearnedRule } from '../core/learned-permissions.ts';
import { decisionToVerdict, type InteractionRequest, type PermissionVerdict } from '../core/interaction.ts';
import type { PermissionBridge } from './permission-bridge.ts';

export interface ApproveDeps {
  /**
   * Project root holding the learned "Always" rules. Undefined disables
   * auto-allow entirely — every request escalates — so a misconfigured server
   * fails safe (toward asking) rather than silently auto-approving.
   */
  readonly projectDir?: string;
  /** Escalate a non-remembered request to the human and await their decision. */
  readonly bridge: Pick<PermissionBridge, 'request'>;
  /**
   * Post a line to the session transcript when a remembered rule auto-allows, so
   * the channel stays a complete record of what ran (the human sees no prompt).
   */
  readonly postAudit: (text: string) => void;
  /** Learned-rule lookup; injectable for tests, defaults to the on-disk matcher. */
  readonly matchRule?: (projectDir: string, toolName: string, input: unknown) => string | undefined;
}

/**
 * Resolve one `approve` call into the verdict Claude's permission-prompt tool
 * returns. If the request matches a persisted "Always" rule, allow it
 * immediately (echoing the input back unchanged) and note it in the transcript;
 * otherwise escalate over the bridge and map the human's decision to a verdict.
 */
export async function approveToolUse(
  deps: ApproveDeps,
  toolName: string,
  input: unknown,
  toolUseId?: string,
): Promise<PermissionVerdict> {
  const match = deps.projectDir
    ? (deps.matchRule ?? matchesLearnedRule)(deps.projectDir, toolName, input)
    : undefined;
  if (match) {
    deps.postAudit(`auto-allowed (remembered): ${match}`);
    return { behavior: 'allow', updatedInput: input };
  }
  const decision = await deps.bridge.request(toolName, input, toolUseId);
  const request: InteractionRequest = { requestId: decision.requestId, toolName, input, toolUseId };
  return decisionToVerdict(request, decision);
}
