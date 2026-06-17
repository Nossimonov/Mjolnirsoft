import type { Channel, Message, MessageHandler, Participant, Role } from './channel';

/**
 * An in-process {@link Channel}: a message is delivered synchronously to every
 * other joined participant (never echoed to its sender). No transport and no
 * external I/O — suitable for the headless core and its tests. Role-based
 * routing and a real transport are deferred to later stories.
 */
export class InMemoryChannel implements Channel {
  private readonly participants = new Map<string, { role: Role; onMessage: MessageHandler }>();

  join(id: string, role: Role, onMessage: MessageHandler): Participant {
    if (this.participants.has(id)) {
      throw new Error(`Participant already joined: ${id}`);
    }
    this.participants.set(id, { role, onMessage });

    return {
      id,
      role,
      send: (message: Omit<Message, 'from'>) => {
        const delivered: Message = { from: id, ...message };
        for (const [participantId, participant] of this.participants) {
          if (participantId !== id) {
            participant.onMessage(delivered);
          }
        }
      },
    };
  }
}
