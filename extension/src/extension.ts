import * as vscode from 'vscode';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/core/session-store.ts';
import { WorktreeManager, type Worktree } from '../../src/core/worktree.ts';
import { loadLocalEnv } from '../../src/cli/load-local-env.ts';
import { runWorker } from '../../src/worker/worker-runtime.ts';
import { createClaudeCodeResponder } from '../../src/worker/claude-code-responder.ts';
import {
  INTERACTION_DECISION,
  INTERACTION_REQUEST,
  type InteractionRequest,
} from '../../src/core/interaction.ts';
import { renderMessage, renderInteractionRequest } from './render.ts';

// The MCP server is named `perm` in the generated config, so its `approve` tool
// is addressed as `mcp__perm__approve` to `--permission-prompt-tool`.
const PERMISSION_PROMPT_TOOL = 'mcp__perm__approve';

// Quick-pick sentinel offered above the session list; the input validation for
// session names forbids spaces/'+', so this can never collide with a real id.
const START_NEW_SESSION = '+ Start a new worker session…';

export function activate(context: vscode.ExtensionContext): void {
  const openView = vscode.commands.registerCommand('mjolnirsoft.openSessionView', async () => {
    const folder = requireFolder();
    if (!folder) return;
    const store = storeFor(folder);

    // List-or-create front door: with no sessions, skip the dead-end message and
    // take the newcomer straight into starting a worker.
    const sessions = store.list();
    if (sessions.length === 0) {
      await startWorkerSession(context, folder, store);
      return;
    }
    const pick = await vscode.window.showQuickPick([START_NEW_SESSION, ...sessions], {
      title: 'Open a Mjolnirsoft session',
      placeHolder: 'Pick a session to open, or start a new worker',
    });
    if (!pick) return;
    if (pick === START_NEW_SESSION) {
      await startWorkerSession(context, folder, store);
      return;
    }

    openSessionPanel(context, store, pick);
  });

  const startWorker = vscode.commands.registerCommand('mjolnirsoft.startWorkerSession', async () => {
    const folder = requireFolder();
    if (!folder) return;
    await startWorkerSession(context, folder, storeFor(folder));
  });

  context.subscriptions.push(openView, startWorker);
}

/**
 * Prompt for a name, spawn a worker in its own git worktree, and open its panel.
 * Shared by the "Start Worker Session" command and the "Open Session View" front
 * door, so the start-a-worker logic lives in exactly one place.
 */
