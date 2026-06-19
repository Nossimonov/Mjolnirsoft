import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './create-session-store.ts';
import { loadProjectConfig } from './project-config.ts';
import { SessionStore } from './session-store.ts';

describe('createSessionStore', () => {
  it('mounts the local file-backed store for backend "local"', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'mjolnir-factory-'));
    const store = createSessionStore({ storage: { backend: 'local' } }, { baseDir });
    expect(store).toBeInstanceOf(SessionStore);
    store.open('s1'); // creates the session log under baseDir
    expect(store.list()).toEqual(['s1']);
  });

  it('throws an actionable error on an unknown backend', () => {
    expect(() => createSessionStore({ storage: { backend: 'nope' } }))
      .toThrow(/unknown storage backend: "nope" \(supported: local\)/);
  });

  it('round-trips a loaded local config into a working store (AC: local unchanged)', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'mjolnir-rt-cfg-'));
    writeFileSync(join(cfgDir, 'mjolnir.config.json'), '{ "storage": { "backend": "local" } }');
    const baseDir = mkdtempSync(join(tmpdir(), 'mjolnir-rt-store-'));

    const store = createSessionStore(loadProjectConfig(join(cfgDir, 'mjolnir.config.json')), { baseDir });

    expect(store).toBeInstanceOf(SessionStore);
    store.open('s2'); // creates the session log under baseDir
    expect(store.list()).toEqual(['s2']);
  });
});
