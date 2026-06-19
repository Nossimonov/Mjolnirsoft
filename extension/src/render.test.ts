import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderMessage, hueForSender, renderInteractionRequest } from './render.ts';
import type { Message } from '../../src/core/channel.ts';
import type { InteractionRequest } from '../../src/core/interaction.ts';

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

  it('colours the turn by its sender, keyed on `from`', () => {
    const user = renderMessage({ from: 'vscode-view', type: 'text', payload: 'hi' });
    expect(user).toContain(`hsl(${hueForSender('vscode-view')} `); // styled by the sender's hue
    const worker = renderMessage({ from: 'demo-worker', type: 'result', payload: 'hi' });
    expect(user).not.toBe(worker); // different senders render distinctly
  });
});

describe('renderInteractionRequest', () => {
  const request: InteractionRequest = {
    requestId: 'req-7',
    toolName: 'Write',
    input: { file_path: '/etc/hosts', content: '127.0.0.1' },
    toolUseId: 'toolu_1',
  };

  it('renders a permission card naming the tool, with allow/deny keyed by request id', () => {
    const html = renderInteractionRequest(request);
    expect(html).toContain('<strong>Write</strong>');
    expect(html).toContain('data-request-id="req-7"');
    expect(html).toContain('data-behavior="allow"');
    expect(html).toContain('data-behavior="deny"');
  });

  it('shows the tool input so the human can judge the request', () => {
    const html = renderInteractionRequest(request);
    expect(html).toContain('/etc/hosts');
  });

  it('escapes HTML in the input preview', () => {
    const html = renderInteractionRequest({ requestId: 'r', toolName: 'Bash', input: { command: 'echo "<script>"' } });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('hueForSender', () => {
  it('is stable for a given sender and within 0–359', () => {
    expect(hueForSender('vscode-view')).toBe(hueForSender('vscode-view'));
    for (const id of ['a', 'vscode-view', 'orchestrator', 'demo-worker']) {
      const h = hueForSender(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
