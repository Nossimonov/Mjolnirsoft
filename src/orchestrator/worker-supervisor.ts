import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MessageHandler, Participant } from '../core/channel.ts';
import type { SessionBackend } from '../core/session-store.ts';
import { createSessionStore } from '../core/create-session-store.ts';
import { loadProjectConfig } from '../core/project-config.ts';

export type WorkerState = 'running' | 'exited';

/** A spawned child process, reduced to what the supervisor needs. */
export interface ChildHandle {
  /** Terminate the process. */
  kill(): void;
  /** Register the single supervisor listener invoked when the process exits. */
  onExit(listener: (code: number | null) => void): void;
}

/** Launches a worker process on a session (by id). Injectable for tests. */
export type Launcher = (sessionId: string, id: string) => ChildHandle;

export interface SpawnWorkerOptions {
  readonly id: string;
  readonly sessionId: string;
  /** Orchestrator's participant id on the session (default 'orchestrator'). */
  readonly orchestratorId?: string;
  /** Receives messages the worker sends on the session channel. */
  readonly onMessage?: MessageHandler;
  /** Session backend resolving the id to a channel (default: mounted from the project config). */
  readonly store?: SessionBackend;
  /** Override how the worker process is launched (tests inject a fake). */
  readonly launch?: Launcher;
}

export interface WorkerHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly state: WorkerState;
  /** The orchestrator's participant on the worker's session channel (planner role). */
  readonly orchestrator: Participant;
  /** Stop the worker process. The session transcript persists. */
  stop(): void;
  /** Notified when the worker process exits. */
  onExit(listener: (code: number | null) => void): void;
}

const WORKER_ENTRY = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/**
 * Default launcher: spawn the worker CLI as a Node child process. stdin is
 * piped and left open so the worker keeps tailing until it is stopped; stdout
 * and stderr are inherited so the worker's output is visible.
 */
export const spawnWorkerCli: Launcher = (sessionId, id) => {
  const child = spawn(process.execPath, [WORKER_ENTRY, 'worker', id, '--session', sessionId, '--auto'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return {
    kill: () => child.kill(),
    onExit: (listener) => child.on('exit', listener),
  };
};

/**
 * Spawn a worker bound to a per-session log and return a handle that reports
 * its lifecycle and lets the orchestrator participate on its channel. The
 * session log (the durable transcript) outlives the process.
 */
export function spawnWorker(options: SpawnWorkerOptions): WorkerHandle {
  const { id, sessionId, orchestratorId = 'orchestrator', onMessage, store = createSessionStore(loadProjectConfig()), launch = spawnWorkerCli } = options;

  const channel = store.open(sessionId);
  const orchestrator = channel.join(orchestratorId, 'planner', onMessage ?? (() => {}));

  let state: WorkerState = 'running';
  const exitListeners: Array<(code: number | null) => void> = [];

  const child = launch(sessionId, id);
  child.onExit((code) => {
    state = 'exited';
    orchestrator.close();
    for (const listener of exitListeners) listener(code);
  });

  return {
    id,
    sessionId,
    orchestrator,
    get state() {
      return state;
    },
    stop: () => child.kill(),
    onExit: (listener) => exitListeners.push(listener),
  };
}
