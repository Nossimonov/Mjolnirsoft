import MarkdownIt from 'markdown-it';
import type { Message } from '../../src/core/channel.ts';
import type { InteractionRequest } from '../../src/core/interaction.ts';
import { isAuthError } from '../../src/executor/auth-error.ts';
import { REASONING_DIGEST, type ReasoningDigest, type DigestEntry } from '../../src/executor/reasoning-digest.ts';

// Two Markdown renderers that differ only in how a *single* newline is treated.
//
// `md` is the default: a lone `\n` is a soft break (whitespace), a blank line a
// paragraph — the semantics agent (executor/evaluator) output is authored
// against. `mdComposed` sets `breaks: true`, so every `\n` becomes a `<br>`.
//
// The split is the #95 decision (chosen over a global `breaks: true`): content a
// human composes — the planner's transcript turns typed into the chat box, and
// the multi-line/Markdown content an interaction card shows for review — is
// entered where pressing Enter means "new line", so its newlines must survive
// verbatim. Agent prose, by contrast, is frequently soft-wrapped at a column and
// relies on soft breaks to reflow; forcing `breaks: true` on it everywhere would
// turn that into ragged hard breaks. Scoping `breaks` to composed content keeps
// the composer faithful without regressing agent Markdown.
function createMarkdown(options: ConstructorParameters<typeof MarkdownIt>[0] = {}): MarkdownIt {
  const instance = new MarkdownIt(options);
  const defaultFence = instance.renderer.rules.fence;
  // Render fenced ```mermaid blocks as <pre class="mermaid">source</pre> so the
  // webview's mermaid.run() picks them up; everything else is normal Markdown.
  instance.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === 'mermaid') {
      return `<pre class="mermaid">${escapeHtml(token.content)}</pre>`;
    }
    return defaultFence
      ? defaultFence(tokens, idx, opts, env, self)
      : self.renderToken(tokens, idx, opts);
  };
  return instance;
}

const md = createMarkdown();
const mdComposed = createMarkdown({ breaks: true });

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

/**
 * Render human-composed Markdown (#95). Identical to {@link renderMarkdown}
 * except a single newline becomes a `<br>` (`breaks: true`), so a multi-line
 * message or card shows as entered instead of collapsing to one line. Use this
 * for content a person typed into a box; use {@link renderMarkdown} for agent
 * output, whose soft-break semantics must stay intact.
 */
export function renderComposed(markdown: string): string {
  return mdComposed.render(markdown);
}

/** A stable hue (0–359) for a sender id, so each participant gets a consistent colour. */
export function hueForSender(from: string): number {
  let hash = 0;
  for (let i = 0; i < from.length; i++) hash = (hash * 31 + from.charCodeAt(i)) % 360;
  return hash;
}

/** Render one channel message as an attributed transcript turn (Markdown + Mermaid). */
export function renderMessage(message: Message): string {
  // The durable reasoning digest (#110) is the persistent counterpart to #109's
  // live trail — rendered as its own collapsed, expandable element, available on
  // replay and to a later log-reader, distinct from the clean result below it.
  if (message.type === REASONING_DIGEST) return renderReasoningDigest(message);
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
  // Composed turns preserve their newlines (#95); agent turns (executor/evaluator)
  // keep soft-break Markdown semantics. Error turns above are always agent
  // failures, so they stay on the default renderer.
  //
  // We key on `role === 'planner'` because, in the current wiring, the only
  // `planner` turn the view renders is its *own* composed send (the channel
  // doesn't echo a participant back to itself, and `vscode-view` is the sole
  // planner on that channel). Note `role` encodes the authoritative *seat*, not
  // *authorship* — if an automated orchestrator ever emitted prose to this
  // channel as `planner`, it would get hard breaks too; revisit the discriminator
  // (e.g. a per-message "composed" flag) if that day comes.
  const renderBody = message.role === 'planner' ? renderComposed : renderMarkdown;
  // Colour every other turn by its sender, so a multi-participant conversation
  // (user, orchestrator, executors) is readable at a glance — keyed on `from`,
  // scaling to any number of participants.
  const hue = hueForSender(message.from);
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  return `<div class="turn" style="${style}"><div class="from">${escapeHtml(message.from)} · ${escapeHtml(message.type)}</div>${renderBody(body)}</div>`;
}

/**
 * Render the durable reasoning digest (#110) as a collapsed, expandable trail —
 * the persistent counterpart to #109's live `💭 Thinking`, available on replay and
 * to a later log-reader. Thinking blocks render verbatim (dimmed); each tool-use is
 * its own nested, expandable detail showing the input (the actual query/command)
 * and a trimmed result, so a post-mortem can see what was searched without the
 * conversation drowning in it. Collapsed by default so the clean result stays the
 * focus; one twisty-click reveals the reasoning.
 */
function renderReasoningDigest(message: Message): string {
  const entries = (message.payload as ReasoningDigest | undefined)?.entries ?? [];
  const hue = hueForSender(message.from);
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  const thinkCount = entries.filter((e) => e.kind === 'thinking').length;
  const toolCount = entries.filter((e) => e.kind === 'tool').length;
  const summary = `💭 Reasoning — ${thinkCount} thinking, ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
  return (
    `<div class="turn reasoning-digest" style="${style}">` +
    `<div class="from">${escapeHtml(message.from)} · reasoning</div>` +
    `<details class="reasoning-digest-trail"><summary>${escapeHtml(summary)}</summary>` +
    `<div class="digest-body">${entries.map(renderDigestEntry).join('')}</div>` +
    `</details></div>`
  );
}

/** One digest step: a verbatim thinking block, or a tool-use with its action detail. */
function renderDigestEntry(entry: DigestEntry): string {
  if (entry.kind === 'thinking') {
    return `<div class="digest-thinking">${escapeHtml(entry.text)}</div>`;
  }
  const result =
    entry.result !== undefined
      ? `<div class="digest-label">result${entry.truncated ? ' (trimmed)' : ''}:</div>` +
        `<pre class="interaction-input">${escapeHtml(entry.result)}</pre>`
      : '';
  return (
    `<details class="digest-tool"><summary>⚙ ${escapeHtml(entry.name)}</summary>` +
    `<div class="digest-label">input:</div>` +
    `<pre class="interaction-input">${escapeHtml(previewInput(entry.input))}</pre>` +
    result +
    `</details>`
  );
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
      const header = q.header ? `<strong>${escapeHtml(q.header)}</strong>` : '';
      const hint = q.multiSelect ? `<span class="q-hint">(choose one or more)</span>` : '';
      const meta = [header, hint].filter(Boolean).join(' · ');
      // Render the question itself as composed Markdown (#95): a question card may
      // carry multi-line or Markdown content for review (e.g. an executor's drafted
      // role text, #93), which collapses to one line under plain escaping. The raw
      // text still rides in `data-question` — the webview reads it back as the
      // answer key, so the display rendering must not touch it.
      return (
        `<div class="question" data-question="${escapeHtml(q.question)}" data-multi="${q.multiSelect ? 'true' : 'false'}">` +
        `<div class="q-text">${meta ? `${meta} ` : ''}${renderComposed(q.question)}</div>` +
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
