import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalEnv } from './load-local-env.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-localenv-'));
  tempDirs.push(dir);
  const path = join(dir, '.local.env');
  writeFileSync(path, contents);
  return path;
}

describe('loadLocalEnv', () => {
  const touched: string[] = [];
  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
  });

  it('loads KEY=value lines into process.env, skipping comments and blanks', () => {
    touched.push('MJOLNIR_TEST_A', 'MJOLNIR_TEST_B');
    const path = tempFile('# a comment\n\nMJOLNIR_TEST_A=one\n  MJOLNIR_TEST_B = two \n');
    loadLocalEnv(path);
    expect(process.env.MJOLNIR_TEST_A).toBe('one');
    expect(process.env.MJOLNIR_TEST_B).toBe('two');
  });

  it('does not overwrite an already-set variable', () => {
    touched.push('MJOLNIR_TEST_C');
    process.env.MJOLNIR_TEST_C = 'preset';
    loadLocalEnv(tempFile('MJOLNIR_TEST_C=fromfile\n'));
    expect(process.env.MJOLNIR_TEST_C).toBe('preset');
  });

  it('preserves a Windows absolute path containing backslashes and a colon', () => {
    touched.push('MJOLNIR_TEST_PATH');
    const winPath = 'C:\\Users\\you\\AppData\\Local\\claude.exe';
    loadLocalEnv(tempFile(`MJOLNIR_TEST_PATH=${winPath}\n`));
    expect(process.env.MJOLNIR_TEST_PATH).toBe(winPath);
  });

  it('is silent when the file is absent', () => {
    expect(() => loadLocalEnv(join(tmpdir(), 'mjolnir-does-not-exist-xyz', '.local.env'))).not.toThrow();
  });
});
