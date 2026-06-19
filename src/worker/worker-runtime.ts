import type { Channel, Message, Participant } from '../core/channel.ts';

/** Computes a worker's reply to an incoming message, or undefined for no reply. */
export type Respond = (message: Message) => Promise<Omit<Message, 'from'> | undefined>;

/**
 * A trivial {@link Respond} that echoes the message back as an `ack`. It is the
 * default for transport-only use and tests; the real agent behavior is the
 * Claude Code responder (`createClaudeCodeResponder`), which the `--auto` worker
 * passes in.
 */
export const acknowledge: Respond = async (message) => ({
  type: 'ack',
  payload: `received: ${typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload)}`,
});

/**
 * Run an automated worker: join `channel` as a worker and reply to each message
 * received from another participant using `respond` (which may be async — e.g.
 * a Claude agentic loop). Returns the worker participant (call `close()` to
 * leave). Replies only to others' messages, so the orchestrator → worker →
 * orchestrator round-trip does not loop.
 */
export function runWorker(channel: Channel, id: string, respond: Respond = acknowledge): Participant {
  let worker: Participant;
  worker = channel.join(id, 'worker', (message) => {
    respond(message)
      .then((reply) => {
        if (reply) worker.send(reply);
      })
      .catch((error: unknown) => {
        process.stderr.write(`worker ${id} failed to respond: ${String(error)}\n`);
      });
  });
  return worker;
}
