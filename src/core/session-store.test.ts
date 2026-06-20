import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store.ts';

describe('SessionStore', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'mjolnir-store-'));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('opens a channel by id whose messages persist under that session (file hidden)', () => {
    const store = new SessionStore({ baseDir });
    const channel = store.open('executor-1');
    channel.join('planner-1', 'planner', () => {}).send({ type: 'text', payload: 'hi' });

    const logged = readFileSync(join(baseDir, 'executor-1.jsonl'), 'utf8');
    expect(logged).toContain('"from":"planner-1"');
    expect(logged).toContain('"payload":"hi"');
  });

  it('lists existing session ids', () => {
    const store = new SessionStore({ baseDir });
    store.open('alpha');
    store.open('beta');
    expect(store.list().sort()).toEqual(['alpha', 'beta']);
  });

  it('returns no sessions before any are opened', () => {
    expect(new SessionStore({ baseDir }).list()).toEqual([]);
  });

  it('rejects session ids that could escape the directory', () => {
    const store = new SessionStore({ baseDir });
    expect(() => store.open('../evil')).toThrow(/invalid session id/);
    expect(() => store.open('a/b')).toThrow(/invalid session id/);
    expect(() => store.open('a\\b')).toThrow(/invalid session id/);
    expect(existsSync(join(baseDir, '..', 'evil.jsonl'))).toBe(false);
  });
});
