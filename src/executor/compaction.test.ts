/**
 * Tests for the self-compaction machinery (#165):
 *   - Generation-indexed claudeSessionIdFor rotation
 *   - inspectSession reading the persisted compaction generation
 *   - The compaction request/response protocol over a channel
 *   - getContextNote injection into orchestrator turns
 *   - The host handler composing the fresh-session first prompt from the hand-off
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryChannel } from '../core/in-memory-channel.ts';
import { claudeSessionIdFor } from './claude-code-responder.ts';
import { inspectSession, orchestratorSessionKey } from './session-inspector.ts';
import {
  COMPACTION_REQUEST,
  COMPACTION_RESPONSE,
  COMPACTION_GENERATION,
  type CompactionRequest,
  type CompactionResponse,
  type CompactionGenerationPayload,
} from '../core/compaction-protocol.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjolnir-compact-'));
  tempDirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

// ---------------------------------------------------------------------------
// Generation-indexed claudeSessionIdFor rotation (#165)
// ---------------------------------------------------------------------------

describe('orchestratorSessionKey (#165)', () => {
  it('generation 0 returns the plain session id (backward-compatible)', () => {
    expect(orchestratorSessionKey('orchestrator', 0)).toBe('orchestrator');
  });

  it('generation N > 0 returns a suffixed key', () => {
    expect(orchestratorSessionKey('orchestrator', 1)).toBe('orchestrator:1');
    expect(orchestratorSessionKey('orchestrator', 2)).toBe('orchestrator:2');
  });

  it('each generation produces a different claudeSessionIdFor result (distinct blank contexts)', () => {
    const gen0 = claudeSessionIdFor(orchestratorSessionKey('orchestrator', 0));
    const gen1 = claudeSessionIdFor(orchestratorSessionKey('orchestrator', 1));
    const gen2 = claudeSessionIdFor(orchestratorSessionKey('orchestrator', 2));
    // All three are distinct UUIDs, so each rotation is a truly blank claude conversation.
    expect(gen0).not.toBe(gen1);
    expect(gen1).not.toBe(gen2);
    expect(gen0).not.toBe(gen2);
  });

  it('claudeSessionIdFor with generation key is deterministic (reload resume)', () => {
    const key = orchestratorSessionKey('orchestrator', 3);
    expect(claudeSessionIdFor(key)).toBe(claudeSessionIdFor(key));
  });
});

// ---------------------------------------------------------------------------
// inspectSession reading the persisted compaction generation (#165)
// ---------------------------------------------------------------------------

describe('inspectSession — compaction generation (#165)', () => {
  it('returns generation 0 when no COMPACTION_GENERATION message is in the log', () => {
    const logPath = tempLog([]);
    expect(inspectSession(logPath, 'orchestrator').generation).toBe(0);
  });

  it('reads the generation from a COMPACTION_GENERATION message', () => {
    const payload: CompactionGenerationPayload = { generation: 1 };
    const logPath = tempLog([
      JSON.stringify({
        from: 'orchestrator-compact-host',
        role: 'planner',
        type: COMPACTION_GENERATION,
        payload,
      }),
    ]);
    expect(inspectSession(logPath, 'orchestrator').generation).toBe(1);
  });

  it('takes the LAST COMPACTION_GENERATION in the log (after multiple compactions)', () => {
    const g1: CompactionGenerationPayload = { generation: 1 };
    const g2: CompactionGenerationPayload = { generation: 2 };
    const logPath = tempLog([
      JSON.stringify({ from: 'host', role: 'planner', type: COMPACTION_GENERATION, payload: g1 }),
      JSON.stringify({ from: 'host', role: 'planner', type: COMPACTION_GENERATION, payload: g2 }),
    ]);
    expect(inspectSession(logPath, 'orchestrator').generation).toBe(2);
  });

  it('still reads role and usage alongside the generation', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 10 };
    const payload: CompactionGenerationPayload = { generation: 1 };
    const logPath = tempLog([
      JSON.stringify({ from: 'orchestrator-executor', role: 'orchestrator', type: 'result', payload: 'hi' }),
      JSON.stringify({ from: 'orchestrator-usage', role: 'orchestrator', type: 'usage', payload: usage }),
      JSON.stringify({ from: 'orchestrator-compact-host', role: 'planner', type: COMPACTION_GENERATION, payload }),
    ]);
    const meta = inspectSession(logPath, 'orchestrator');
    expect(meta.generation).toBe(1);
    expect(meta.role).toBe('orchestrator');
    expect(meta.usage.inputTokens).toBe(100);
    expect(meta.usage.outputTokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Compaction request/response protocol over an InMemoryChannel (#165)
// ---------------------------------------------------------------------------

describe('compaction-request/response protocol (#165)', () => {
  it('the MCP server side posts a well-formed COMPACTION_REQUEST', async () => {
    const channel = new InMemoryChannel();

    // Capture messages seen by the "host" seat
    const hostMessages: unknown[] = [];
    channel.join('host', 'planner', (msg) => {
      if (msg.type === COMPACTION_REQUEST) hostMessages.push(msg.payload);
    });

    // The "MCP server" side: post a compaction request with a handoff
    const mcpSeat = channel.join('compact', 'orchestrator', () => {});
    const request: CompactionRequest = {
      requestId: 'req-001',
      handoff: 'Current goal: issue #200. Last PR: #199. Next: #201.',
    };
    mcpSeat.send({ type: COMPACTION_REQUEST, payload: request });

    // The host received a well-formed request
    expect(hostMessages).toHaveLength(1);
    const received = hostMessages[0] as CompactionRequest;
    expect(received.requestId).toBe('req-001');
    expect(received.handoff).toContain('issue #200');
  });

  it('the host side posts a well-formed COMPACTION_RESPONSE, the MCP server side receives it', async () => {
    const channel = new InMemoryChannel();

    // The "MCP server" side: capture response
    const responses: unknown[] = [];
    channel.join('compact', 'orchestrator', (msg) => {
      if (msg.type === COMPACTION_RESPONSE) responses.push(msg.payload);
    });

    // The "host" side: send response
    const hostSeat = channel.join('host', 'planner', () => {});
    const response: CompactionResponse = { requestId: 'req-001' };
    hostSeat.send({ type: COMPACTION_RESPONSE, payload: response });

    expect(responses).toHaveLength(1);
    const r = responses[0] as CompactionResponse;
    expect(r.requestId).toBe('req-001');
    expect(r.error).toBeUndefined();
  });

  it('the host can reject with an error', () => {
    const channel = new InMemoryChannel();
    const responses: unknown[] = [];
    channel.join('compact', 'orchestrator', (msg) => {
      if (msg.type === COMPACTION_RESPONSE) responses.push(msg.payload);
    });
    const hostSeat = channel.join('host', 'planner', () => {});
    const response: CompactionResponse = { requestId: 'req-002', error: 'compaction already pending' };
    hostSeat.send({ type: COMPACTION_RESPONSE, payload: response });

    const r = responses[0] as CompactionResponse;
    expect(r.error).toBe('compaction already pending');
  });

  it('COMPACTION_GENERATION bookkeeping message has the right shape', () => {
    const channel = new InMemoryChannel();
    const received: unknown[] = [];
    channel.join('log-observer', 'planner', (msg) => {
      if (msg.type === COMPACTION_GENERATION) received.push(msg.payload);
    });

    const hostSeat = channel.join('host', 'planner', () => {});
    const payload: CompactionGenerationPayload = { generation: 3 };
    hostSeat.send({ type: COMPACTION_GENERATION, payload });

    expect(received).toHaveLength(1);
    expect((received[0] as CompactionGenerationPayload).generation).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getContextNote injection into orchestrator turns (#165)
// ---------------------------------------------------------------------------

import { createClaudeCodeResponder, ZERO_USAGE, type Usage } from './claude-code-responder.ts';
import type { Message } from '../core/channel.ts';

describe('getContextNote injection into orchestrator prompt (#165)', () => {
  it('getContextNote return value is injected between attribution and body', async () => {
    const prompts: string[] = [];
    const fakeRun = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return 'ok';
    };

    const responder = createClaudeCodeResponder({
      workdir: '/tmp',
      claudeSessionId: 'test-uuid-1234-5678-9abc-def012345678',
      run: fakeRun as never,
      sleep: async () => {},
      getContextNote: () => '[Context size: 123K wt — below threshold]',
    });

    const message: Message = { from: 'planner', role: 'planner', type: 'text', payload: 'do a thing' };
    await responder(message);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    // Attribution first
    expect(prompt).toContain('[Message from architect');
    // Context note between attribution and body
    const attrEnd = prompt.indexOf('[Message from architect');
    const noteStart = prompt.indexOf('[Context size:');
    const bodyStart = prompt.indexOf('do a thing');
    expect(attrEnd).toBeLessThan(noteStart);
    expect(noteStart).toBeLessThan(bodyStart);
  });

  it('when getContextNote is omitted, the prompt is unchanged (no regression)', async () => {
    const prompts: string[] = [];
    const fakeRun = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return 'ok';
    };

    const responder = createClaudeCodeResponder({
      workdir: '/tmp',
      claudeSessionId: 'test-uuid-1234-5678-9abc-def012345678',
      run: fakeRun as never,
      sleep: async () => {},
    });

    const message: Message = { from: 'planner', role: 'planner', type: 'text', payload: 'do a thing' };
    await responder(message);

    // Prompt has attribution + body, no context note
    expect(prompts[0]).not.toContain('[Context size:');
    expect(prompts[0]).toContain('do a thing');
  });

  it('context note reflects threshold verdict when above threshold', async () => {
    // Verify the note format used by the extension's getContextNote closure by testing
    // the format string logic directly. The extension builds: "[Context size: X wt — verdict]"
    // The below tests the threshold comparison logic used when wiring getContextNote.
    function makeContextNote(weightedTokens: number, threshold: number): string {
      const fmtK = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
      const aboveThreshold = weightedTokens > threshold;
      const verdict = aboveThreshold
        ? `⚠ PAST THRESHOLD — after integrating the current task, write a self-hand-off and call mcp__compact__request.`
        : `Below threshold — continue.`;
      return `[Context size: ${fmtK(weightedTokens)} weighted tokens (threshold ${fmtK(threshold)} wt). ${verdict}]`;
    }

    const belowNote = makeContextNote(200_000, 500_000);
    expect(belowNote).toContain('Below threshold');
    expect(belowNote).not.toContain('PAST THRESHOLD');

    const aboveNote = makeContextNote(600_000, 500_000);
    expect(aboveNote).toContain('PAST THRESHOLD');
    expect(aboveNote).toContain('mcp__compact__request');
  });
});

// ---------------------------------------------------------------------------
// Hand-off as first message: the host composes a fresh session's first prompt
// (#165 restart sequencing)
// ---------------------------------------------------------------------------

describe('compaction restart — hand-off as first channel message (#165)', () => {
  it('posts the hand-off to the channel before the agent starts so it is replayed on open', () => {
    // This mirrors the logic in launchSession: when compactionHandoff is present,
    // the channel receives a planner-role text message with the handoff before anything else.
    const channel = new InMemoryChannel();
    const received: Message[] = [];
    channel.join('agent', 'orchestrator', (msg) => received.push(msg));

    // Simulate the host posting the handoff (as launchSession does for a compaction restart)
    const handoffSeat = channel.join('compaction-handoff', 'planner', () => {});
    const handoff = 'Current goal: issue #200. Recent: PR #199 closed. Next: #201.';
    handoffSeat.send({ type: 'text', payload: handoff });
    handoffSeat.close();

    // The agent sees the handoff as its first message, attributed to planner (authoritative)
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      from: 'compaction-handoff',
      role: 'planner',
      type: 'text',
      payload: handoff,
    });
  });
});
