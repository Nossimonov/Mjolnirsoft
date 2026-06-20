/**
 * The executor's permission-prompt MCP server (#66).
 *
 * Claude Code spawns this as a subprocess for an executor run, named by
 * `--permission-prompt-tool mcp__perm__approve`. When the executor's agent tries a
 * tool use Claude won't auto-approve (e.g. a write outside its worktree), Claude
 * calls our `approve` tool with `{ tool_name, input, tool_use_id }`; we surface
 * it to the human over the executor's session channel and block until they decide,
 * then return the allow/deny verdict Claude expects. The session channel is the
 * bridge — file-backed and cross-process — so this standalone process and the
 * VS Code view meet on the same log without any extra transport.
 *
 * Configured entirely by env so the same binary serves any session:
 *   MJOLNIR_SESSION_LOG  — absolute path to the session's JSONL channel log
 *   MJOLNIR_PERM_ID      — this participant's channel id (unique per session)
 *   MJOLNIR_PROJECT_DIR  — project root holding learned "Always" rules (#70);
 *                          a request matching one is auto-allowed without a
 *                          prompt. Unset disables auto-allow (every request asks).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FileChannel } from '../core/file-channel.ts';
import { createPermissionBridge } from './permission-bridge.ts';
import { approveToolUse } from './permission-approval.ts';

const logPath = process.env.MJOLNIR_SESSION_LOG;
const participantId = process.env.MJOLNIR_PERM_ID ?? 'perms';
const projectDir = process.env.MJOLNIR_PROJECT_DIR;
if (!logPath) {
  process.stderr.write('permission-mcp-server: MJOLNIR_SESSION_LOG is required\n');
  process.exit(1);
}

// Tail the live session log: see the human's decisions, not replayed history.
const channel = new FileChannel(logPath);
const participant = channel.join(participantId, 'executor', (message) => bridge.handleMessage(message));
const bridge = createPermissionBridge(participant.send);

const server = new Server({ name: 'mjolnir-permission', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'approve',
      description: 'Decide whether a tool use the executor is not pre-allowed to make may proceed.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as { tool_name?: string; input?: unknown; tool_use_id?: string };
  const toolName = args.tool_name ?? 'unknown';
  // Re-read learned rules per request (cheap) so a rule learned earlier this
  // session also auto-allows; on no match this escalates exactly as #66 did.
  const verdict = await approveToolUse(
    { projectDir, bridge, postAudit: (text) => participant.send({ type: 'text', payload: text }) },
    toolName,
    args.input,
    args.tool_use_id,
  );
  return { content: [{ type: 'text', text: JSON.stringify(verdict) }] };
});

// Keep references alive for the lifetime of the stdio connection.
process.on('SIGTERM', () => {
  participant.close();
  channel.close();
  process.exit(0);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`permission-mcp-server: bridging ${logPath} as ${participantId}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`permission-mcp-server: ${String(error)}\n`);
  process.exit(1);
});
