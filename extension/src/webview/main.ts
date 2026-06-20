import mermaid from 'mermaid';
import { formatElapsed } from '../elapsed.ts';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

mermaid.initialize({ startOnLoad: false });
const vscode = acquireVsCodeApi();

const content = document.getElementById('content');
const input = document.getElementById('input') as HTMLTextAreaElement | null;
const send = document.getElementById('send');
const working = document.getElementById('working');
const notice = document.getElementById('notice');

// Client-side elapsed timer for the "working" indicator. The host only tells us
// when a turn starts and ends; we tick the seconds locally so a long run
// visibly progresses (and looks alive rather than wedged). Reset each turn.
let workingSince: number | null = null;
let tick: ReturnType<typeof setInterval> | null = null;

function renderWorking(): void {
  if (!working || workingSince === null) return;
  working.textContent = `● executor is working… ${formatElapsed(Date.now() - workingSince)}`;
}

function startWorking(): void {
  if (!working) return;
  workingSince = Date.now();
  renderWorking();
  working.removeAttribute('hidden');
  if (tick !== null) clearInterval(tick);
  tick = setInterval(renderWorking, 1000);
}

function stopWorking(): void {
  workingSince = null;
  if (tick !== null) {
    clearInterval(tick);
    tick = null;
  }
  working?.setAttribute('hidden', '');
}

// The extension host posts one rendered message (HTML) at a time — replayed
// history first, then live (and a local echo of what we send) — plus "working"
// toggles while a reply is pending and a "notice" when a send has no executor to
// answer it. The host owns both decisions (it knows whether an executor is
// attached), so the webview just renders what it's told. Append messages and
// render any new Mermaid diagrams.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { kind?: string; html?: string; on?: boolean; text?: string };
  if (data.kind === 'message' && data.html && content) {
    content.insertAdjacentHTML('beforeend', data.html);
    void mermaid.run();
    content.scrollTop = content.scrollHeight;
  } else if (data.kind === 'working') {
    if (data.on) startWorking();
    else stopWorking();
  } else if (data.kind === 'notice' && notice) {
    notice.textContent = data.text ?? '';
    notice.removeAttribute('hidden');
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
  // The host decides whether this send gets a "working" indicator or a "no
  // executor attached" notice, since only it reliably knows the attachment state.
}

send?.addEventListener('click', sendMessage);
input?.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

// Interaction cards (#66/#68) are rendered host-side; the webview owns their
// input. Delegate clicks: permission cards send an allow/deny verdict; question
// cards toggle option selection and, on Submit, send the picked answers. Both
// post back a `decision` keyed by request id, then lock the card.
function lockCard(card: HTMLElement, note: string): void {
  card.querySelectorAll('button').forEach((button) => (button.disabled = true));
  card.insertAdjacentHTML('beforeend', `<span class="decided">${note}</span>`);
}

content?.addEventListener('click', (event: MouseEvent) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;

  // Permission allow/always/deny. "Always" allows now and asks the host to
  // remember the action so it stops escalating in future (#70).
  if (button.classList.contains('decide')) {
    const card = button.closest('.decision') as HTMLElement | null;
    const requestId = card?.getAttribute('data-request-id');
    const behavior = button.getAttribute('data-behavior');
    if (!card || !requestId || (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'always')) return;
    vscode.postMessage({ kind: 'decision', requestId, behavior });
    lockCard(card, behavior === 'allow' ? 'allowed' : behavior === 'always' ? 'always allowed' : 'denied');
    return;
  }

  // Clarifying-question option: single-select replaces, multi-select toggles.
  if (button.classList.contains('opt')) {
    const question = button.closest('.question') as HTMLElement | null;
    if (!question) return;
    question.classList.remove('unanswered');
    if (question.getAttribute('data-multi') === 'true') {
      button.classList.toggle('selected');
    } else {
      question.querySelectorAll('.opt').forEach((opt) => opt.classList.remove('selected'));
      button.classList.add('selected');
    }
    return;
  }

  // Clarifying-question submit: gather one answer per question, then send.
  if (button.classList.contains('submit-answers')) {
    const turn = button.closest('.turn') as HTMLElement | null;
    const card = button.closest('.decision') as HTMLElement | null;
    const requestId = card?.getAttribute('data-request-id');
    if (!turn || !card || !requestId) return;
    const answers: Record<string, string | string[]> = {};
    let complete = true;
    turn.querySelectorAll('.question').forEach((question) => {
      const text = question.getAttribute('data-question') ?? '';
      const multi = question.getAttribute('data-multi') === 'true';
      const picked = Array.from(question.querySelectorAll('.opt.selected')).map(
        (opt) => opt.getAttribute('data-label') ?? '',
      );
      if (picked.length === 0) {
        complete = false;
        question.classList.add('unanswered');
        return;
      }
      answers[text] = multi ? picked : picked[0];
    });
    if (!complete) return; // need every question answered before sending
    vscode.postMessage({ kind: 'decision', requestId, behavior: 'allow', answers });
    turn.querySelectorAll('.opt').forEach((opt) => ((opt as HTMLButtonElement).disabled = true));
    lockCard(card, 'answer sent');
    return;
  }
});
