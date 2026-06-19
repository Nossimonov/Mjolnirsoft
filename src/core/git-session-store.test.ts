import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSessionStore } from './git-session-store.ts';

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-git-'));
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
    expect(() => new GitSessionStore({ repoDir: notRepo })).toThrow(/git repository/);
  });
});