async function startWorkerSession(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  store: SessionStore,
): Promise<void> {
  // The in-process worker shells out to `claude`; load machine-specific config
  // (CLAUDE_BIN) so it's found even when the extension host's PATH lacks it.
  loadLocalEnv(join(folder.uri.fsPath, '.local.env'));

  const sessionId = await vscode.window.showInputBox({
    title: 'Start a worker session',
    prompt: 'Name this session',
    placeHolder: 'e.g. add-feature-x',
    validateInput: (value) =>
      /^[A-Za-z0-9_-]+$/.test(value) ? undefined : "use letters, digits, '_' or '-'",
  });
  if (!sessionId) return;

  if (store.list().includes(sessionId)) {
    void vscode.window.showErrorMessage(`Session "${sessionId}" already exists — open it instead.`);
    return;
  }

  // Give the worker an isolated git worktree on its own branch, so it edits
  // the real repo without ever touching the developer's working tree.
  let worktree: Worktree;
  try {
    worktree = new WorktreeManager({ repoDir: folder.uri.fsPath }).create(sessionId);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not create a worktree for "${sessionId}": ${String(error)}`);
    return;
  }

  // Give the worker an escalation path: a per-session MCP config wiring Claude's
  // `--permission-prompt-tool` to our server, which bridges a gated tool use to
  // this session's channel so the human can allow/deny it in the panel (#66).
  const permParticipantId = `${sessionId}-perms`;
  const mcpConfigPath = writePermissionMcpConfig(context, store.logPath(sessionId), permParticipantId);

  // Spawn the worker in-process: it joins the session and answers each message
  // by running a headless Claude Code agent with the worktree as its workspace.
  const workerChannel = store.open(sessionId);
  const worker = runWorker(
    workerChannel,
    `${sessionId}-worker`,
    createClaudeCodeResponder({
      workdir: worktree.path,
      permissionPromptTool: PERMISSION_PROMPT_TOOL,
      mcpConfigPath,
    }),
  );

  openSessionPanel(context, store, sessionId, {
    onDispose: () => {
      worker.close();
      workerChannel.close();
      rmSync(mcpConfigPath, { force: true });
      // System capture: commit whatever the worker changed onto its branch,
      // then drop the worktree (the branch survives for review).
      const captured = worktree.commit(`Mjolnir worker session ${sessionId}`);
      worktree.remove();
      void vscode.window.showInformationMessage(
        captured
          ? `Worker session "${sessionId}" ended — review its work on branch ${worktree.branch}.`
          : `Worker session "${sessionId}" ended — it made no changes (branch ${worktree.branch}).`,
      );
    },
  });
  void vscode.window.showInformationMessage(
    `Worker session "${sessionId}" started on branch ${worktree.branch} — type a task in the panel.`,
  );
}

export function deactivate(): void {}

function requireFolder(): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a workspace folder to use Mjolnirsoft sessions.');
  }
  return folder;
}

function storeFor(folder: vscode.WorkspaceFolder): SessionStore {
  return new SessionStore({ baseDir: vscode.Uri.joinPath(folder.uri, '.mjolnir', 'sessions').fsPath });
}

/** Open a webview panel attached to a session: replay history, stream live, compose. */
function openSessionPanel(
  context: vscode.ExtensionContext,
  store: SessionStore,
  sessionId: string,
  options: { onDispose?: () => void } = {},
): void {
  const panel = vscode.window.createWebviewPanel(
    'mjolnirsoftSessionView',
    `Session: ${sessionId}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      // Keep the webview alive while hidden so switching editor tabs doesn't
      // destroy the conversation (and unsent composer text). History is only
      // replayed once at join, so a recreated webview would come back empty.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    },
  );
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  // Attach to the session: replay history, then stream live messages.
  const channel = store.open(sessionId, { replay: true });
  // Pending interactions by request id, so a decision from the webview (which
  // only knows the id + the user's picks) can be assembled against the original
  // request — e.g. echoing a question's `questions` back alongside the answers.
  const pendingRequests = new Map<string, InteractionRequest>();
  const participant = channel.join('vscode-view', 'planner', (message) => {
    // An interaction request means the worker is blocked waiting on us — render
    // its card and keep the "working" indicator on (it hasn't replied yet).
    if (message.type === INTERACTION_REQUEST) {
      const request = message.payload as InteractionRequest;
      pendingRequests.set(request.requestId, request);
      void panel.webview.postMessage({ kind: 'message', html: renderInteractionRequest(request) });
      return;
    }
    void panel.webview.postMessage({ kind: 'message', html: renderMessage(message) });
    // A reply (result/text) from another participant means the worker is done — stop "working".
    void panel.webview.postMessage({ kind: 'working', on: false });
  });

  // Compose-and-send: one (possibly multi-line) message per send. The channel
  // doesn't echo a participant's own messages, so render the sent turn locally.
  panel.webview.onDidReceiveMessage(
    (event: {
      kind?: string;
      text?: string;
      requestId?: string;
      behavior?: 'allow' | 'deny';
      answers?: Record<string, string | string[]>;
    }) => {
      if (event.kind === 'send' && event.text) {
        const sent = { from: 'vscode-view', type: 'text', payload: event.text };
        void panel.webview.postMessage({ kind: 'message', html: renderMessage(sent) });
        participant.send({ type: 'text', payload: event.text });
        // We just sent — show "working" until a reply arrives.
        void panel.webview.postMessage({ kind: 'working', on: true });
      } else if (event.kind === 'decision' && event.requestId) {
        const request = pendingRequests.get(event.requestId);
        pendingRequests.delete(event.requestId);
        if (event.answers) {
          // Clarifying question: echo the original `questions` back with the
          // picks, the shape AskUserQuestion expects, as the allow's updatedInput.
          const questions = (request?.input as { questions?: unknown[] } | undefined)?.questions ?? [];
          participant.send({
            type: INTERACTION_DECISION,
            payload: { requestId: event.requestId, behavior: 'allow', updatedInput: { questions, answers: event.answers } },
          });
        } else if (event.behavior) {
          // Permission: a verdict + requestId is enough; the server fills the
          // original input on a bare allow.
          participant.send({ type: INTERACTION_DECISION, payload: { requestId: event.requestId, behavior: event.behavior } });
        }
        // The worker resumes once it has our answer, so show "working" again.
        void panel.webview.postMessage({ kind: 'working', on: true });
      }
    },
  );

  panel.onDidDispose(() => {
    participant.close();
    channel.close();
    options.onDispose?.();
  });
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Mjolnirsoft Session View</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); display: flex; flex-direction: column; }
  #content { flex: 1; overflow-y: auto; padding: 0 1rem; }
  .turn { padding: 0.4rem 0.6rem; margin: 0.45rem 0; border-radius: 4px; }
  .from { font-size: 0.8em; opacity: 0.7; margin-bottom: 0.25rem; }
  .mermaid { background: #fff; padding: 0.5rem; border-radius: 4px; }
  #working { padding: 0.25rem 1rem; font-size: 0.85em; opacity: 0.75; }
  #working[hidden] { display: none; }
  #composer { display: flex; gap: 0.5rem; padding: 0.5rem 1rem; border-top: 1px solid var(--vscode-panel-border); }
  #input { flex: 1; min-height: 3em; font: inherit; resize: vertical; padding: 0.4rem;
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border, transparent); }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
          border: none; padding: 0 1rem; cursor: pointer; }
  .interaction-input { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
                       padding: 0.4rem; border-radius: 3px; font-size: 0.85em; max-height: 12em; overflow-y: auto; }
  .decision { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .decide { border: none; padding: 0.25rem 0.9rem; cursor: pointer; border-radius: 3px;
            background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); }
  .decide[data-behavior="allow"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .decide:disabled { opacity: 0.5; cursor: default; }
  .decided { font-size: 0.85em; opacity: 0.8; align-self: center; }
  .question { margin: 0.5rem 0; }
  .question.unanswered .q-text { color: var(--vscode-inputValidation-errorForeground, #f48771); }
  .q-text { margin-bottom: 0.35rem; }
  .q-hint { font-size: 0.85em; opacity: 0.7; }
  .options { display: flex; flex-direction: column; gap: 0.3rem; }
  .opt { text-align: left; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px;
         padding: 0.3rem 0.6rem; cursor: pointer; background: transparent; color: var(--vscode-foreground); }
  .opt.selected { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .opt:disabled { opacity: 0.55; cursor: default; }
  .opt-desc { opacity: 0.7; }
  .submit-answers { border: none; padding: 0.25rem 0.9rem; cursor: pointer; border-radius: 3px;
                    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .submit-answers:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="content"></div>
<div id="working" hidden>● worker is working…</div>
<div id="composer">
  <textarea id="input" placeholder="Type a message (Markdown + Mermaid). Enter to send, Shift+Enter for a new line."></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * Write a per-session MCP config that wires Claude's `--permission-prompt-tool`
 * to our bundled permission server, and return its path. The server is launched
 * with the extension host's own Node (Electron run as Node, so no separate Node
 * on PATH is needed) and told — via env — which session log to bridge over and
 * what channel id to use. Returns the temp path; the caller deletes it on close.
 */
function writePermissionMcpConfig(
  context: vscode.ExtensionContext,
  sessionLogPath: string,
  participantId: string,
): string {
  const serverPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'permission-mcp-server.js').fsPath;
  const config = {
    mcpServers: {
      perm: {
        command: process.execPath,
        args: [serverPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          MJOLNIR_SESSION_LOG: sessionLogPath,
          MJOLNIR_PERM_ID: participantId,
        },
      },
    },
  };
  const configPath = join(tmpdir(), `mjolnir-perm-${participantId}-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
