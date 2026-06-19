import * as vscode from 'vscode';
import { SessionStore } from '../../src/core/session-store.ts';
import { renderMessage } from './render.ts';

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('mjolnirsoft.openSessionView', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage('Open a workspace folder to use Mjolnirsoft sessions.');
      return;
    }
    const store = new SessionStore({
      baseDir: vscode.Uri.joinPath(folder.uri, '.mjolnir', 'sessions').fsPath,
    });

    const sessions = store.list();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No sessions yet — start a worker or planner first.');
      return;
    }
    const sessionId = await vscode.window.showQuickPick(sessions, {
      title: 'Open a Mjolnirsoft session',
      placeHolder: 'Pick a session to open',
    });
    if (!sessionId) return;

    const panel = vscode.window.createWebviewPanel(
      'mjolnirsoftSessionView',
      `Session: ${sessionId}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    panel.webview.html = renderHtml(panel.webview, context.extensionUri);

    // Attach to the session: replay history, then stream live messages.
    const channel = store.open(sessionId, { replay: true });
    const participant = channel.join('vscode-view', 'planner', (message) => {
      void panel.webview.postMessage({ kind: 'message', html: renderMessage(message) });
    });
    // History (replay) and live messages arrive via the channel's poll loop.

    // Compose-and-send from the panel: one (possibly multi-line) message per
    // send. The channel doesn't echo a participant's own messages, so render
    // the sent turn locally.
    panel.webview.onDidReceiveMessage((event: { kind?: string; text?: string }) => {
      if (event.kind === 'send' && event.text) {
        const sent = { from: 'vscode-view', type: 'text', payload: event.text };
        void panel.webview.postMessage({ kind: 'message', html: renderMessage(sent) });
        participant.send({ type: 'text', payload: event.text });
      }
    });

    panel.onDidDispose(() => {
      participant.close();
      channel.close();
    });
  });
  context.subscriptions.push(command);
}

export function deactivate(): void {}

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
  .turn { border-top: 1px solid var(--vscode-panel-border); padding: 0.5rem 0; }
  .from { font-size: 0.8em; opacity: 0.7; margin-bottom: 0.25rem; }
  .mermaid { background: #fff; padding: 0.5rem; border-radius: 4px; }
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
<div id="composer">
  <textarea id="input" placeholder="Type a message (Markdown + Mermaid supported). Ctrl/Cmd+Enter to send."></textarea>
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
