import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Channel, Message, MessageHandler, Participant, Role } from './channel.ts';

interface LocalParticipant {
  readonly id: string;
  readonly role: Role;
  readonly onMessage: MessageHandler;
}

export interface FileChannelOptions {
  /** How often to poll the log for new messages, in ms (default 100). */
  readonly pollIntervalMs?: number;
  /**
   * Replay the session's existing history to this instance's participants
   * before streaming live messages (default false: only see messages appended
   * after joining). Intended for a freshly-constructed instance that is
   * attaching to a session.
   */
  readonly replay?: boolean;
}

const NEWLINE = 0x0a;

/**
 * A {@link Channel} backed by a per-session append-only JSONL log: one
 * {@link Message} per line. Sending appends a line; the channel polls the file
 * and delivers new lines authored by *other* participants. The file is the
 * transport, the persistence, and the shared transcript at once — participants
 * in separate processes that open the same path share one channel.
 *
 * A participant sees only messages appended after it joins (no replay of prior
 * history — that is a later rung). Polling re-reads the file and only consumes
 * up to the last complete line, so a concurrent mid-write append is never read
 * partially. Re-reading the whole file each poll is intentionally simple;
 * optimise when logs grow large.
 */
export class FileChannel implements Channel {
  private readonly locals = new Map<string, LocalParticipant>();
  private readonly logPath: string;
  private readonly pollIntervalMs: number;
  private offset: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(logPath: string, options: FileChannelOptions = {}) {
    this.logPath = logPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(logPath)) writeFileSync(logPath, '');
    // Replay starts from the beginning; otherwise tail from the current end.
    this.offset = options.replay ? 0 : readFileSync(logPath).length;
  }

  join(id: string, role: Role, onMessage: MessageHandler): Participant {
    if (this.locals.has(id)) {
      throw new Error(`Participant already joined: ${id}`);
    }
    this.locals.set(id, { id, role, onMessage });
    this.ensurePolling();
    return {
      id,
      role,
      send: (message: Omit<Message, 'from'>) => {
        const delivered: Message = { from: id, ...message };
        appendFileSync(this.logPath, `${JSON.stringify(delivered)}\n`);
      },
      close: () => {
        this.locals.delete(id);
        if (this.locals.size === 0) this.stopPolling();
      },
    };
  }

  /** Read any new complete lines and dispatch them to local participants. Idempotent. */
  poll(): void {
    const bytes = readFileSync(this.logPath);
    if (bytes.length <= this.offset) return;
    const fresh = bytes.subarray(this.offset);
    const lastNewline = fresh.lastIndexOf(NEWLINE);
    if (lastNewline === -1) return; // no complete line yet
    this.offset += lastNewline + 1;

    for (const line of fresh.subarray(0, lastNewline + 1).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue;
      }
      for (const local of this.locals.values()) {
        if (local.id !== message.from) local.onMessage(message);
      }
    }
  }

  /** Stop tailing and drop all participants. */
  close(): void {
    this.locals.clear();
    this.stopPolling();
  }

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
