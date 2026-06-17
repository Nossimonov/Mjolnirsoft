import { createInterface } from 'node:readline';
import type { Channel } from '../core/channel.ts';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import { FileChannel } from '../core/file-channel.ts';
import { parseArgs, CliUsageError, USAGE } from './parse-args.ts';
import { hostSession } from './session-host.ts';
import { runWorker } from '../worker/worker-runtime.ts';

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

  const channel: Channel = args.logPath
    ? new FileChannel(args.logPath, { replay: args.replay })
    : new InMemoryChannel();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  if (args.auto) {
    // Automated worker: respond to messages programmatically. It owns no
    // terminal conversation, so stay alive on the open stdin until stopped.
    runWorker(channel, args.id);
    for await (const _line of rl) {
      // an automated worker ignores terminal input
    }
    return;
  }

  await hostSession(channel, args, {
    input: rl,
    output: (line) => process.stdout.write(`${line}\n`),
  });
}

void main(process.argv.slice(2));
