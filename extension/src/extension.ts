import * as vscode from 'vscode';
import { renderMarkdown } from './render.ts';

const SAMPLE = `# Mjolnirsoft Session View

A walking skeleton proving **Markdown** and **Mermaid** render in the webview,
before any live-session wiring.

\`\`\`mermaid
graph TD
  Orchestrator -->|task| Worker
  Worker -->|ack| Orchestrator
\`\`\`

- attributed turns in a shared transcript
- replay of prior history, then live streaming _(next slice)_
`;

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('mjolnirsoft.openSessionView', () => {
    const panel = vscode.window.createWebviewPanel(
      'mjolnirsoftSessionView',
      'Mjolnirsoft Session View',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    panel.webview.html = renderHtml(panel.webview, context.extensionUri);
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
</head>
<body>
<div id="content">${renderMarkdown(SAMPLE)}</div>
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
