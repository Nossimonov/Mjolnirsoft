import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Channel } from './channel.ts';
import { FileChannel } from './file-channel.ts';

export interface SessionStoreOptions {
  /** Base directory for session logs (default: <cwd>/.mjolnir/sessions). */
  readonly baseDir?: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Resolves session ids to channels, hiding the file-backed transport. A session
 * is addressed by id; its backing log lives in a directory the user never sees.
 * Swapping the backing (file → broker/socket) leaves this id-based interface
 * unchanged.
 */
export class SessionStore {
  private readonly dir: string;

  constructor(options: SessionStoreOptions = {}) {
    this.dir = resolve(options.baseDir ?? join(process.cwd(), '.mjolnir', 'sessions'));
  }

  /** Open (creating if needed) the channel for a session id. */
  open(id: string, options: { replay?: boolean } = {}): Channel {
    const path = this.pathFor(id);
    mkdirSync(this.dir, { recursive: true });
    return new FileChannel(path, { replay: options.replay });
  }

  /** List existing session ids. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length));
  }

  private pathFor(id: string): string {
    if (!SESSION_ID.test(id)) {
      throw new Error(`invalid session id: ${id} (use letters, digits, '_' or '-')`);
    }
    return join(this.dir, `${id}.jsonl`);
  }
}
