import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Channel } from './channel.ts';
import { SessionStore, type SessionBackend, type SessionStoreOptions } from './session-store.ts';

export interface GitSessionStoreOptions extends SessionStoreOptions {
  /** Working dir of the git repo records are committed into (default: cwd). */
  readonly repoDir?: string;
  /** The ref records live under, out of the working tree. */
  readonly ref?: string;
}

const DEFAULT_REF = 'refs/mjolnir/sessions';
const RECORD_AUTHOR = 'Mjolnirsoft';
const RECORD_EMAIL = 'mjolnir@localhost';

/**
 * The `git` backend: the live session runs on a local {@link SessionStore}
 * (`FileChannel`), and on channel close the session's record is committed to a
 * dedicated git ref (default `refs/mjolnir/sessions`) — **out of the working
 * tree**, so records are durable and pushable without ever cluttering the
 * working tree, the index, HEAD, or any branch a developer checks out. Git is a
 * durable record store here, not a live transport (which stays the local file).
 *
 * Persistence uses plumbing only: `hash-object` → a temp-index tree (`read-tree`
 * + `update-index` + `write-tree`) → `commit-tree` → `update-ref`. A fixed
 * record identity is supplied so committing never depends on the repo's git
 * user config.
 */
export class GitSessionStore implements SessionBackend {
  private readonly local: SessionStore;
  private readonly baseDir: string;
  private readonly repoDir: string;
  private readonly ref: string;

  constructor(options: GitSessionStoreOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? join(process.cwd(), '.mjolnir', 'sessions'));
    this.repoDir = resolve(options.repoDir ?? process.cwd());
    this.ref = options.ref ?? DEFAULT_REF;
    this.local = new SessionStore({ baseDir: this.baseDir });
    this.assertGitRepo();
  }

  open(id: string, options: { replay?: boolean } = {}): Channel {
    const inner = this.local.open(id, options); // validates id, creates the live log
    const filePath = join(this.baseDir, `${id}.jsonl`);
    return {
      join: inner.join.bind(inner),
      close: () => {
        try {
          this.persist(id, filePath);
        } finally {
          inner.close();
        }
      },
    };
  }

  list(): string[] {
    return [...new Set([...this.listRef(), ...this.local.list()])].sort();
  }

  /** Commit the session's current log content into the dedicated ref. */
  private persist(id: string, filePath: string): void {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath);
    if (content.length === 0) return;

    const blob = this.git(['hash-object', '-w', '--stdin'], { input: content });
    const idx = join(tmpdir(), `mjolnir-gitidx-${process.pid}-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    try {
      const parent: string[] = [];
      if (this.refExists()) {
        this.git(['read-tree', `${this.ref}^{tree}`], { env });
        parent.push('-p', this.ref);
      } else {
        this.git(['read-tree', '--empty'], { env });
      }
      this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},sessions/${id}.jsonl`], { env });
      const tree = this.git(['write-tree'], { env });
      const commit = this.git(['commit-tree', tree, ...parent, '-m', `session ${id}`], {
        env: {
          ...env,
          GIT_AUTHOR_NAME: RECORD_AUTHOR,
          GIT_AUTHOR_EMAIL: RECORD_EMAIL,
          GIT_COMMITTER_NAME: RECORD_AUTHOR,
          GIT_COMMITTER_EMAIL: RECORD_EMAIL,
        },
      });
      this.git(['update-ref', this.ref, commit]);
    } finally {
      rmSync(idx, { force: true });
    }
  }

  private listRef(): string[] {
    if (!this.refExists()) return [];
    return this.git(['ls-tree', '-r', '--name-only', this.ref])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('sessions/') && line.endsWith('.jsonl'))
      .map((line) => line.slice('sessions/'.length, -'.jsonl'.length));
  }

  private refExists(): boolean {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', this.ref], {
        cwd: this.repoDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }

  private assertGitRepo(): void {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.repoDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      throw new Error(
        `the "git" storage backend needs git installed and a git repository at ${this.repoDir} — run \`git init\` or select a different storage.backend`,
      );
    }
  }

  /** Run a git command in the repo and return trimmed stdout. */
  private git(args: readonly string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}): string {
    return execFileSync('git', args as string[], {
      cwd: this.repoDir,
      input: options.input,
      env: options.env,
    })
      .toString()
      .trim();
  }
}
