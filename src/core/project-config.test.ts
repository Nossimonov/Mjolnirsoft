import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig, DEFAULT_PROJECT_CONFIG } from './project-config.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-cfg-'));
  tempDirs.push(dir);
  const path = join(dir, 'mjolnir.config.json');
  writeFileSync(path, contents);
  return path;
}

describe('loadProjectConfig', () => {
  it('defaults to the local backend when no config file exists', () => {
    expect(loadProjectConfig(join(tmpdir(), 'mjolnir-absent-xyz', 'mjolnir.config.json')))
      .toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('reads the declared storage backend', () => {
    expect(loadProjectConfig(tempConfig('{ "storage": { "backend": "git" } }')))
      .toEqual({ storage: { backend: 'git' } });
  });

  it('defaults the backend when storage is omitted', () => {
    expect(loadProjectConfig(tempConfig('{}'))).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('throws on malformed JSON', () => {
    expect(() => loadProjectConfig(tempConfig('{ not json'))).toThrow(/invalid mjolnir\.config\.json/);
  });

  it('throws an actionable error on a non-object top-level config', () => {
    // `null` parses fine but must not crash with a raw TypeError, and a
    // primitive/array must not be silently accepted as the default.
    expect(() => loadProjectConfig(tempConfig('null'))).toThrow(/expected an object, got null/);
    expect(() => loadProjectConfig(tempConfig('42'))).toThrow(/expected an object, got number/);
    expect(() => loadProjectConfig(tempConfig('[]'))).toThrow(/expected an object, got array/);
  });

  it('throws when storage is present but not an object', () => {
    expect(() => loadProjectConfig(tempConfig('{ "storage": "git" }')))
      .toThrow(/"storage" must be an object/);
  });

  it('throws when storage.backend is not a string', () => {
    expect(() => loadProjectConfig(tempConfig('{ "storage": { "backend": 123 } }')))
      .toThrow(/must be a string/);
  });
});
