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
 * The storage seam: resolves session ids to channels. Backends (file, and later
 * git/cloud) implement this so the rest of the system depends on the interface,
 * not a concrete store. A backend is mounted from the project config by
 * `createSessionStore`.
 */
export interface SessionBackend {
  /** Open (creating if needed) the channel for a session id. */
  open(id: string, options?: { replay?: boolean }): Channel;
  /** List existing session ids. */
  list(): string[];
}

/**
 * The `local` backend: resolves session ids to file-backed channels, hiding the
 * transport. A session is addressed by id; its backing log lives in a directory
 * the user never sees. Swapping the backing (file → broker/socket) leaves this
 * id-based interface unchanged.
 */
export class SessionStore implements SessionBackend {
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

  /**
   * Absolute path to a session's backing log. The permission-prompt MCP server
   * (#66) runs in its own process and bridges to the view over this file, so it
   * needs the path the channel is backed by — a detail this local/file backend
   * can expose because it *is* the file backend.
   */
  logPath(id: string): string {
    return this.pathFor(id);
  }

  private pathFor(id: string): string {
    if (!SESSION_ID.test(id)) {
      throw new Error(`invalid session id: ${id} (use letters, digits, '_' or '-')`);
    }
    return join(this.dir, `${id}.jsonl`);
  }
}
