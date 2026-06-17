import type { Role } from '../core/channel.ts';

export interface CliArgs {
  readonly role: Role;
  readonly id: string;
  /** Path to a shared session log; when set, sessions share a file-backed channel. */
  readonly logPath?: string;
  /** Replay the session's history on attach (requires a log). */
  readonly replay?: boolean;
  /** Run as an automated worker that auto-responds to messages. */
  readonly auto?: boolean;
}

export const USAGE = 'usage: <planner|worker> [participant-id] [--log <session-log-path>] [--replay] [--auto]';

/** Thrown when CLI arguments are missing or invalid. */
export class CliUsageError extends Error {}

/**
 * Parse CLI arguments into {@link CliArgs}. The first positional is the required
 * role; the optional second is the participant id (defaulting to `<role>-1`).
 * `--log <path>` (or `-l`) selects a shared file-backed channel. Throws
 * {@link CliUsageError} on missing/invalid input.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let logPath: string | undefined;
  let replay = false;
  let auto = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--log' || arg === '-l') {
      logPath = argv[++i];
      if (logPath === undefined) {
        throw new CliUsageError('--log requires a path');
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
  if (replay && logPath === undefined) {
    throw new CliUsageError('--replay requires --log');
  }
  return { role, id: id ?? `${role}-1`, logPath, replay: replay || undefined, auto: auto || undefined };
}
