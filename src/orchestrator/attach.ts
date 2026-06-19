import type { WorkerHandle } from './worker-supervisor.ts';

export interface AttachInvitation {
  readonly workerId: string;
  readonly sessionId: string;
  /** Command the user runs to open a `--replay` window onto the worker's session. */
  readonly command: string;
}

/**
 * Produce what a user needs to engage with a worker the orchestrator spawned:
 * the session id and the attach command. The user joins as a planner
 * (co-prompter) with replay, addressing the session by id — no file path. The
 * richer auto-opened surface is the VS Code view (tracked separately).
 */
export function attachInvitation(
  worker: Pick<WorkerHandle, 'id' | 'sessionId'>,
  userId = 'user',
): AttachInvitation {
  return {
    workerId: worker.id,
    sessionId: worker.sessionId,
    command: `npm run session -- planner ${userId} --session ${worker.sessionId} --replay`,
  };
}
