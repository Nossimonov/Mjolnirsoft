import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MessageHandler, Participant } from '../core/channel.ts';
import type { SessionBackend } from '../core/session-store.ts';
import { createSessionStore } from '../core/create-session-store.ts';
import { loadProjectConfig } from '../core/project-config.ts';

export type ExecutorState = 'running' | 'exited';

/** A spawned child process, reduced to what the supervisor needs. */
export interface ChildHandle {
  /** Terminate the process. */
  kill(): void;
  /** Register the single supervisor listener invoked when the process exits. */
  onExit(listener: (code: number | null) => void): void;
}

/** Launches an executor process on a session (by id). Injectable for tests. */
export type Launcher = (sessionId: string, id: string) => ChildHandle;

export interface SpawnExecutorOptions {
  readonly id: string;
  readonly sessionId: string;
  /** Orchestrator's participant id on the session (default 'orchestrator'). */
  readonly orchestratorId?: string;
  /** Receives messages the executor sends on the session channel. */
  readonly onMessage?: MessageHandler;
  /** Session backend resolving the id to a channel (default: mounted from the project config). */
  readonly store?: SessionBackend;
  /** Override how the executor process is launched (tests inject a fake). */
  readonly launch?: Launcher;
}

export interface ExecutorHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly state: ExecutorState;
  /** The orchestrator's participant on the executor's session channel (planner role). */
  readonly orchestrator: Participant;
  /** Stop the executor process. The session transcript persists. */
  stop(): void;
  /** Notified when the executor process exits. */
  onExit(listener: (code: number | null) => void): void;
}

const EXECUTOR_ENTRY = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/**
 * Default launcher: spawn the executor CLI as a Node child process. stdin is
 * piped and left open so the executor keeps tailing until it is stopped; stdout
 * and stderr are inherited so the executor's output is visible.
 */
export const spawnExecutorCli: Launcher = (sessionId, id) => {
  const child = spawn(process.execPath, [EXECUTOR_ENTRY, 'executor', id, '--session', sessionId, '--auto'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return {
    kill: () => child.kill(),
    onExit: (listener) => child.on('exit', listener),
  };
};

/**
 * Spawn an executor bound to a per-session log and return a handle that reports
 * its lifecycle and lets the orchestrator participate on its channel. The
 * session log (the durable transcript) outlives the process.
 */
export function spawnExecutor(options: SpawnExecutorOptions): ExecutorHandle {
  const { id, sessionId, orchestratorId = 'orchestrator', onMessage, store = createSessionStore(loadProjectConfig()), launch = spawnExecutorCli } = options;

  const channel = store.open(sessionId);
  const orchestrator = channel.join(orchestratorId, 'planner', onMessage ?? (() => {}));

  let state: ExecutorState = 'running';
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
