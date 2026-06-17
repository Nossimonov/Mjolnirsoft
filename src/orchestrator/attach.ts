import type { WorkerHandle } from './worker-supervisor.ts';

export interface AttachInvitation {
  readonly workerId: string;
  readonly sessionLog: string;
  /** Command the user runs to open a `--replay` window onto the worker's session. */
  readonly command: string;
}

/**
 * Produce the handle a user needs to open a window onto a worker the orchestrator
 * spawned: the session log and the attach command. The user joins as a planner
 * (co-prompter) with replay, so they see the conversation so far and can give
 * feedback or corrections. The orchestrator surfaces this; the user opens the
 * window when they choose (a richer auto-opened surface is tracked in #25).
 */
export function attachInvitation(
  worker: Pick<WorkerHandle, 'id' | 'logPath'>,
  userId = 'user',
): AttachInvitation {
  return {
    workerId: worker.id,
    sessionLog: worker.logPath,
    command: `npm run session -- planner ${userId} --log "${worker.logPath}" --replay`,
  };
}
