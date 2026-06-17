import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const setupScript = fileURLToPath(new URL('../setup.sh', import.meta.url));

function hasBash(): boolean {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function runSetup(root: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [setupScript], {
    encoding: 'utf8',
    env: { ...process.env, SETUP_ROOT: root, ...env },
  });
}

// setup.sh is a POSIX shell script. On Windows the `bash` resolved at runtime
// is ambiguous (Git Bash vs WSL use different drive-mount conventions), so we
// run these against POSIX shells only — CI (Linux) is the source of truth for
// this feature. On a Windows dev box they skip rather than give false signal.
const canRun = process.platform !== 'win32' && hasBash();

describe.skipIf(!canRun)('setup.sh', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mjolnir-setup-'));
    writeFileSync(join(root, '.local.env.example'), 'EXAMPLE=1\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates .local.env from the template when absent (AC3)', () => {
    const r = runSetup(root, { SETUP_DRY_RUN: '1' });
    expect(r.status).toBe(0);
    const localEnv = join(root, '.local.env');
    expect(existsSync(localEnv)).toBe(true);
    expect(readFileSync(localEnv, 'utf8')).toBe('EXAMPLE=1\n');
  });

  it('does not overwrite an existing .local.env (AC3, idempotent)', () => {
    writeFileSync(join(root, '.local.env'), 'KEEP=me\n');
    const r = runSetup(root, { SETUP_DRY_RUN: '1' });
    expect(r.status).toBe(0);
    expect(readFileSync(join(root, '.local.env'), 'utf8')).toBe('KEEP=me\n');
  });

  it('selects `npm ci` when a lockfile is present (AC2)', () => {
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const r = runSetup(root, { SETUP_DRY_RUN: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('npm ci');
  });

  it('fails with actionable guidance when a dependency is missing (AC1)', () => {
    const r = runSetup(root, { SETUP_PRETEND_MISSING: 'node' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('node');
    expect(r.stderr).toContain('nodejs.org');
  });
});
