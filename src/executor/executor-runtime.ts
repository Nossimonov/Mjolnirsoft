import type { Channel, Message, Participant, Role } from '../core/channel.ts';

/** Computes an executor's reply to an incoming message, or undefined for no reply. */
export type Respond = (message: Message) => Promise<Omit<Message, 'from' | 'role'> | undefined>;

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
 * Run an automated responder: join `channel` under `id` in `role` and reply to
 * each message received from another participant using `respond` (which may be
 * async — e.g. a Claude agentic loop). Returns the participant (call `close()`
 * to leave). Replies only to others' messages, so the orchestrator → executor →
 * orchestrator round-trip does not loop. `role` defaults to `executor` (the
 * original, sole caller shape); delegation (#88) passes the delegate's own role
 * so a spawned agent joins its sub-channel honestly attributed.
 */
export function runExecutor(
  channel: Channel,
  id: string,
  respond: Respond = acknowledge,
  role: Role = 'executor',
): Participant {
  let executor: Participant;
  // Serialize turns: the Claude responder pins one session id, so two concurrent
  // `claude --resume <same id>` runs collide ("Session ID … is already in use").
  // This most often bites while a turn is blocked on a permission/question card —
  // a message arriving then would otherwise start a second, overlapping run. We
  // chain each turn on a tail promise so the turn for message N+1 begins only
  // after N's turn settles. The tail must always resolve (the catch swallows the
  // failure) so one failed turn can't wedge the queue (#100). Interaction-decision
  // and delegation messages short-circuit to `undefined` in the responder, so they
  // pass through the chain fast and never hold the queue on a claude run.
  let tail = Promise.resolve();
  executor = channel.join(id, role, (message) => {
    tail = tail.then(async () => {
      try {
        const reply = await respond(message);
        if (reply) executor.send(reply);
      } catch (error: unknown) {
        const failure = `executor ${id} failed to respond: ${String(error)}`;
        // Surface the failure in the session, not just the host log: an `error`
        // turn on the channel reaches every host (view + CLI) and the durable
        // log, and — being a reply like any other — stops the view's "working"
        // indicator instead of leaving it ticking forever (#89). Keep the stderr
        // write too: it's useful host-log detail when a session view isn't open.
        process.stderr.write(`${failure}\n`);
        executor.send({ type: 'error', payload: failure });
      }
    });
  });
  return executor;
}
