import mermaid from 'mermaid';
import { formatElapsed } from '../elapsed.ts';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

mermaid.initialize({ startOnLoad: false });
const vscode = acquireVsCodeApi();

const content = document.getElementById('content');
const input = document.getElementById('input') as HTMLTextAreaElement | null;
const send = document.getElementById('send');
const working = document.getElementById('working');
const workingHeader = document.getElementById('working-header');
const queued = document.getElementById('queued');
const notice = document.getElementById('notice');
const usage = document.getElementById('usage');

// Client-side elapsed timer for the "working" indicator. The host only tells us
// when a turn starts and ends; we tick the seconds locally so a long run
// visibly progresses (and looks alive rather than wedged). Reset each turn.
let workingSince: number | null = null;
let tick: ReturnType<typeof setInterval> | null = null;

function renderWorking(): void {
  if (!workingHeader || workingSince === null) return;
  workingHeader.textContent = `● executor is working… ${formatElapsed(Date.now() - workingSince)}`;
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
  // The turn is over. Normally the digest message already settled the reasoning box
  // (collapsed in place); this collapses any box left open by a turn that ended
  // without a digest (e.g. an error mid-stream) so it never sits expanded.
  collapseReasoning();
}

// The executor's live reasoning (#108) renders as one block-level box per turn. The
// host posts a fully-rendered HTML snapshot (the *same* markup as the persisted
// digest, #110) each time the trail gains a block, and we replace the box in place —
// so it builds up block-by-block while the turn runs, then settles collapsed without
// a view swap. These posts are ephemeral (never from the channel, never logged). The
// turn's final answer is not in this box; it arrives as its own result bubble.
let currentReasoningBox: HTMLElement | null = null;

// Render the latest reasoning snapshot, replacing the in-progress box in place — or
// creating it at the end of the conversation on the turn's first snapshot.
function setReasoning(html: string): void {
  if (!content) return;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const next = template.content.firstElementChild as HTMLElement | null;
  if (!next) return;
  if (currentReasoningBox) currentReasoningBox.replaceWith(next);
  else content.appendChild(next);
  currentReasoningBox = next;
  content.scrollTop = content.scrollHeight;
}

// Stop tracking the current box so the next turn starts a fresh one. The digest's
// final (collapsed) render already replaced the in-progress box just before this, so
// the box stays in the conversation, settled.
function settleReasoning(): void {
  currentReasoningBox = null;
}

// Safety net: if a turn ends without a digest settling the box (e.g. it errored
// mid-stream), collapse whatever's still open so it doesn't sit expanded.
function collapseReasoning(): void {
  const details = currentReasoningBox?.querySelector('details');
  if (details) details.removeAttribute('open');
  currentReasoningBox = null;
}

// Show how many messages are waiting behind the in-flight turn. The executor
// serializes turns (#100), so a message typed mid-turn is queued, not run now;
// the cue keeps that visible rather than letting it look ignored. Count 0 hides.
function setQueued(count: number): void {
  if (!queued) return;
  if (count > 0) {
    queued.textContent = `↳ ${count} message${count === 1 ? '' : 's'} queued — waiting for the current turn to finish`;
    queued.removeAttribute('hidden');
  } else {
    queued.setAttribute('hidden', '');
  }
}

// The extension host posts one rendered message (HTML) at a time — replayed
// history first, then live (and a local echo of what we send) — plus "working"
// toggles while a reply is pending and a "notice" when a send has no executor to
// answer it. The host owns both decisions (it knows whether an executor is
// attached), so the webview just renders what it's told. Append messages and
// render any new Mermaid diagrams.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {
    kind?: string;
    html?: string;
    on?: boolean;
    text?: string;
    count?: number;
  };
  if (data.kind === 'message' && data.html && content) {
    content.insertAdjacentHTML('beforeend', data.html);
    void mermaid.run();
    content.scrollTop = content.scrollHeight;
  } else if (data.kind === 'working') {
    if (data.on) startWorking();
    else stopWorking();
  } else if (data.kind === 'reasoning' && data.html) {
    setReasoning(data.html);
  } else if (data.kind === 'reasoning-settle') {
    settleReasoning();
  } else if (data.kind === 'usage' && usage) {
    // The running token tally (#116) in the session header; empty until first usage.
    usage.textContent = data.text ? ` · ${data.text}` : '';
  } else if (data.kind === 'queued') {
    setQueued(data.count ?? 0);
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

  // Auth-failure card (#90). "Log in again" asks the host to open a terminal
  // running `claude auth login`; it stays clickable (you may need to log in
  // before retrying). "Retry" re-sends the held failed task and locks the card —
  // if it fails again, a fresh failure renders its own new card.
  if (button.classList.contains('auth-login')) {
    vscode.postMessage({ kind: 'auth-login' });
    return;
  }
  if (button.classList.contains('auth-retry')) {
    vscode.postMessage({ kind: 'auth-retry' });
    const actions = button.closest('.auth-actions') as HTMLElement | null;
    if (actions) lockCard(actions, 'retried');
    return;
  }

  // "Can't answer" toggle: show/hide the free-text reply area.
  if (button.classList.contains('cant-answer-toggle')) {
    const turn = button.closest('.turn') as HTMLElement | null;
    const section = turn?.querySelector('.cant-answer-section') as HTMLElement | null;
    if (!section) return;
    if (section.hasAttribute('hidden')) {
      section.removeAttribute('hidden');
      (section.querySelector('.cant-answer-input') as HTMLTextAreaElement | null)?.focus();
    } else {
      section.setAttribute('hidden', '');
    }
    return;
  }

  // Free-text "can't answer" submission: deny with a reason the agent reads (#96).
  if (button.classList.contains('cant-answer-send')) {
    const section = button.closest('.cant-answer-section') as HTMLElement | null;
    const requestId = section?.getAttribute('data-request-id');
    const textarea = section?.querySelector('.cant-answer-input') as HTMLTextAreaElement | null;
    if (!section || !requestId) return;
    const message = textarea?.value.trim() || "Can't answer — none of the preset options fit.";
    vscode.postMessage({ kind: 'decision', requestId, behavior: 'deny', message });
    const turn = section.closest('.turn') as HTMLElement | null;
    const decisionDiv = turn?.querySelector('.decision') as HTMLElement | null;
    if (decisionDiv) lockCard(decisionDiv, "can't answer — explanation sent");
    section.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    if (textarea) textarea.disabled = true;
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
    // Also lock the "can't answer" section if the architect had opened it before
    // choosing a preset — prevents a stale "Send explanation" from posting a second decision.
    const cantAnswerSection = turn.querySelector('.cant-answer-section') as HTMLElement | null;
    cantAnswerSection?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    const cantAnswerTextarea = cantAnswerSection?.querySelector('.cant-answer-input') as HTMLTextAreaElement | null;
    if (cantAnswerTextarea) cantAnswerTextarea.disabled = true;
    return;
  }
});
