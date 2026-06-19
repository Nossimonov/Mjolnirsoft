import mermaid from 'mermaid';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

mermaid.initialize({ startOnLoad: false });
const vscode = acquireVsCodeApi();

const content = document.getElementById('content');
const input = document.getElementById('input') as HTMLTextAreaElement | null;
const send = document.getElementById('send');
const working = document.getElementById('working');

// The extension host posts one rendered message (HTML) at a time — replayed
// history first, then live (and a local echo of what we send) — and toggles a
// "working" indicator while a reply is pending. Append messages and render any
// new Mermaid diagrams.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { kind?: string; html?: string; on?: boolean };
  if (data.kind === 'message' && data.html && content) {
    content.insertAdjacentHTML('beforeend', data.html);
    void mermaid.run();
    content.scrollTop = content.scrollHeight;
  } else if (data.kind === 'working' && working) {
    working.toggleAttribute('hidden', !data.on);
  }
});

// Compose a whole (multi-line) message and send it as one — no terminal
// line-by-line constraint here. Enter sends; Shift+Enter inserts a newline.
function sendMessage(): void {
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ kind: 'send', text });
  input.value = '';
}

send?.addEventListener('click', sendMessage);
input?.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
