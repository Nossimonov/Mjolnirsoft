import type { Channel, Message, Role } from '../core/channel.ts';

/**
 * The host's I/O, abstracted so the adapter can be driven by a real terminal
 * or by tests. `input` yields one line per host input line; `output` writes one
 * line to the host.
 */
export interface SessionIO {
  readonly input: AsyncIterable<string>;
  output(line: string): void;
}

/** Render a message received from the channel as a single output line. */
export function renderIncoming(message: Message): string {
  const body = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
  return `${message.from} [${message.type}] ${body}`;
}

/**
 * Host a session: join `channel` in the given role, write received messages to
 * the host output, and send each host input line as a message. Resolves when
 * the input is exhausted. The core knows nothing of terminals — this adapter is
 * the only thing that does, and the channel is injected so a transport can
 * replace the in-memory one without touching this code.
 */
export async function hostSession(
  channel: Channel,
  args: { id: string; role: Role },
  io: SessionIO,
): Promise<void> {
  const participant = channel.join(args.id, args.role, (message) => {
    io.output(renderIncoming(message));
  });
  io.output(`joined channel as ${args.role} (${args.id})`);
  for await (const line of io.input) {
    participant.send({ type: 'text', payload: line });
  }
}
