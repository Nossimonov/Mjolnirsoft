import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWorker, type ChildHandle, type Launcher } from './worker-supervisor.ts';
import { SessionStore } from '../core/session-store.ts';

/** A fake child process: kill() triggers exit, as a real OS process would. */
function fakeLauncher() {
  let exitListener: ((code: number | null) => void) | undefined;
  let killed = false;
  const handle: ChildHandle = {
    kill: () => {
      killed = true;
      exitListener?.(0);
    },
    onExit: (listener) => {
      exitListener = listener;
    },
  };
  const launch: Launcher = () => handle;
  return { launch, killed: () => killed, exit: (code: number | null) => exitListener?.(code) };
}

describe('spawnWorker', () => {
  let baseDir: string;
  let store: SessionStore;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'mjolnir-supervisor-'));
    store = new SessionStore({ baseDir });
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('spawns a worker on a session and reports running (AC1/AC2)', () => {
    const { launch } = fakeLauncher();
    const worker = spawnWorker({ id: 'worker-1', sessionId: 's1', store, launch });
    expect(worker.id).toBe('worker-1');
    expect(worker.sessionId).toBe('s1');
    expect(worker.state).toBe('running');
  });

  it('reports exited and notifies listeners when the process exits (AC2)', () => {
    const fake = fakeLauncher();
    const worker = spawnWorker({ id: 'worker-1', sessionId: 's1', store, launch: fake.launch });
    let exitCode: number | null | undefined;
    worker.onExit((code) => {
      exitCode = code;
    });

    fake.exit(0);

    expect(worker.state).toBe('exited');
    expect(exitCode).toBe(0);
  });

  it('stops the worker (AC2) and the session transcript persists (AC3)', () => {
    const fake = fakeLauncher();
    const worker = spawnWorker({ id: 'worker-1', sessionId: 's1', store, launch: fake.launch });
    worker.orchestrator.send({ type: 'text', payload: 'do #88' });

    worker.stop();

    expect(fake.killed()).toBe(true);
    expect(worker.state).toBe('exited');
    expect(existsSync(join(baseDir, 's1.jsonl'))).toBe(true);
    expect(readFileSync(join(baseDir, 's1.jsonl'), 'utf8')).toContain('do #88');
  });

  it('lets the orchestrator send on the worker session channel (AC4)', () => {
    const { launch } = fakeLauncher();
    const worker = spawnWorker({ id: 'worker-1', sessionId: 's1', store, launch });

    worker.orchestrator.send({ type: 'text', payload: 'implement the login form' });

    const transcript = readFileSync(join(baseDir, 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(transcript).toEqual([{ from: 'orchestrator', type: 'text', payload: 'implement the login form' }]);
  });
});
