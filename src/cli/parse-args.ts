import type { Role } from '../core/channel.ts';

export interface CliArgs {
  readonly role: Role;
  readonly id: string;
}

export const USAGE = 'usage: <planner|worker> [participant-id]';

/** Thrown when CLI arguments are missing or invalid. */
export class CliUsageError extends Error {}

/**
 * Parse positional CLI arguments into {@link CliArgs}. The first argument is
 * the required role; the optional second is the participant id (defaulting to
 * `<role>-1`). Throws {@link CliUsageError} on missing/invalid input.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const [role, id] = argv;
  if (role !== 'planner' && role !== 'worker') {
    throw new CliUsageError(`role must be "planner" or "worker", got ${role ?? '(none)'}`);
  }
  return { role, id: id ?? `${role}-1` };
}
