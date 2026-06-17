import { createInterface } from 'node:readline';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import { parseArgs, CliUsageError, USAGE } from './parse-args.ts';
import { hostSession } from './session-host.ts';

/** Thin entry point: wire process argv/stdin/stdout to a hosted session. */
async function main(argv: readonly string[]): Promise<void> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`error: ${error.message}\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const channel = new InMemoryChannel();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  await hostSession(channel, args, {
    input: rl,
    output: (line) => process.stdout.write(`${line}\n`),
  });
}

void main(process.argv.slice(2));
