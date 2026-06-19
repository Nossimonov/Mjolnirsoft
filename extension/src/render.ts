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

/** Render one channel message as an attributed transcript turn (Markdown + Mermaid). */
export function renderMessage(message: Message): string {
  const body =
    typeof message.payload === 'string'
      ? message.payload
      : `\`\`\`json\n${JSON.stringify(message.payload, null, 2)}\n\`\`\``;
  return `<div class="turn"><div class="from">${escapeHtml(message.from)} · ${escapeHtml(message.type)}</div>${renderMarkdown(body)}</div>`;
}
