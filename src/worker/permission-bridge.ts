import { randomUUID } from 'node:crypto';
import type { Message } from '../core/channel.ts';
import {
  INTERACTION_DECISION,
  INTERACTION_REQUEST,
  type InteractionDecision,
} from '../core/interaction.ts';

/** Sends a message on behalf of a joined participant (the participant's `send`). */
type Send = (message: Omit<Message, 'from'>) => void;

/**
 * Bridges Claude's permission prompt to a human over the channel: {@link request}
 * posts an `interaction-request` and resolves when the matching
 * `interaction-decision` arrives. The caller wires the channel — passing the
 * participant's `send` in, and routing each received message to
 * {@link PermissionBridge.handleMessage} — so the bridge stays transport-free
 * and testable with any {@link Channel}.
 */
export interface PermissionBridge {
  /** Surface a tool request; resolves with the human's decision (may stay pending indefinitely). */
  request(toolName: string, input: unknown, toolUseId?: string): Promise<InteractionDecision>;
  /** Feed a received channel message; resolves a pending request if it's its decision. */
  handleMessage(message: Message): void;
}

export interface PermissionBridgeOptions {
  /** Override request-id generation (tests inject a deterministic source). */
  readonly generateId?: () => string;
}

/** Create a {@link PermissionBridge} that sends via `send`. */
export function createPermissionBridge(send: Send, options: PermissionBridgeOptions = {}): PermissionBridge {
  const generateId = options.generateId ?? randomUUID;
  const pending = new Map<string, (decision: InteractionDecision) => void>();

  return {
    request(toolName, input, toolUseId) {
      const requestId = generateId();
      return new Promise<InteractionDecision>((resolve) => {
        pending.set(requestId, resolve);
        send({ type: INTERACTION_REQUEST, payload: { requestId, toolName, input, toolUseId } });
      });
    },
    handleMessage(message) {
      if (message.type !== INTERACTION_DECISION) return;
      const decision = message.payload as InteractionDecision | undefined;
      if (!decision || typeof decision.requestId !== 'string') return;
      const resolve = pending.get(decision.requestId);
      if (resolve) {
        pending.delete(decision.requestId);
        resolve(decision);
      }
    },
  };
}
