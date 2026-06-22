/**
 * The executor's delegation MCP server (#93) — the codebase's second MCP server,
 * mirroring `permission-mcp-server.ts` (#66).
 *
 * Claude Code spawns this as a subprocess for an executor run. When the executor's
 * agent wants to delegate, it calls our `spawn` tool with `{ role, task }` (or
 * `shutdown` with `{ delegateId }`); we post a delegation-request onto the
 * executor's session channel and block until the host — which owns the
 * `createDelegationManager` — answers with the delegate's id (or an error), then
 * return that to Claude. The session channel is the bridge — file-backed and
 * cross-process — so this standalone process and the in-host delegation manager
 * meet on the same log without any extra transport, exactly as the permission
 * server and the view do.
 *
 * The delegate's *report* (e.g. an evaluator's critique) does not come back
 * through this tool: the manager bridges it up onto the session channel as an
 * ordinary attributed message (#86), where it reaches the executor as a new turn
 * and renders in the view. `spawn` returns the delegate's id immediately, without
 * awaiting the report (rung-2 semantics).
 *
 * Configured entirely by env so the same binary serves any session:
 *   MJOLNIR_SESSION_LOG   — absolute path to the session's JSONL channel log
 *   MJOLNIR_DELEGATE_ID   — this participant's channel id (unique per session)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FileChannel } from '../core/file-channel.ts';
import { createDelegationBridge } from './delegation-bridge.ts';
import { projectDelegationLedger, findByDelegateId, findByTaskKey } from './delegation-ledger.ts';

const logPath = process.env.MJOLNIR_SESSION_LOG;
const participantId = process.env.MJOLNIR_DELEGATE_ID ?? 'delegation';
if (!logPath) {
  process.stderr.write('delegation-mcp-server: MJOLNIR_SESSION_LOG is required\n');
  process.exit(1);
}

// Tail the live session log: meet the host's delegation manager on the channel.
const channel = new FileChannel(logPath);
const participant = channel.join(participantId, 'executor', (message) => bridge.handleMessage(message));
const bridge = createDelegationBridge(participant.send);

const server = new Server({ name: 'mjolnir-delegation', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'spawn',
      description:
        'Delegate to a fresh-eyes agent on its own sub-channel. Use role "evaluator" to have it ' +
        'cold-read the changes/state under review and return a critique. Returns the delegate id ' +
        'immediately; the delegate\'s finding arrives later as a new message on this session.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'The delegate\'s role, e.g. "evaluator".' },
          task: { type: 'string', description: 'The opening task for the delegate (what to review and how).' },
        },
        required: ['role', 'task'],
        additionalProperties: false,
      },
    },
    {
      name: 'send',
      description:
        'Send a follow-up message to a live delegate you spawned, by its id — it continues its ' +
        'task and replies again as a new message on this session. Use it to answer a delegate\'s ' +
        'operational question (how to run a command, a path, an env var it needs). Do NOT use it to ' +
        'steer an evaluator\'s judgment or tell it what to conclude — give enablement, not opinions.',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: { type: 'string', description: 'The id of the live delegate to message.' },
          message: { type: 'string', description: 'The follow-up to send (operational enablement, not steering).' },
        },
        required: ['delegateId', 'message'],
        additionalProperties: false,
      },
    },
    {
      name: 'shutdown',
      description: 'End a delegate previously opened with spawn, by its id. Idempotent for an unknown id.',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: { type: 'string' },
        },
        required: ['delegateId'],
        additionalProperties: false,
      },
    },
    {
      name: 'lookup_delegation',
      description:
        'Look up a past delegation\'s original hand-off task and any returned reports, derived from the ' +
        'durable channel log — not from in-context memory. Use it to re-read the exact task you gave a ' +
        'delegate after context has been compacted. Provide delegateId for an exact lookup (takes priority ' +
        'if both are given), taskKey for a case-insensitive substring search (e.g. "#168", a keyword), ' +
        'or omit both to list all currently active delegations.',
      inputSchema: {
        type: 'object',
        properties: {
          delegateId: { type: 'string', description: 'Exact delegate id to look up.' },
          taskKey: {
            type: 'string',
            description: 'Substring to search in the task text (e.g. "#168", a keyword, or any fragment).',
          },
        },
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as { role?: string; task?: string; delegateId?: string; message?: string; taskKey?: string };
  if (req.params.name === 'spawn') {
    const response = await bridge.spawn(args.role ?? '', args.task ?? '');
    const text = response.error
      ? `delegation failed: ${response.error}`
      : `delegate spawned: ${response.delegateId} — its finding will arrive as a new message on this session.`;
    return { content: [{ type: 'text', text }] };
  }
  if (req.params.name === 'send') {
    const response = await bridge.message(args.delegateId ?? '', args.message ?? '');
    const text = response.error
      ? `could not deliver: ${response.error}`
      : `message delivered to ${response.delegateId} — its reply will arrive as a new message on this session.`;
    return { content: [{ type: 'text', text }] };
  }
  if (req.params.name === 'shutdown') {
    await bridge.shutdown(args.delegateId ?? '');
    return { content: [{ type: 'text', text: `delegate shut down: ${args.delegateId}` }] };
  }
  if (req.params.name === 'lookup_delegation') {
    const { delegateId, taskKey } = args;
    const entries = projectDelegationLedger(logPath);
    if (delegateId) {
      const entry = findByDelegateId(entries, delegateId);
      const text = entry
        ? JSON.stringify(entry, null, 2)
        : `no delegation found for id: ${delegateId}`;
      return { content: [{ type: 'text', text }] };
    }
    if (taskKey) {
      const matches = findByTaskKey(entries, taskKey);
      const text =
        matches.length > 0
          ? JSON.stringify(matches, null, 2)
          : `no delegations found matching: ${taskKey}`;
      return { content: [{ type: 'text', text }] };
    }
    // No filter: return active delegations (the reload-survival use case).
    const active = entries.filter((e) => e.active);
    const text =
      active.length > 0
        ? JSON.stringify(active, null, 2)
        : 'no active delegations';
    return { content: [{ type: 'text', text }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
});

// Keep references alive for the lifetime of the stdio connection.
process.on('SIGTERM', () => {
  participant.close();
  channel.close();
  process.exit(0);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`delegation-mcp-server: bridging ${logPath} as ${participantId}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`delegation-mcp-server: ${String(error)}\n`);
  process.exit(1);
});
