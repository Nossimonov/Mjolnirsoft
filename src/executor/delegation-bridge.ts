import { randomUUID } from 'node:crypto';
import type { Message } from '../core/channel.ts';
import {
  DELEGATION_REQUEST,
  DELEGATION_RESPONSE,
  type DelegationResponse,
} from '../core/delegation-protocol.ts';

/** Sends a message on behalf of a joined participant (the participant's `send`). */
type Send = (message: Omit<Message, 'from' | 'role'>) => void;

/**
 * Bridges the executor's delegation MCP tools to the host over the channel (#93):
 * {@link spawn}/{@link shutdown} post a {@link DelegationRequest} and resolve when
 * the matching {@link DelegationResponse} arrives. The exact shape `PermissionBridge`
 * established — the caller wires the channel (passing the participant's `send` in
 * and routing each received message to {@link DelegationBridge.handleMessage}), so
 * the bridge stays transport-free and unit-testable over any {@link Channel}.
 */
export interface DelegationBridge {
  /** Ask the host to spawn a delegate of `role` with `task`; resolves with its id (or an error). */
  spawn(role: string, task: string): Promise<DelegationResponse>;
  /** Send a follow-up `message` to the live delegate `delegateId`; resolves when delivered (or an error if it's gone). */
  message(delegateId: string, message: string): Promise<DelegationResponse>;
  /** Ask the host to shut down the delegate `delegateId`; resolves when acknowledged. */
  shutdown(delegateId: string): Promise<DelegationResponse>;
  /** Feed a received channel message; resolves a pending request if it's its response. */
  handleMessage(message: Message): void;
}

export interface DelegationBridgeOptions {
  /** Override request-id generation (tests inject a deterministic source). */
  readonly generateId?: () => string;
}

/** Create a {@link DelegationBridge} that sends via `send`. */
export function createDelegationBridge(send: Send, options: DelegationBridgeOptions = {}): DelegationBridge {
  const generateId = options.generateId ?? randomUUID;
  const pending = new Map<string, (response: DelegationResponse) => void>();

  const request = (
    payload: { action: 'spawn' | 'shutdown' | 'message'; role?: string; task?: string; delegateId?: string },
  ): Promise<DelegationResponse> => {
    const requestId = generateId();
    return new Promise<DelegationResponse>((resolve) => {
      pending.set(requestId, resolve);
      send({ type: DELEGATION_REQUEST, payload: { requestId, ...payload } });
    });
  };

  return {
    spawn(role, task) {
      return request({ action: 'spawn', role, task });
    },
    message(delegateId, message) {
      return request({ action: 'message', delegateId, task: message });
    },
    shutdown(delegateId) {
      return request({ action: 'shutdown', delegateId });
    },
    handleMessage(message) {
      if (message.type !== DELEGATION_RESPONSE) return;
      const response = message.payload as DelegationResponse | undefined;
      if (!response || typeof response.requestId !== 'string') return;
      const resolve = pending.get(response.requestId);
      if (resolve) {
        pending.delete(response.requestId);
        resolve(response);
      }
    },
  };
}
