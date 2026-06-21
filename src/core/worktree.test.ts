import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, currentRemoteBase } from './worktree.ts';

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-wt-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'Tester');
  writeFileSync(join(dir, '.gitignore'), '.mjolnir/\n');
  writeFileSync(join(dir, 'file.txt'), 'v1\n');
  g('add', '-A');
  g('commit', '-m', 'init');
  return dir;
}

const git = (repo: string, ...a: string[]) => execFileSync('git', a, { cwd: repo }).toString();

describe('WorktreeManager', () => {
  it('creates an isolated worktree on a fresh branch, leaving the main tree untouched', () => {
    const repo = initRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const mgr = new WorktreeManager({ repoDir: repo });

    const wt = mgr.create('sess1');

    expect(existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe('mjolnir/work/sess1');
    expect(git(repo, 'rev-parse', wt.branch).trim()).toBe(headBefore); // branch forks from HEAD
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // main HEAD untouched
    expect(git(repo, 'status', '--porcelain').trim()).toBe(''); // worktree is gitignored, tree clean
  });

  it('keeps the branch and its commits after the worktree is removed; main tree never changes', () => {
    const repo = initRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const mgr = new WorktreeManager({ repoDir: repo });
    const wt = mgr.create('task');

    // An executor edits + commits inside the worktree.
    writeFileSync(join(wt.path, 'added.txt'), 'work\n');
    execFileSync('git', ['add', '-A'], { cwd: wt.path });
    execFileSync(
      'git',
      ['-c', 'user.email=m@l', '-c', 'user.name=Mjolnir', 'commit', '-m', 'executor work'],
      { cwd: wt.path },
    );
    const branchHead = git(repo, 'rev-parse', wt.branch).trim();
    expect(branchHead).not.toBe(headBefore);

    wt.remove();

    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, 'rev-parse', wt.branch).trim()).toBe(branchHead); // branch survives
    expect(git(repo, 'show', `${wt.branch}:added.txt`)).toContain('work'); // with its commit
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // main never moved
  });

  it('captures worktree changes onto its branch, reporting nothing to commit when clean', () => {
    const repo = initRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const mgr = new WorktreeManager({ repoDir: repo });
    const wt = mgr.create('cap');

    expect(wt.commit('noop')).toBe(false); // fresh worktree — nothing to capture

    writeFileSync(join(wt.path, 'feature.txt'), 'work\n');
    expect(wt.commit('executor session cap')).toBe(true);
    expect(git(repo, 'show', `${wt.branch}:feature.txt`)).toContain('work');
    expect(git(repo, 'log', '-1', '--format=%s', wt.branch).trim()).toBe('executor session cap');

    wt.remove();
    expect(git(repo, 'rev-parse', '--verify', wt.branch).trim()).toMatch(/^[0-9a-f]{40}$/); // branch survives
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // main never moved
  });

  it('rejects an invalid id, a duplicate worktree, and a non-repo', () => {
    const repo = initRepo();
    const mgr = new WorktreeManager({ repoDir: repo });
    expect(() => mgr.create('../evil')).toThrow(/invalid worktree id/);
    mgr.create('dup');
    expect(() => mgr.create('dup')).toThrow(); // branch + path already exist
    const notRepo = mkdtempSync(join(tmpdir(), 'mjolnir-norepo-'));
    expect(() => new WorktreeManager({ repoDir: notRepo })).toThrow(/git repository/);
  });

  it('prune runs cleanly', () => {
    const mgr = new WorktreeManager({ repoDir: initRepo() });
    expect(() => mgr.prune()).not.toThrow();
  });

  it('reports whether a worktree already exists — the resume signal (#126)', () => {
    const mgr = new WorktreeManager({ repoDir: initRepo() });
    expect(mgr.exists('s1')).toBe(false);
    const wt = mgr.create('s1');
    expect(mgr.exists('s1')).toBe(true);
    wt.remove();
    expect(mgr.exists('s1')).toBe(false); // a clean close removes it → no longer resumable
  });

  it('reattaches to an existing worktree with its uncommitted work intact, then captures it (#126)', () => {
    const repo = initRepo();
    const mgr = new WorktreeManager({ repoDir: repo });
    const created = mgr.create('resumable');
    // An interrupted session left uncommitted work in the worktree (no commit ran —
    // the reload skipped cleanup).
    writeFileSync(join(created.path, 'in-flight.txt'), 'partial\n');

    // Resume: reattach without re-creating; the in-flight work is still there.
    const reopened = mgr.open('resumable');
    expect(reopened.path).toBe(created.path);
    expect(reopened.branch).toBe('mjolnir/work/resumable');
    expect(existsSync(join(reopened.path, 'in-flight.txt'))).toBe(true);

    // The reattached handle captures + drops the worktree like any other (clean close).
    expect(reopened.commit('captured on resume')).toBe(true);
    expect(git(repo, 'show', `${reopened.branch}:in-flight.txt`)).toContain('partial');
    reopened.remove();
    expect(existsSync(reopened.path)).toBe(false);
  });

  it('open validates the id like create', () => {
    const mgr = new WorktreeManager({ repoDir: initRepo() });
    expect(() => mgr.open('../evil')).toThrow(/invalid worktree id/);
  });
});

describe('currentRemoteBase (#83)', () => {
  it('falls back to HEAD when there is no remote', () => {
    expect(currentRemoteBase(initRepo())).toBe('HEAD');
  });

  it('bases a session on origin/main when the remote is ahead of stale local main', () => {
    // The trap that put #57 on stale code: a repo pushed to origin, then origin/main
    // advanced from elsewhere, leaving this checkout's local main behind.
    const remote = mkdtempSync(join(tmpdir(), 'mjolnir-remote-'));
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    const repo = initRepo();
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    g('branch', '-M', 'main');
    g('remote', 'add', 'origin', remote);
    g('push', '-u', 'origin', 'main');

    // Advance origin/main from a second clone (repo's local main stays behind).
    const other = mkdtempSync(join(tmpdir(), 'mjolnir-other-'));
    const o = (...a: string[]) => execFileSync('git', a, { cwd: other, stdio: 'ignore' });
    o('clone', remote, '.');
    o('config', 'user.email', 't@t');
    o('config', 'user.name', 'T');
    writeFileSync(join(other, 'merged.txt'), 'fresh\n');
    o('add', '-A');
    o('commit', '-m', 'advance origin');
    o('push', 'origin', 'HEAD:main');

    const localHead = git(repo, 'rev-parse', 'HEAD').trim();

    // Fetches and prefers origin/main…
    expect(currentRemoteBase(repo)).toBe('origin/main');

    // …and a worktree on that base carries the merged commit local HEAD lacks.
    const wt = new WorktreeManager({ repoDir: repo, base: currentRemoteBase(repo) }).create('fresh1');
    expect(existsSync(join(wt.path, 'merged.txt'))).toBe(true);
    expect(git(repo, 'rev-parse', wt.branch).trim()).toBe(git(repo, 'rev-parse', 'origin/main').trim());
    expect(git(repo, 'rev-parse', wt.branch).trim()).not.toBe(localHead); // not the stale local base
  });
});
