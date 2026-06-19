import MarkdownIt from 'markdown-it';
import type { Message } from '../../src/core/channel.ts';

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
