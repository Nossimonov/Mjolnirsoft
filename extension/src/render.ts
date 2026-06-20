import MarkdownIt from 'markdown-it';
import type { Message } from '../../src/core/channel.ts';
import type { InteractionRequest } from '../../src/core/interaction.ts';
import { isAuthError } from '../../src/executor/auth-error.ts';

const md = new MarkdownIt();
const defaultFence = md.renderer.rules.fence;

// Render fenced ```mermaid blocks as <pre class="mermaid">source</pre> so the
// webview's mermaid.run() picks them up; everything else is normal Markdown.
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === 'mermaid') {
    return `<pre class="mermaid">${escapeHtml(token.content)}</pre>`;
  }
  return defaultFence
    ? defaultFence(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

function escapeHtml(value: string): string {
  // Also escapes quotes so the same helper is safe inside `data-` attributes
  // (question text and option labels are carried there for the webview).
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render Markdown to HTML, with `mermaid` code fences prepared for the webview. */
export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}

/** A stable hue (0–359) for a sender id, so each participant gets a consistent colour. */
export function hueForSender(from: string): number {
  let hash = 0;
  for (let i = 0; i < from.length; i++) hash = (hash * 31 + from.charCodeAt(i)) % 360;
  return hash;
}

/** Render one channel message as an attributed transcript turn (Markdown + Mermaid). */
export function renderMessage(message: Message): string {
  const body =
    typeof message.payload === 'string'
      ? message.payload
      : `\`\`\`json\n${JSON.stringify(message.payload, null, 2)}\n\`\`\``;
  // An `error` turn (an executor failure, #89) is styled distinctly via the
  // `.turn.error` class — a warning colour from the theme — rather than the
  // sender hue, so a wedged/failed turn reads as a problem at a glance instead
  // of blending into the conversation. #90 layers an auth-specific card on top:
  // when the failure text matches a known auth signature, render a guided
  // re-login card instead; otherwise fall back to the plain #89 error turn.
  if (message.type === 'error') {
    if (isAuthError(body)) return renderAuthErrorCard(message, body);
    return `<div class="turn error"><div class="from">${escapeHtml(message.from)} · ${escapeHtml(message.type)}</div>${renderMarkdown(body)}</div>`;
  }
  // Colour every other turn by its sender, so a multi-participant conversation
  // (user, orchestrator, executors) is readable at a glance — keyed on `from`,
  // scaling to any number of participants.
  const hue = hueForSender(message.from);
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  return `<div class="turn" style="${style}"><div class="from">${escapeHtml(message.from)} · ${escapeHtml(message.type)}</div>${renderMarkdown(body)}</div>`;
}

/**
 * Render an auth failure (#90) as a guided-recovery card instead of a bare error
 * turn: it names the problem as expired/invalid credentials, shows the raw
 * failure for context, and offers two host-handled actions — "Log in again"
 * (opens an integrated terminal running `claude auth login`) and "Retry"
 * (re-sends the held failed task once the user is back in). No request id is
 * carried: there is a single interactive executor, so the host re-sends the
 * last-sent task on Retry. The webview wires the buttons (see `main.ts`).
 */
function renderAuthErrorCard(message: Message, body: string): string {
  return (
    `<div class="turn error auth">` +
    `<div class="from">${escapeHtml(message.from)} · authentication failed</div>` +
    `<div>The executor couldn’t authenticate — your Claude Code credentials look expired or invalid. ` +
    `Log in again, then retry the task.</div>` +
    `<pre class="interaction-input">${escapeHtml(body)}</pre>` +
    `<div class="auth-actions">` +
    `<button class="auth-login" title="Run claude auth login in an integrated terminal">Log in again</button>` +
    `<button class="auth-retry" title="Re-send the failed task">Retry</button>` +
    `</div></div>`
  );
}

/**
 * Render an agent-initiated interaction (#66) as an interactive card. Dispatches
 * on `toolName` — the seam where each interaction kind chooses its own controls:
 * a permission renders allow/deny; an `AskUserQuestion` (a later rung) renders
 * its choices. Both feed back the same `interaction-decision`, so adding a kind
 * is a new branch here plus its decision encoding, not a new protocol.
 */
export function renderInteractionRequest(request: InteractionRequest): string {
  switch (request.toolName) {
    case 'AskUserQuestion':
      return renderQuestionCard(request);
    default:
      return renderPermissionCard(request);
  }
}

/** One option of an `AskUserQuestion` (a label, with an optional description). */
interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}
/** One question Claude poses via `AskUserQuestion`. */
interface Question {
  readonly question: string;
  readonly header?: string;
  readonly options: QuestionOption[];
  readonly multiSelect?: boolean;
}

/**
 * A clarifying question (`AskUserQuestion`): each question's options as
 * selectable buttons, with a Submit. The webview tracks selection and returns
 * the picks; the answer is encoded back as `updatedInput = { questions, answers }`
 * (the shape Claude's tool expects), so no server/protocol change is needed.
 */
function renderQuestionCard(request: InteractionRequest): string {
  const questions = ((request.input as { questions?: Question[] } | undefined)?.questions) ?? [];
  const hue = hueForSender('clarifying question');
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  const questionsHtml = questions
    .map((q) => {
      const options = q.options
        .map(
          (o) =>
            `<button class="opt" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}` +
            `${o.description ? `<span class="opt-desc"> — ${escapeHtml(o.description)}</span>` : ''}</button>`,
        )
        .join('');
      const header = q.header ? `<strong>${escapeHtml(q.header)}</strong> · ` : '';
      const hint = q.multiSelect ? ' <span class="q-hint">(choose one or more)</span>' : '';
      return (
        `<div class="question" data-question="${escapeHtml(q.question)}" data-multi="${q.multiSelect ? 'true' : 'false'}">` +
        `<div class="q-text">${header}${escapeHtml(q.question)}${hint}</div>` +
        `<div class="options">${options}</div></div>`
      );
    })
    .join('');
  return (
    `<div class="turn" style="${style}">` +
    `<div class="from">clarifying question · AskUserQuestion</div>` +
    questionsHtml +
    `<div class="decision" data-request-id="${escapeHtml(request.requestId)}">` +
    `<button class="submit-answers">Submit</button>` +
    `</div></div>`
  );
}

/** A permission request: what the executor wants to do, with allow/deny controls. */
function renderPermissionCard(request: InteractionRequest): string {
  const hue = hueForSender('permission request');
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  return (
    `<div class="turn" style="${style}">` +
    `<div class="from">permission request · ${escapeHtml(request.toolName)}</div>` +
    `<div>The executor wants to use <strong>${escapeHtml(request.toolName)}</strong> — it is not pre-allowed. Allow it?</div>` +
    `<pre class="interaction-input">${escapeHtml(previewInput(request.input))}</pre>` +
    `<div class="decision" data-request-id="${escapeHtml(request.requestId)}">` +
    `<button class="decide" data-behavior="allow">Allow</button>` +
    // "Always" allows now and remembers the action, so it stops escalating (#70).
    `<button class="decide" data-behavior="always" title="Allow now and stop asking for this">Always</button>` +
    `<button class="decide" data-behavior="deny">Deny</button>` +
    `</div></div>`
  );
}

/** A compact, escaped preview of a tool's input for the card. */
function previewInput(input: unknown): string {
  const text = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? String(input));
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
