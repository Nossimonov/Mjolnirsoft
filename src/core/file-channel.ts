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
 * By default a participant sees only messages appended after it joins;
 * constructing the channel with `replay` instead delivers the existing history
 * first, then streams live (the basis for attaching a window to a running
 * session). Polling re-reads the file and only consumes
 * up to the last complete line, so a concurrent mid-write append is never read
 * partially. Re-reading the whole file each poll is intentionally simple;
 * optimise when logs grow large.
 */
export class FileChannel implements Channel {
  private readonly locals = new Map<string, LocalParticipant>();
  private readonly logPath: string;
  private readonly pollIntervalMs: number;
  private offset: number;
  /**
   * Byte length of the log that already existed when this instance attached — the
   * boundary between *replayed history* (before it) and *live* messages (after it).
   * Replayed history is delivered to a participant **including its own** past
   * messages, so a window re-attaching to a session sees its own prior turns, not
   * just others' (a participant doesn't author its own *live* messages back to
   * itself). Zero when not replaying, so only-live behaviour is unchanged.
   */
  private readonly replayBoundary: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(logPath: string, options: FileChannelOptions = {}) {
    this.logPath = logPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(logPath)) writeFileSync(logPath, '');
    const length = readFileSync(logPath).length;
    // Replay starts from the beginning; otherwise tail from the current end.
    this.offset = options.replay ? 0 : length;
    this.replayBoundary = options.replay ? length : 0;
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
      send: (message: Omit<Message, 'from' | 'role'>) => {
        const delivered: Message = { from: id, role, ...message };
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
    const chunkStart = this.offset;
    const fresh = bytes.subarray(this.offset);
    const lastNewline = fresh.lastIndexOf(NEWLINE);
    if (lastNewline === -1) return; // no complete line yet
    this.offset += lastNewline + 1;

    // Track each line's byte position to tell replayed history (before the boundary)
    // from live messages (after it): history is delivered to *all* participants —
    // including the one that authored it, so a re-attaching window sees its own past
    // turns — while a live message is never delivered back to its own author (#126).
    let cursor = chunkStart;
    for (const line of fresh.subarray(0, lastNewline + 1).toString('utf8').split('\n')) {
      const isReplay = cursor < this.replayBoundary;
      cursor += Buffer.byteLength(line, 'utf8') + 1; // + the newline this line consumed
      if (line.trim() === '') continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue;
      }
      for (const local of this.locals.values()) {
        if (isReplay || local.id !== message.from) local.onMessage(message);
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
