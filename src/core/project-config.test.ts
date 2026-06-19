import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig, DEFAULT_PROJECT_CONFIG } from './project-config.ts';

function tempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-cfg-'));
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

  it('throws when storage.backend is not a string', () => {
    expect(() => loadProjectConfig(tempConfig('{ "storage": { "backend": 123 } }')))
      .toThrow(/must be a string/);
  });
});
