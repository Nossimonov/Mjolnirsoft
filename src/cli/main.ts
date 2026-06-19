import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel } from '../core/channel.ts';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import { createSessionStore } from '../core/create-session-store.ts';
import { loadProjectConfig } from '../core/project-config.ts';
import { parseArgs, CliUsageError, USAGE } from './parse-args.ts';
import { loadLocalEnv } from './load-local-env.ts';
import { hostSession } from './session-host.ts';
import { runWorker } from '../worker/worker-runtime.ts';
import { createClaudeCodeResponder } from '../worker/claude-code-responder.ts';

/** Thin entry point: wire process argv/stdin/stdout to a hosted session. */
async function main(argv: readonly string[]): Promise<void> {
  loadLocalEnv();
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

  const channel: Channel = args.sessionId
    ? createSessionStore(loadProjectConfig()).open(args.sessionId, { replay: args.replay })
    : new InMemoryChannel();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  if (args.auto) {
    // Automated worker: a Claude Code agent backs the channel. Each task runs
    // `claude -p` headless in a per-worker workspace, using the logged-in
    // Claude Code session. It owns no terminal conversation, so stay alive on
    // the open stdin until stopped.
    const workdir = mkdtempSync(join(tmpdir(), `mjolnir-worker-${args.id}-`));
    runWorker(channel, args.id, createClaudeCodeResponder({ workdir }));
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
