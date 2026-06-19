import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderMessage } from './render.ts';
import type { Message } from '../../src/core/channel.ts';

describe('renderMarkdown', () => {
  it('renders Markdown to HTML', () => {
    const html = renderMarkdown('# Title\n\nsome **bold** text');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders a mermaid fence as a <pre class="mermaid"> for the webview', () => {
    const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('graph TD; A--&gt;B'); // diagram source, HTML-escaped
  });

  it('leaves a non-mermaid code fence as a normal code block', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```');
    expect(html).toContain('<code');
    expect(html).not.toContain('class="mermaid"');
  });
});

describe('renderMessage', () => {
  it('renders an attributed turn with Markdown and a Mermaid diagram', () => {
    const message: Message = {
      from: 'worker-1',
      type: 'result',
      payload: '# Done\n\n```mermaid\ngraph TD; A-->B\n```',
    };
    const html = renderMessage(message);
    expect(html).toContain('worker-1 · result');
    expect(html).toContain('<h1>Done</h1>');
    expect(html).toContain('<pre class="mermaid">');
  });

  it('renders a non-string payload as a JSON code block', () => {
    const html = renderMessage({ from: 'orchestrator', type: 'task', payload: { id: 42 } });
    expect(html).toContain('orchestrator · task');
    expect(html).toContain('42');
  });
});
