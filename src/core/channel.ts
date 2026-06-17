/**
 * The shared-channel seam of the orchestration core.
 *
 * Participants join a channel in a role and exchange typed messages. This file
 * is the headless contract only — no transport and no I/O. Concrete channels
 * (in-memory now, cross-process later) implement {@link Channel}.
 */

/** The role a session plays in coordination. */
export type Role = 'planner' | 'worker';

/**
 * A message exchanged over the channel. Intentionally minimal: `type` is a
 * free-form discriminator and `payload` is unstructured. The shape is expected
 * to evolve as coordination needs are pinned down in later stories.
 */
export interface Message {
  /** id of the participant that sent the message */
  readonly from: string;
  /** discriminator for the kind of message */
  readonly type: string;
  /** optional message body */
  readonly payload?: unknown;
}

/** Receives messages delivered to a participant from others on the channel. */
export type MessageHandler = (message: Message) => void;

/** A handle returned to a participant after joining a channel. */
export interface Participant {
  readonly id: string;
  readonly role: Role;
  /** Send a message to the other participants on the channel. */
  send(message: Omit<Message, 'from'>): void;
}

/** A medium over which participants exchange messages, headless of any host. */
export interface Channel {
  /**
   * Join the channel under a unique `id` and a `role`. `onMessage` is invoked
   * for each message sent by another participant. Returns a {@link Participant}
   * handle used to send.
   */
  join(id: string, role: Role, onMessage: MessageHandler): Participant;
}
