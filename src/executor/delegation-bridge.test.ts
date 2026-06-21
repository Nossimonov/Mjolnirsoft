import { describe, expect, it } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message } from '../core/channel.ts';
import {
  DELEGATION_REQUEST,
  DELEGATION_RESPONSE,
  type DelegationRequest,
} from '../core/delegation-protocol.ts';
import { createDelegationBridge } from './delegation-bridge.ts';

/**
 * Join the bridge as the executor's delegation side and a fake "host" as the other
 * side of one channel — the way the delegation MCP server and the in-host
 * delegation manager meet over a session's FileChannel, but in-memory so the
 * round-trip is synchronous.
 */
function wire(respond: (request: DelegationRequest) => Omit<Message, 'from' | 'role'>) {
  const channel = new InMemoryChannel();
  const seen: DelegationRequest[] = [];
  const host = channel.join('host', 'planner', (message) => {
    if (message.type === DELEGATION_REQUEST) {
      seen.push(message.payload as DelegationRequest);
      host.send(respond(message.payload as DelegationRequest));
    }
  });
  const delegate = channel.join('delegate', 'executor', (message) => bridge.handleMessage(message));
  const bridge = createDelegationBridge(delegate.send);
  return { bridge, seen };
}

describe('delegation bridge (#93)', () => {
  it('resolves a spawn with the host\'s delegate id', async () => {
    const { bridge, seen } = wire((request) => ({
      type: DELEGATION_RESPONSE,
      payload: { requestId: request.requestId, delegateId: 'w1-executor-evaluator-1' },
    }));

    const response = await bridge.spawn('evaluator', 'review the diff');

    expect(response.delegateId).toBe('w1-executor-evaluator-1');
    // The request carried the role and task the executor asked to delegate.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: 'spawn', role: 'evaluator', task: 'review the diff' });
  });

  it('carries a spawn failure (e.g. an unknown role) back through', async () => {
    const { bridge } = wire((request) => ({
      type: DELEGATION_RESPONSE,
      payload: { requestId: request.requestId, error: 'cannot spawn unknown role: wizard' },
    }));

    const response = await bridge.spawn('wizard', 'do magic');

    expect(response.error).toBe('cannot spawn unknown role: wizard');
    expect(response.delegateId).toBeUndefined();
  });

  it('sends a follow-up message to a live delegate, carrying its id + text (#111)', async () => {
    const { bridge, seen } = wire((request) => ({
      type: DELEGATION_RESPONSE,
      payload: { requestId: request.requestId, delegateId: request.delegateId },
    }));

    const response = await bridge.message('w1-executor-evaluator-1', 'run the suite with PATH=...');

    expect(seen[0]).toMatchObject({
      action: 'message',
      delegateId: 'w1-executor-evaluator-1',
      task: 'run the suite with PATH=...',
    });
    expect(response.delegateId).toBe('w1-executor-evaluator-1');
  });

  it('carries a send-to-gone-delegate error back through (#111)', async () => {
    const { bridge } = wire((request) => ({
      type: DELEGATION_RESPONSE,
      payload: { requestId: request.requestId, error: 'no live delegate: w1-executor-evaluator-9' },
    }));

    const response = await bridge.message('w1-executor-evaluator-9', 'hello?');

    expect(response.error).toBe('no live delegate: w1-executor-evaluator-9');
  });

  it('resolves a shutdown, routing the matching response back by requestId', async () => {
    const { bridge, seen } = wire((request) => ({
      type: DELEGATION_RESPONSE,
      payload: { requestId: request.requestId, delegateId: request.delegateId },
    }));

    const response = await bridge.shutdown('w1-executor-evaluator-1');

    expect(seen[0]).toMatchObject({ action: 'shutdown', delegateId: 'w1-executor-evaluator-1' });
    expect(response.delegateId).toBe('w1-executor-evaluator-1');
  });

  it('ignores responses for unknown requests', () => {
    const { bridge } = wire(() => ({ type: 'noop' }));
    expect(() =>
      bridge.handleMessage({
        from: 'host',
        role: 'planner',
        type: DELEGATION_RESPONSE,
        payload: { requestId: 'ghost', delegateId: 'x' },
      }),
    ).not.toThrow();
  });
});
