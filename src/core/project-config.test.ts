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
      .toEqual({ storage: { backend: 'git' }, compaction: { thresholdContextPercent: 0.75, idleThresholdSeconds: 210 } });
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

describe('loadProjectConfig — compaction config (#165/#180)', () => {
  it('uses the default threshold when compaction is omitted', () => {
    const cfg = loadProjectConfig(tempConfig('{}'));
    expect(cfg.compaction.thresholdContextPercent).toBe(0.75);
  });

  it('reads a custom threshold percent', () => {
    const cfg = loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": 0.5 } }'));
    expect(cfg.compaction.thresholdContextPercent).toBe(0.5);
  });

  it('defaults the threshold when compaction is present but thresholdContextPercent is absent', () => {
    const cfg = loadProjectConfig(tempConfig('{ "compaction": {} }'));
    expect(cfg.compaction.thresholdContextPercent).toBe(0.75);
  });

  it('throws when compaction is not an object', () => {
    expect(() => loadProjectConfig(tempConfig('{ "compaction": "yes" }')))
      .toThrow(/"compaction" must be an object/);
  });

  it('throws when thresholdContextPercent is not a number', () => {
    expect(() => loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": "big" } }')))
      .toThrow(/must be a number/);
  });

  it('throws when thresholdContextPercent is out of range', () => {
    expect(() => loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": 0 } }')))
      .toThrow(/between 0.*and 1/);
    expect(() => loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": 1.5 } }')))
      .toThrow(/between 0.*and 1/);
    expect(() => loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": -0.1 } }')))
      .toThrow(/between 0.*and 1/);
  });

  it('accepts thresholdContextPercent of exactly 1', () => {
    const cfg = loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": 1 } }'));
    expect(cfg.compaction.thresholdContextPercent).toBe(1);
  });

  it('DEFAULT_PROJECT_CONFIG has the compaction field with the named default', () => {
    expect(DEFAULT_PROJECT_CONFIG.compaction).toBeDefined();
    expect(DEFAULT_PROJECT_CONFIG.compaction.thresholdContextPercent).toBe(0.75);
  });
});

describe('loadProjectConfig — idle compaction config (#167)', () => {
  it('defaults idleThresholdSeconds to 210 when omitted', () => {
    const cfg = loadProjectConfig(tempConfig('{}'));
    expect(cfg.compaction.idleThresholdSeconds).toBe(210);
  });

  it('reads a custom idleThresholdSeconds', () => {
    const cfg = loadProjectConfig(tempConfig('{ "compaction": { "idleThresholdSeconds": 60 } }'));
    expect(cfg.compaction.idleThresholdSeconds).toBe(60);
  });

  it('accepts 0 to disable the idle trigger', () => {
    const cfg = loadProjectConfig(tempConfig('{ "compaction": { "idleThresholdSeconds": 0 } }'));
    expect(cfg.compaction.idleThresholdSeconds).toBe(0);
  });

  it('defaults idleThresholdSeconds when compaction object is present but key is absent', () => {
    const cfg = loadProjectConfig(tempConfig('{ "compaction": { "thresholdContextPercent": 0.8 } }'));
    expect(cfg.compaction.idleThresholdSeconds).toBe(210);
  });

  it('throws when idleThresholdSeconds is not a number', () => {
    expect(() => loadProjectConfig(tempConfig('{ "compaction": { "idleThresholdSeconds": "never" } }')))
      .toThrow(/idleThresholdSeconds must be a number/);
  });

  it('throws when idleThresholdSeconds is negative', () => {
    expect(() => loadProjectConfig(tempConfig('{ "compaction": { "idleThresholdSeconds": -1 } }')))
      .toThrow(/idleThresholdSeconds must be ≥ 0/);
  });

  it('DEFAULT_PROJECT_CONFIG has idleThresholdSeconds of 210', () => {
    expect(DEFAULT_PROJECT_CONFIG.compaction.idleThresholdSeconds).toBe(210);
  });
});
