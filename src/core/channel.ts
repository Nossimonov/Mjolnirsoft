/**
 * The shared-channel seam of the orchestration core.
 *
 * Participants join a channel in a role and exchange typed messages. This file
 * is the headless contract only — no transport and no I/O. Concrete channels
 * (in-memory now, cross-process later) implement {@link Channel}.
 */

/**
 * The role a session plays in coordination. `planner` is the authoritative
 * human (architect seat); `orchestrator`, `executor`, `evaluator`,
 * `arbitrator`, and `investigator` are the tool-spawned agent roles.
 * `orchestrator` plans and delegates a task to an executor and relays its
 * hand-off (#114); `evaluator` joins via delegation (#93) — a spawner
 * delegates a critique to an evaluator on its own sub-channel; `arbitrator`
 * reconciles two conflicting branches into a clean merge on an isolated
 * worktree (#99); `investigator` fact-finds against primary sources and
 * returns a distilled cited finding (#166). Each is a channel role carried
 * in the message so attribution can mark a report: the architect (`planner`)
 * is authoritative, an `orchestrator` reads as the (non-authoritative)
 * delegating supervisor, and every other agent role as a plain
 * (non-authoritative) agent (#86). The agent roles that carry composed
 * instructions are mirrored by `AgentRole` in `agent-instructions.ts`.
 */
export type Role = 'planner' | 'orchestrator' | 'executor' | 'evaluator' | 'arbitrator' | 'investigator';

/**
 * A message exchanged over the channel. Intentionally minimal: `type` is a
 * free-form discriminator and `payload` is unstructured. The shape is expected
 * to evolve as coordination needs are pinned down in later stories.
 */
export interface Message {
  /** id of the participant that sent the message */
  readonly from: string;
  /**
   * Role the sender holds on the channel, stamped by `send` alongside `from`.
   * Carried in the delivered message (not looked up at the receiver) so a
   * cross-process recipient — which doesn't know the remote sender's role —
   * can still attribute authority: an `executor` peer must never be mistaken
   * for the authoritative human (`planner`). See #86.
   */
  readonly role: Role;
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
  /** Send a message to the other participants on the channel. `from` and `role` are stamped by the channel. */
  send(message: Omit<Message, 'from' | 'role'>): void;
  /** Leave the channel and release any resources held for this participant. */
  close(): void;
}

/** A medium over which participants exchange messages, headless of any host. */
export interface Channel {
  /**
   * Join the channel under a unique `id` and a `role`. `onMessage` is invoked
   * for each message sent by another participant. Returns a {@link Participant}
   * handle used to send.
   */
  join(id: string, role: Role, onMessage: MessageHandler): Participant;
  /** Stop the channel and release any resources it holds. */
  close(): void;
}
