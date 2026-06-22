import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSessionStore } from './git-session-store.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-git-'));
  tempDirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'Tester');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-m', 'init');
  return dir;
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: repo }).toString();

describe('GitSessionStore', () => {
  it('persists a session to the dedicated ref on close, out of the working tree', () => {
    const repo = initRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const store = new GitSessionStore({ repoDir: repo, baseDir: join(repo, '.mjolnir', 'sessions') });

    const ch = store.open('demo');
    ch.join('a', 'planner', () => {}).send({ type: 'text', payload: 'hello' });
    ch.close(); // triggers persistence

    // The record (with its content) is in the dedicated ref...
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'refs/mjolnir/sessions')).toContain('sessions/demo.jsonl');
    expect(git(repo, 'cat-file', '-p', 'refs/mjolnir/sessions:sessions/demo.jsonl')).toContain('hello');
    // ...and HEAD (the checked-out branch) is untouched: no sessions/, same commit.
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('sessions/');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore);

    expect(store.list()).toContain('demo');
  });

  it('appends a second session without losing the first', () => {
    const repo = initRepo();
    const store = new GitSessionStore({ repoDir: repo, baseDir: join(repo, '.mjolnir', 'sessions') });
    for (const id of ['one', 'two']) {
      const ch = store.open(id);
      ch.join('a', 'planner', () => {}).send({ type: 'text', payload: id });
      ch.close();
    }
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'refs/mjolnir/sessions');
    expect(files).toContain('sessions/one.jsonl');
    expect(files).toContain('sessions/two.jsonl');
    expect(store.list()).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('throws an actionable error when the cwd is not a git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'mjolnir-norepo-'));
    tempDirs.push(notRepo);
    expect(() => new GitSessionStore({ repoDir: notRepo })).toThrow(/git repository/);
  });

  it('removes the git-index temp file after persisting — no tmpdir residue (#159)', () => {
    const repo = initRepo();
    const store = new GitSessionStore({ repoDir: repo, baseDir: join(repo, '.mjolnir', 'sessions') });
    const ch = store.open('idx-cleanup');
    ch.join('a', 'planner', () => {}).send({ type: 'text', payload: 'check' });
    // All git ops inside persist() are synchronous (execFileSync), so the finally{rmSync}
    // block completes before close() returns — no temp file survives.
    ch.close();
    // Precondition: confirm persist() entered its non-empty path by verifying the session
    // was committed to the git ref — guards against a vacuous pass if the channel ever
    // becomes lazy and skips idx creation entirely.
    expect(store.list()).toContain('idx-cleanup');
    const leftover = readdirSync(tmpdir()).filter((f) => f.startsWith(`mjolnir-gitidx-${process.pid}-`));
    expect(leftover).toHaveLength(0);
  });
});
