import * as vscode from 'vscode';
import { join } from 'node:path';
import { SessionStore } from '../../src/core/session-store.ts';
import { WorktreeManager, type Worktree } from '../../src/core/worktree.ts';
import { loadLocalEnv } from '../../src/cli/load-local-env.ts';
import { runWorker } from '../../src/worker/worker-runtime.ts';
import { createClaudeCodeResponder } from '../../src/worker/claude-code-responder.ts';
import { renderMessage } from './render.ts';

export function activate(context: vscode.ExtensionContext): void {
  const openView = vscode.commands.registerCommand('mjolnirsoft.openSessionView', async () => {
    const folder = requireFolder();
    if (!folder) return;
    const store = storeFor(folder);

    const sessions = store.list();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No sessions yet — run "Mjolnirsoft: Start Worker Session" first.');
      return;
    }
    const sessionId = await vscode.window.showQuickPick(sessions, {
      title: 'Open a Mjolnirsoft session',
      placeHolder: 'Pick a session to open',
    });
    if (!sessionId) return;

    openSessionPanel(context, store, sessionId);
  });

  const startWorker = vscode.commands.registerCommand('mjolnirsoft.startWorkerSession', async () => {
    const folder = requireFolder();
    if (!folder) return;
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

    const store = storeFor(folder);
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

    // Spawn the worker in-process: it joins the session and answers each message
    // by running a headless Claude Code agent with the worktree as its workspace.
    const workerChannel = store.open(sessionId);
    const worker = runWorker(
      workerChannel,
      `${sessionId}-worker`,
      createClaudeCodeResponder({ workdir: worktree.path }),
    );

    openSessionPanel(context, store, sessionId, {
      onDispose: () => {
        worker.close();
        workerChannel.close();
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
  });

  context.subscriptions.push(openView, startWorker);
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
  const participant = channel.join('vscode-view', 'planner', (message) => {
    void panel.webview.postMessage({ kind: 'message', html: renderMessage(message) });
    // A message from another participant means the worker has replied — stop "working".
    void panel.webview.postMessage({ kind: 'working', on: false });
  });

  // Compose-and-send: one (possibly multi-line) message per send. The channel
  // doesn't echo a participant's own messages, so render the sent turn locally.
  panel.webview.onDidReceiveMessage((event: { kind?: string; text?: string }) => {
    if (event.kind === 'send' && event.text) {
      const sent = { from: 'vscode-view', type: 'text', payload: event.text };
      void panel.webview.postMessage({ kind: 'message', html: renderMessage(sent) });
      participant.send({ type: 'text', payload: event.text });
      // We just sent — show "working" until a reply arrives.
      void panel.webview.postMessage({ kind: 'working', on: true });
    }
  });

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

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
