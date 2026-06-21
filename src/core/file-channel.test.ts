import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChannel } from './file-channel.ts';
import type { Message } from './channel.ts';

// A large interval keeps the auto-poll timer from firing, so tests drive
// delivery deterministically by calling poll() themselves.
const MANUAL = { pollIntervalMs: 1_000_000 };

describe('FileChannel', () => {
  let dir: string;
  let logPath: string;
  const open: FileChannel[] = [];

  const channel = (): FileChannel => {
    const c = new FileChannel(logPath, MANUAL);
    open.push(c);
    return c;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mjolnir-filechan-'));
    logPath = join(dir, 'session.jsonl');
  });

  afterEach(() => {
    for (const c of open.splice(0)) c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers a message from one channel instance to another via the log (AC1/AC3)', () => {
    const a = channel();
    const b = channel();
    const inbox: Message[] = [];
    const planner = a.join('planner-1', 'planner', () => {});
    b.join('executor-1', 'executor', (m) => inbox.push(m));

    planner.send({ type: 'text', payload: 'do it' });
    b.poll();

    expect(inbox).toEqual([{ from: 'planner-1', role: 'planner', type: 'text', payload: 'do it' }]);
  });

  it('writes a faithful, replayable transcript to the log (AC2)', () => {
    const planner = channel().join('planner-1', 'planner', () => {});
    planner.send({ type: 'text', payload: 'one' });
    planner.send({ type: 'task', payload: { n: 2 } });

    const transcript = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(transcript).toEqual([
      { from: 'planner-1', role: 'planner', type: 'text', payload: 'one' },
      { from: 'planner-1', role: 'planner', type: 'task', payload: { n: 2 } },
    ]);
  });

  it('does not deliver a participant its own messages', () => {
    const c = channel();
    const inbox: Message[] = [];
    const planner = c.join('planner-1', 'planner', (m) => inbox.push(m));
    planner.send({ type: 'text', payload: 'self' });
    c.poll();
    expect(inbox).toEqual([]);
  });

  it('delivers only messages appended after joining (no replay)', () => {
    writeFileSync(logPath, `${JSON.stringify({ from: 'old', type: 'text', payload: 'history' })}\n`);
    const c = channel();
    const inbox: Message[] = [];
    c.join('executor-1', 'executor', (m) => inbox.push(m));
    c.poll();
    expect(inbox).toEqual([]);
  });

  it('replays existing history to a joiner, then streams live (AC1)', () => {
    // Seed a prior transcript before anyone attaches.
    writeFileSync(
      logPath,
      `${JSON.stringify({ from: 'orchestrator', type: 'text', payload: 'do #88' })}\n` +
        `${JSON.stringify({ from: 'executor-1', type: 'text', payload: 'on it' })}\n`,
    );

    const attached = new FileChannel(logPath, { ...MANUAL, replay: true });
    open.push(attached);
    const inbox: Message[] = [];
    attached.join('observer', 'planner', (m) => inbox.push(m));
    attached.poll(); // delivers the replayed history

    expect(inbox).toEqual([
      { from: 'orchestrator', type: 'text', payload: 'do #88' },
      { from: 'executor-1', type: 'text', payload: 'on it' },
    ]);

    // A live message appended after attaching is also delivered.
    const live = channel();
    live.join('boss', 'planner', () => {}).send({ type: 'text', payload: 'and write tests' });
    attached.poll();
    expect(inbox).toContainEqual({ from: 'boss', role: 'planner', type: 'text', payload: 'and write tests' });
  });

  it('replays a participant its OWN history, but never echoes its own live sends (#126)', () => {
    // A window's prior turns are authored by `vscode-view`; on re-attach it rejoins
    // under the same id, so replaying must include those — or the architect's own side
    // of the conversation vanishes on reload. Live, its own sends are still not echoed
    // back (the panel renders those locally).
    writeFileSync(
      logPath,
      `${JSON.stringify({ from: 'vscode-view', role: 'planner', type: 'text', payload: 'my earlier message' })}\n` +
        `${JSON.stringify({ from: 'agent', role: 'executor', type: 'result', payload: 'my reply' })}\n`,
    );

    const attached = new FileChannel(logPath, { ...MANUAL, replay: true });
    open.push(attached);
    const inbox: Message[] = [];
    const view = attached.join('vscode-view', 'planner', (m) => inbox.push(m));
    attached.poll(); // replay

    // Both the participant's own past turn AND the agent's reply come back on re-attach.
    expect(inbox).toEqual([
      { from: 'vscode-view', role: 'planner', type: 'text', payload: 'my earlier message' },
      { from: 'agent', role: 'executor', type: 'result', payload: 'my reply' },
    ]);

    // A live send by this same participant is NOT delivered back to it (no echo dupe).
    inbox.length = 0;
    view.send({ type: 'text', payload: 'a new message' });
    attached.poll();
    expect(inbox).toEqual([]);
  });

  it('rejects joining with a duplicate participant id', () => {
    const c = channel();
    c.join('dup', 'planner', () => {});
    expect(() => c.join('dup', 'executor', () => {})).toThrow(/already joined/);
  });
});
