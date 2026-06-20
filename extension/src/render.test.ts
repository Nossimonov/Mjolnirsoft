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
      from: 'executor-1',
      role: 'executor',
      type: 'result',
      payload: '# Done\n\n```mermaid\ngraph TD; A-->B\n```',
    };
    const html = renderMessage(message);
    expect(html).toContain('executor-1 · result');
    expect(html).toContain('<h1>Done</h1>');
    expect(html).toContain('<pre class="mermaid">');
  });

  it('renders a non-string payload as a JSON code block', () => {
    const html = renderMessage({ from: 'orchestrator', role: 'planner', type: 'task', payload: { id: 42 } });
    expect(html).toContain('orchestrator · task');
    expect(html).toContain('42');
  });

  it('styles an error turn distinctly via the `error` class, not the sender hue (#89)', () => {
    const html = renderMessage({
      from: 'executor-1',
      role: 'executor',
      type: 'error',
      payload: 'executor executor-1 failed to respond: Error: claude exited 401',
    });
    expect(html).toContain('class="turn error"'); // theme warning colour via CSS, not an inline hue
    expect(html).not.toContain('hsl('); // not the per-sender hue style
    expect(html).toContain('executor-1 · error');
    expect(html).toContain('claude exited 401');
  });

  it('colours the turn by its sender, keyed on `from`', () => {
    const user = renderMessage({ from: 'vscode-view', role: 'planner', type: 'text', payload: 'hi' });
    expect(user).toContain(`hsl(${hueForSender('vscode-view')} `); // styled by the sender's hue
    const executor = renderMessage({ from: 'demo-executor', role: 'executor', type: 'result', payload: 'hi' });
    expect(user).not.toBe(executor); // different senders render distinctly
  });
});

describe('renderInteractionRequest', () => {
  const request: InteractionRequest = {
    requestId: 'req-7',
    toolName: 'Write',
    input: { file_path: '/etc/hosts', content: '127.0.0.1' },
    toolUseId: 'toolu_1',
  };

  it('renders a permission card naming the tool, with allow/always/deny keyed by request id', () => {
    const html = renderInteractionRequest(request);
    expect(html).toContain('<strong>Write</strong>');
    expect(html).toContain('data-request-id="req-7"');
    expect(html).toContain('data-behavior="allow"');
    expect(html).toContain('data-behavior="always"'); // the learn-from-decision choice (#70)
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

  it('renders an AskUserQuestion as selectable options, not an allow/deny card', () => {
    const html = renderInteractionRequest({
      requestId: 'q-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            options: [
              { label: 'Red', description: 'warm' },
              { label: 'Blue', description: 'cool' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    expect(html).toContain('AskUserQuestion');
    expect(html).toContain('data-question="Which color?"');
    expect(html).toContain('data-multi="false"');
    expect(html).toContain('data-label="Red"');
    expect(html).toContain('data-label="Blue"');
    expect(html).toContain('submit-answers');
    expect(html).not.toContain('data-behavior'); // not the permission card
  });

  it('marks multi-select questions so several options can be picked', () => {
    const html = renderInteractionRequest({
      requestId: 'q-2',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which sections?', options: [{ label: 'Intro' }, { label: 'Outro' }], multiSelect: true }] },
    });
    expect(html).toContain('data-multi="true"');
  });

  it('escapes HTML in question text and option labels', () => {
    const html = renderInteractionRequest({
      requestId: 'q-3',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'A "<b>" choice?', options: [{ label: '<i>x</i>' }, { label: 'y' }], multiSelect: false }] },
    });
    expect(html).toContain('&quot;'); // quote escaped for the data- attribute
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>x</i>');
  });
});

describe('hueForSender', () => {
  it('is stable for a given sender and within 0–359', () => {
    expect(hueForSender('vscode-view')).toBe(hueForSender('vscode-view'));
    for (const id of ['a', 'vscode-view', 'orchestrator', 'demo-executor']) {
      const h = hueForSender(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
