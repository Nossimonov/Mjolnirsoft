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
import { outOfWorktreeWriteDenial } from './worktree-confinement.ts';
import type { PermissionBridge } from './permission-bridge.ts';

export interface ApproveDeps {
  /**
   * Project root holding the learned "Always" rules. Undefined disables
   * auto-allow entirely — every request escalates — so a misconfigured server
   * fails safe (toward asking) rather than silently auto-approving.
   */
  readonly projectDir?: string;
  /**
   * The executor's worktree path — the confinement boundary (#101). A write whose
   * target resolves outside it is auto-denied *before* any auto-allow/escalation,
   * so the human is never asked and no learned rule can unlock it. Undefined
   * disables the guardrail (requests escalate as before), so a misconfigured
   * server still fails toward asking rather than silently denying.
   */
  readonly worktreePath?: string;
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
  // Hard worktree guardrail first (#101): an out-of-worktree write is denied here,
  // before auto-allow or escalation, so the human is never prompted and a learned
  // "Always" rule (#70) can never unlock it.
  const denial = outOfWorktreeWriteDenial(toolName, input, deps.worktreePath);
  if (denial) {
    deps.postAudit(`auto-denied (outside worktree): ${toolName}`);
    return { behavior: 'deny', message: denial };
  }
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
