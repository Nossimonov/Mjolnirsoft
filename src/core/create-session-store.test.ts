import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './create-session-store.ts';
import { loadProjectConfig, DEFAULT_PROJECT_CONFIG } from './project-config.ts';
import { SessionStore } from './session-store.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('createSessionStore', () => {
  it('mounts the local file-backed store for backend "local"', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'mjolnir-factory-'));
    tempDirs.push(baseDir);
    const store = createSessionStore({ ...DEFAULT_PROJECT_CONFIG, storage: { backend: 'local' } }, { baseDir });
    expect(store).toBeInstanceOf(SessionStore);
    store.open('s1'); // creates the session log under baseDir
    expect(store.list()).toEqual(['s1']);
  });

  it('throws an actionable error on an unknown backend', () => {
    expect(() => createSessionStore({ ...DEFAULT_PROJECT_CONFIG, storage: { backend: 'nope' } }))
      .toThrow(/unknown storage backend: "nope" \(supported: local, git\)/);
  });

  it('round-trips a loaded local config into a working store (AC: local unchanged)', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'mjolnir-rt-cfg-'));
    tempDirs.push(cfgDir);
    writeFileSync(join(cfgDir, 'mjolnir.config.json'), '{ "storage": { "backend": "local" } }');
    const baseDir = mkdtempSync(join(tmpdir(), 'mjolnir-rt-store-'));
    tempDirs.push(baseDir);

    const store = createSessionStore(loadProjectConfig(join(cfgDir, 'mjolnir.config.json')), { baseDir });

    expect(store).toBeInstanceOf(SessionStore);
    store.open('s2'); // creates the session log under baseDir
    expect(store.list()).toEqual(['s2']);
  });
});
