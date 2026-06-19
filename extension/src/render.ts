import MarkdownIt from 'markdown-it';
import type { Message } from '../../src/core/channel.ts';
import type { InteractionRequest } from '../../src/core/interaction.ts';

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
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  // Colour each turn by its sender, so a multi-participant conversation (user,
  // orchestrator, workers) is readable at a glance — keyed on `from`, scaling
  // to any number of participants.
  const hue = hueForSender(message.from);
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  return `<div class="turn" style="${style}"><div class="from">${escapeHtml(message.from)} · ${escapeHtml(message.type)}</div>${renderMarkdown(body)}</div>`;
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
    // case 'AskUserQuestion': render the question's options (a later rung).
    default:
      return renderPermissionCard(request);
  }
}

/** A permission request: what the worker wants to do, with allow/deny controls. */
function renderPermissionCard(request: InteractionRequest): string {
  const hue = hueForSender('permission request');
  const style = `border-inline-start:3px solid hsl(${hue} 70% 55%);background:hsl(${hue} 70% 55% / 0.08)`;
  return (
    `<div class="turn" style="${style}">` +
    `<div class="from">permission request · ${escapeHtml(request.toolName)}</div>` +
    `<div>The worker wants to use <strong>${escapeHtml(request.toolName)}</strong> — it is not pre-allowed. Allow it?</div>` +
    `<pre class="interaction-input">${escapeHtml(previewInput(request.input))}</pre>` +
    `<div class="decision" data-request-id="${escapeHtml(request.requestId)}">` +
    `<button class="decide" data-behavior="allow">Allow</button>` +
    `<button class="decide" data-behavior="deny">Deny</button>` +
    `</div></div>`
  );
}

/** A compact, escaped preview of a tool's input for the card. */
function previewInput(input: unknown): string {
  const text = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? String(input));
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
