import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/file-issue.sh', import.meta.url));

function hasBash(): boolean {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function run(args: string[]) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

// Bash script paths use POSIX conventions; on Windows the mount points diverge
// between Git Bash and WSL so these tests are CI (Linux) authoritative, matching
// the setup.test.ts precedent.
const canRun = process.platform !== 'win32' && hasBash();

describe.skipIf(!canRun)('file-issue.sh guardrails', () => {
  const VALID_ARGS = [
    '--title', 'Test issue',
    '--body', 'As a user I want X so that Y.',
    '--label', 'task',
    '--parent', '198',
  ];

  it('refuses with non-zero exit when --label is missing (AC: no unlabeled issues)', () => {
    const r = run(['--title', 'T', '--body', 'B', '--parent', '1']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--label is required/i);
  });

  it('refuses when an invalid type label is given', () => {
    const r = run(['--title', 'T', '--body', 'B', '--label', 'bogus', '--parent', '1']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a valid type label/i);
    expect(r.stderr).toContain('epic');
    expect(r.stderr).toContain('user-story');
  });

  it('accepts all four valid type labels in dry-run mode', () => {
    for (const label of ['epic', 'feature', 'user-story', 'task']) {
      const r = run(['--title', 'T', '--body', 'B', '--label', label, '--parent', '1', '--dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`label:        ${label}`);
    }
  });

  it('refuses with non-zero exit when --parent is missing (AC: no orphan issues)', () => {
    const r = run(['--title', 'T', '--body', 'B', '--label', 'task']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--parent is required/i);
  });

  it('refuses when --parent is not a number', () => {
    const r = run(['--title', 'T', '--body', 'B', '--label', 'task', '--parent', 'notanumber']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/positive integer/i);
  });

  it('refuses when --title is missing', () => {
    const r = run(['--body', 'B', '--label', 'task', '--parent', '1']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--title is required/i);
  });

  it('refuses when --body is missing', () => {
    const r = run(['--title', 'T', '--label', 'task', '--parent', '1']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--body is required/i);
  });

  it('dry-run succeeds with valid args and prints intent without API calls (AC: issue number surfaced)', () => {
    const r = run([...VALID_ARGS, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[dry-run]');
    expect(r.stdout).toContain('Test issue');
    expect(r.stdout).toContain('label:        task');
    expect(r.stdout).toContain('#198');
    expect(r.stdout).toContain('PVT_kwHOEIjUTs4BVVi-');
  });

  it('dry-run includes extra-label in output', () => {
    const r = run([...VALID_ARGS, '--extra-label', 'blocked', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('blocked');
  });

  it('reports multiple validation errors at once', () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--title is required/i);
    expect(r.stderr).toMatch(/--body is required/i);
    expect(r.stderr).toMatch(/--label is required/i);
    expect(r.stderr).toMatch(/--parent is required/i);
  });
});
