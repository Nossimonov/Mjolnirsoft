import type { Channel, Message, Participant } from '../core/channel.ts';

/** Computes an executor's reply to an incoming message, or undefined for no reply. */
export type Respond = (message: Message) => Promise<Omit<Message, 'from'> | undefined>;

/**
 * A trivial {@link Respond} that echoes the message back as an `ack`. It is the
 * default for transport-only use and tests; the real agent behavior is the
 * Claude Code responder (`createClaudeCodeResponder`), which the `--auto` executor
 * passes in.
 */
export const acknowledge: Respond = async (message) => ({
  type: 'ack',
  payload: `received: ${typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload)}`,
});

/**
 * Run an automated executor: join `channel` as an executor and reply to each message
 * received from another participant using `respond` (which may be async — e.g.
 * a Claude agentic loop). Returns the executor participant (call `close()` to
 * leave). Replies only to others' messages, so the orchestrator → executor →
 * orchestrator round-trip does not loop.
 */
export function runExecutor(channel: Channel, id: string, respond: Respond = acknowledge): Participant {
  let executor: Participant;
  executor = channel.join(id, 'executor', (message) => {
    respond(message)
      .then((reply) => {
        if (reply) executor.send(reply);
      })
      .catch((error: unknown) => {
        process.stderr.write(`executor ${id} failed to respond: ${String(error)}\n`);
      });
  });
  return executor;
}
