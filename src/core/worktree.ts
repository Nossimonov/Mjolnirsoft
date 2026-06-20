import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface WorktreeManagerOptions {
  /** Working dir of the git repo (default: cwd). */
  readonly repoDir?: string;
  /** Directory worktrees live under (default: <repoDir>/.mjolnir/worktrees). */
  readonly baseDir?: string;
  /** Branch/commit new worktrees fork from (default: HEAD). */
  readonly base?: string;
  /** Prefix for worktree branch names (default: 'mjolnir/work/'). */
  readonly branchPrefix?: string;
}

export interface Worktree {
  /** Absolute path of the worktree checkout — an executor's isolated workspace. */
  readonly path: string;
  /** The branch the worktree is on; survives removal and holds the executor's commits. */
  readonly branch: string;
  /**
   * Stage and commit everything in the worktree onto its branch (the system
   * "capture" at session end). Returns false if there was nothing to commit.
   */
  commit(message: string): boolean;
  /** Remove the worktree directory; the branch (and its commits) remains. */
  remove(): void;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Fixed identity for system-captured commits, so committing never depends on the repo's git config. */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Mjolnirsoft',
  GIT_AUTHOR_EMAIL: 'mjolnir@localhost',
  GIT_COMMITTER_NAME: 'Mjolnirsoft',
  GIT_COMMITTER_EMAIL: 'mjolnir@localhost',
};

/**
 * Creates and tears down isolated git worktrees for executors. Each worktree is a
 * checkout on its own branch, so an executor edits the project repo without
 * touching the developer's working tree, index, or HEAD; removing the worktree
 * leaves the branch (and the executor's commits) for review. Uses git plumbing
 * only and never changes the current checkout.
 */
export class WorktreeManager {
  private readonly repoDir: string;
  private readonly baseDir: string;
  private readonly base: string;
  private readonly branchPrefix: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.repoDir = resolve(options.repoDir ?? process.cwd());
    this.baseDir = resolve(options.baseDir ?? join(this.repoDir, '.mjolnir', 'worktrees'));
    this.base = options.base ?? 'HEAD';
    this.branchPrefix = options.branchPrefix ?? 'mjolnir/work/';
    this.assertGitRepo();
  }

  /** Add a worktree for `id` on a fresh branch; returns a handle to it. */
  create(id: string): Worktree {
    if (!SAFE_ID.test(id)) {
      throw new Error(`invalid worktree id: ${id} (use letters, digits, '_' or '-')`);
    }
    mkdirSync(this.baseDir, { recursive: true });
    const path = join(this.baseDir, id);
    const branch = `${this.branchPrefix}${id}`;
    // `-b` creates the branch; fails fast if the branch or the path already exists.
    this.git(['worktree', 'add', '-b', branch, path, this.base]);
    return {
      path,
      branch,
      commit: (message: string): boolean => {
        execFileSync('git', ['add', '-A'], { cwd: path });
        try {
          execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: path, stdio: 'ignore' });
          return false; // nothing staged — nothing to capture
        } catch {
          execFileSync('git', ['commit', '-m', message], { cwd: path, env: { ...process.env, ...COMMIT_IDENTITY } });
          return true;
        }
      },
      remove: () => {
        this.git(['worktree', 'remove', path]);
      },
    };
  }

  /** Clear stale worktree registrations (e.g. after a killed executor left one behind). */
  prune(): void {
    this.git(['worktree', 'prune']);
  }

  private assertGitRepo(): void {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.repoDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      throw new Error(
        `worktree executors need git and a git repository at ${this.repoDir} — run \`git init\` or use a non-repo workdir`,
      );
    }
  }

  private git(args: readonly string[]): string {
    return execFileSync('git', args as string[], { cwd: this.repoDir }).toString().trim();
  }
}
