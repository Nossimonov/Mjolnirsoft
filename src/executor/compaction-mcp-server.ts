/**
 * The orchestrator's compaction MCP server (#165) — the codebase's third MCP server,
 * mirroring `delegation-mcp-server.ts`.
 *
 * Claude Code spawns this as a subprocess for an orchestrator run. When the
 * orchestrator's context has grown past the configured threshold and it is at a
 * task boundary (no live delegate), it calls our `request` tool with `{ handoff }`;
 * we post a CompactionRequest onto the session channel and block until the host
 * answers with a CompactionResponse, then return the acknowledgment to Claude.
 * The host then waits for the turn to complete, increments the generation counter,
 * tears down the old session, and relaunches from the hand-off in a fresh claude
 * conversation with a generation-indexed session id.
 *
 * The session channel is the bridge — file-backed and cross-process — so this
 * standalone process and the in-host compaction listener meet on the same log
 * without any extra transport, exactly as the delegation and permission servers do.
 *
 * Configured entirely by env so the same binary serves any session:
 *   MJOLNIR_SESSION_LOG   — absolute path to the session's JSONL channel log
 *   MJOLNIR_COMPACT_ID    — this participant's channel id (unique per session)
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FileChannel } from '../core/file-channel.ts';
import {
  COMPACTION_REQUEST,
  COMPACTION_RESPONSE,
  type CompactionRequest,
  type CompactionResponse,
} from '../core/compaction-protocol.ts';
import type { Message } from '../core/channel.ts';

const logPath = process.env.MJOLNIR_SESSION_LOG;
const participantId = process.env.MJOLNIR_COMPACT_ID ?? 'compaction';
if (!logPath) {
  process.stderr.write('compaction-mcp-server: MJOLNIR_SESSION_LOG is required\n');
  process.exit(1);
}

// Tail the live session log: meet the host's compaction listener on the channel.
const channel = new FileChannel(logPath);

// Pending requests by id, resolved when the host answers with a CompactionResponse.
const pending = new Map<string, (response: CompactionResponse) => void>();

const participant = channel.join(participantId, 'orchestrator', (message: Message) => {
  if (message.type !== COMPACTION_RESPONSE) return;
  const response = message.payload as CompactionResponse | undefined;
  if (!response || typeof response.requestId !== 'string') return;
  const resolve = pending.get(response.requestId);
  if (resolve) {
    pending.delete(response.requestId);
    resolve(response);
  }
});

/**
 * Post a CompactionRequest and wait for the host's CompactionResponse. Resolves
 * when the host acknowledges — not when the restart completes (the restart happens
 * after the current turn exits). If the host reports an error, the tool surfaces it.
 */
async function requestCompaction(handoff: string): Promise<CompactionResponse> {
  const requestId = randomUUID();
  const request: CompactionRequest = { requestId, handoff };
  return new Promise<CompactionResponse>((resolve) => {
    pending.set(requestId, resolve);
    participant.send({ type: COMPACTION_REQUEST, payload: request });
  });
}

const server = new Server({ name: 'mjolnir-compaction', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'request',
      description:
        'Request a context compaction: the host will rotate your claude conversation ' +
        'after this turn completes, restarting from the hand-off you provide. ' +
        'Call this ONLY at a task boundary (no live delegate, all work integrated) ' +
        'and ONLY when the context-size note says you are past the threshold. ' +
        'The hand-off must include: current goal, recently-integrated issue/PR ids, ' +
        'and pointers to the primary sources you will need next.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff: {
            type: 'string',
            description:
              'The self-hand-off text. Must be complete enough for a fresh orchestrator ' +
              'to pick up without loss: current goal, recent integrations (issue ids, PR ' +
              'numbers), and file/issue pointers for the next task.',
          },
        },
        required: ['handoff'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'request') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  }
  const args = (req.params.arguments ?? {}) as { handoff?: string };
  if (!args.handoff?.trim()) {
    return {
      content: [{ type: 'text', text: 'compaction request requires a non-empty handoff' }],
      isError: true,
    };
  }
  const response = await requestCompaction(args.handoff);
  if (response.error) {
    return { content: [{ type: 'text', text: `compaction failed: ${response.error}` }], isError: true };
  }
  return {
    content: [
      {
        type: 'text',
        text: 'Compaction scheduled — the host will restart your session after this turn completes. Finish your reply now.',
      },
    ],
  };
});

process.on('SIGTERM', () => {
  participant.close();
  channel.close();
  process.exit(0);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`compaction-mcp-server: bridging ${logPath} as ${participantId}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`compaction-mcp-server: ${String(error)}\n`);
  process.exit(1);
});
