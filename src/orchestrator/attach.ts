import type { ExecutorHandle } from './executor-supervisor.ts';

export interface AttachInvitation {
  readonly executorId: string;
  readonly sessionId: string;
  /** Command the user runs to open a `--replay` window onto the executor's session. */
  readonly command: string;
}

/**
 * Produce what a user needs to engage with an executor the orchestrator spawned:
 * the session id and the attach command. The user joins as a planner
 * (co-prompter) with replay, addressing the session by id — no file path. The
 * richer auto-opened surface is the VS Code view (tracked separately).
 */
export function attachInvitation(
  executor: Pick<ExecutorHandle, 'id' | 'sessionId'>,
  userId = 'user',
): AttachInvitation {
  return {
    executorId: executor.id,
    sessionId: executor.sessionId,
    command: `npm run session -- planner ${userId} --session ${executor.sessionId} --replay`,
  };
}
