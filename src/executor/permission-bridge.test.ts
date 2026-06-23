import { describe, expect, it } from 'vitest';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import type { Message } from '../core/channel.ts';
import {
  INTERACTION_DECISION,
  INTERACTION_REQUEST,
  type InteractionRequest,
  decisionToVerdict,
} from '../core/interaction.ts';
import { createPermissionBridge } from './permission-bridge.ts';

/**
 * Join the bridge as the executor's permission side and a fake "view" as the human
 * side of one channel, the way the MCP server and the VS Code panel meet over a
 * session's FileChannel — but in-memory, so the round-trip is synchronous.
 */
function wire(respond: (request: InteractionRequest) => Omit<Message, 'from' | 'role'>) {
  const channel = new InMemoryChannel();
  const view = channel.join('view', 'planner', (message) => {
    if (message.type === INTERACTION_REQUEST) {
      view.send(respond(message.payload as InteractionRequest));
    }
  });
  const perms = channel.join('perms', 'executor', (message) => bridge.handleMessage(message));
  const bridge = createPermissionBridge(perms.send);
  return { bridge };
}

describe('permission bridge', () => {
  it('resolves a request with the view\'s allow decision', async () => {
    const { bridge } = wire((request) => ({
      type: INTERACTION_DECISION,
      payload: { requestId: request.requestId, behavior: 'allow' },
    }));

    const decision = await bridge.request('Write', { file_path: '/tmp/x', content: 'hi' }, 'toolu_1');

    expect(decision.behavior).toBe('allow');
  });

  it('routes the matching decision back by requestId', async () => {
    const seen: InteractionRequest[] = [];
    const { bridge } = wire((request) => {
      seen.push(request);
      return { type: INTERACTION_DECISION, payload: { requestId: request.requestId, behavior: 'deny', message: 'no' } };
    });

    const decision = await bridge.request('Bash', { command: 'rm -rf /' });

    expect(seen).toHaveLength(1);
    expect(seen[0].toolName).toBe('Bash');
    expect(decision).toMatchObject({ requestId: seen[0].requestId, behavior: 'deny', message: 'no' });
  });

  it('ignores decisions for unknown requests', () => {
    const { bridge } = wire(() => ({ type: 'noop' }));
    // A stray decision must not throw or resolve anything.
    expect(() =>
      bridge.handleMessage({
        from: 'view',
        role: 'planner',
        type: INTERACTION_DECISION,
        payload: { requestId: 'ghost', behavior: 'allow' },
      }),
    ).not.toThrow();
  });
});

describe('decisionToVerdict', () => {
  const request: InteractionRequest = { requestId: 'r1', toolName: 'Write', input: { file_path: '/x', content: 'a' } };

  it('echoes the original input on a bare allow', () => {
    expect(decisionToVerdict(request, { requestId: 'r1', behavior: 'allow' })).toEqual({
      behavior: 'allow',
      updatedInput: request.input,
    });
  });

  it('passes an edited input through on allow', () => {
    const updatedInput = { file_path: '/x', content: 'edited' };
    expect(decisionToVerdict(request, { requestId: 'r1', behavior: 'allow', updatedInput })).toEqual({
      behavior: 'allow',
      updatedInput,
    });
  });

  it('supplies a default reason on a bare deny', () => {
    const verdict = decisionToVerdict(request, { requestId: 'r1', behavior: 'deny' });
    expect(verdict).toEqual({ behavior: 'deny', message: 'Denied by the architect.' });
  });

  it('passes a free-text reason through on deny — the "can\'t answer" question-card path (#96)', () => {
    // The architect typed a reason in the free-text field; it must reach the agent verbatim
    // so the agent can re-ask with the context the architect said was missing.
    const verdict = decisionToVerdict(request, {
      requestId: 'r1',
      behavior: 'deny',
      message: "I can't see the referenced content — please include it directly in the question.",
    });
    expect(verdict).toEqual({
      behavior: 'deny',
      message: "I can't see the referenced content — please include it directly in the question.",
    });
  });
});
