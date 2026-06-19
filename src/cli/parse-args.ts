import type { Role } from '../core/channel.ts';

export interface CliArgs {
  readonly role: Role;
  readonly id: string;
  /** Session to join by id; when set, participants share that session. Omit for in-memory single-process. */
  readonly sessionId?: string;
  /** Replay the session's history on attach (requires a session). */
  readonly replay?: boolean;
  /** Run as an automated worker that auto-responds to messages. */
  readonly auto?: boolean;
}

export const USAGE = 'usage: <planner|worker> [participant-id] [--session <id>] [--replay] [--auto]';

/** Thrown when CLI arguments are missing or invalid. */
export class CliUsageError extends Error {}

/**
 * Parse CLI arguments into {@link CliArgs}. The first positional is the required
 * role; the optional second is the participant id (defaulting to `<role>-1`).
 * `--session <id>` (or `-s`) joins a shared, file-backed session by id (omit for
 * an in-memory single-process channel); `--replay` requires a session, and
 * `--auto` runs an automated worker. Throws {@link CliUsageError} on
 * missing/invalid input.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let sessionId: string | undefined;
  let replay = false;
  let auto = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session' || arg === '-s') {
      sessionId = argv[++i];
      if (sessionId === undefined) {
        throw new CliUsageError('--session requires an id');
      }
    } else if (arg === '--replay') {
      replay = true;
    } else if (arg === '--auto') {
      auto = true;
    } else {
      positional.push(arg);
    }
  }

  const [role, id] = positional;
  if (role !== 'planner' && role !== 'worker') {
    throw new CliUsageError(`role must be "planner" or "worker", got ${role ?? '(none)'}`);
  }
  if (replay && sessionId === undefined) {
    throw new CliUsageError('--replay requires --session');
  }
  return { role, id: id ?? `${role}-1`, sessionId, replay: replay || undefined, auto: auto || undefined };
}
