import type { Channel, Message, Participant } from '../core/channel.ts';

/** Computes a worker's reply to an incoming message, or undefined for no reply. */
export type Respond = (message: Message) => Omit<Message, 'from'> | undefined;

/**
 * Default worker behavior: acknowledge the message. This is a stub — the seam
 * where a real agent (which reads the task and does work) plugs in later.
 */
export const acknowledge: Respond = (message) => ({
  type: 'ack',
  payload: `received: ${typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload)}`,
});

/**
 * Run an automated worker: join `channel` as a worker and reply to each message
 * received from another participant using `respond`. Returns the worker
 * participant (call `close()` to leave). Replies only to others' messages, so
 * the orchestrator → worker → orchestrator round-trip does not loop.
 */
export function runWorker(channel: Channel, id: string, respond: Respond = acknowledge): Participant {
  let worker: Participant;
  worker = channel.join(id, 'worker', (message) => {
    const reply = respond(message);
    if (reply) worker.send(reply);
  });
  return worker;
}
