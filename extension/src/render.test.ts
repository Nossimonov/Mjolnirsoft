import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderComposed, renderMessage, hueForSender, renderInteractionRequest } from './render.ts';
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

  it('treats a lone newline as a soft break (no <br>), preserving agent Markdown semantics (#95)', () => {
    // Agent prose is often soft-wrapped at a column; a single \n must stay a space,
    // not a hard break — the regression `breaks:true` everywhere would have caused.
    expect(renderMarkdown('line1\nline2')).not.toContain('<br');
  });
});

describe('renderComposed', () => {
  it('renders a lone newline as a hard <br>, so composed multi-line text shows as entered (#95)', () => {
    const html = renderComposed('line1\nline2');
    expect(html).toContain('<br');
    expect(html).toContain('line1');
    expect(html).toContain('line2');
  });

  it('still renders Markdown (a card may carry Markdown for review, #93)', () => {
    const html = renderComposed('a **bold** word\nand a second line');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<br');
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

  it('styles a (non-auth) error turn distinctly via the `error` class, not the sender hue (#89)', () => {
    // A generic failure — not an auth signature (#90 reroutes those to the auth
    // card), so this still exercises the plain #89 error turn.
    const html = renderMessage({
      from: 'executor-1',
      role: 'executor',
      type: 'error',
      payload: 'executor executor-1 failed to respond: Error: claude exited 1',
    });
    expect(html).toContain('class="turn error"'); // theme warning colour via CSS, not an inline hue
    expect(html).not.toContain('hsl('); // not the per-sender hue style
    expect(html).toContain('executor-1 · error');
    expect(html).toContain('claude exited 1');
  });

  it('renders an auth failure as a guided re-login card with log-in and retry actions (#90)', () => {
    const html = renderMessage({
      from: 'executor-1',
      role: 'executor',
      type: 'error',
      payload: 'executor executor-1 failed to respond: Error: OAuth token has expired',
    });
    expect(html).toContain('class="turn error auth"');
    expect(html).toContain('authentication failed');
    expect(html).toContain('class="auth-login"'); // opens `claude auth login` host-side
    expect(html).toContain('class="auth-retry"'); // re-sends the held failed task
    expect(html).toContain('OAuth token has expired'); // the raw failure, for context
  });

  it('falls back to the plain error turn for a non-auth failure (#89), not the auth card', () => {
    const html = renderMessage({
      from: 'executor-1',
      role: 'executor',
      type: 'error',
      payload: 'executor executor-1 failed to respond: Error: ENOENT spawn claude',
    });
    expect(html).toContain('class="turn error"');
    expect(html).not.toContain('auth'); // not the auth card — no log-in/retry affordance
    expect(html).not.toContain('auth-login');
  });

  it('preserves line breaks in a composed (planner) multi-line turn (#95)', () => {
    const html = renderMessage({ from: 'vscode-view', role: 'planner', type: 'text', payload: 'first line\nsecond line' });
    expect(html).toContain('<br');
    expect(html).toContain('first line');
    expect(html).toContain('second line');
  });

  it('keeps soft-break semantics for an agent (executor) turn — no <br> on a lone newline (#95)', () => {
    // The scoped fix must not regress agent Markdown: soft-wrapped agent prose
    // stays one flowing paragraph, unlike a global breaks:true.
    const html = renderMessage({ from: 'executor-1', role: 'executor', type: 'result', payload: 'first line\nsecond line' });
    expect(html).not.toContain('<br');
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

  it('renders a multi-line question with its line breaks preserved, raw text kept as the answer key (#95/#93)', () => {
    const html = renderInteractionRequest({
      requestId: 'q-ml',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{ question: 'Draft role text:\nLine one\nLine two', options: [{ label: 'OK' }, { label: 'Edit' }], multiSelect: false }],
      },
    });
    expect(html).toContain('<br'); // the display shows the line breaks
    // The raw question (newlines as \n) still rides in data-question — the webview
    // reads it back verbatim as the answer key, so the display rendering must not
    // alter it.
    expect(html).toContain('data-question="Draft role text:\nLine one\nLine two"');
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

describe('renderMessage — reasoning digest (#110)', () => {
  const digestMessage = (entries: unknown[]): Message => ({
    from: 'demo-executor',
    role: 'executor',
    type: 'reasoning-digest',
    payload: { entries },
  });

  it('renders the digest as a collapsed, expandable <details> trail (not the JSON fallback)', () => {
    const html = renderMessage(digestMessage([{ kind: 'thinking', text: 'is 91 prime?' }]));
    // A collapsed twisty (no `open` attribute), labelled as reasoning — the durable
    // counterpart to the live trail, available on replay.
    expect(html).toContain('class="reasoning-digest-trail"');
    expect(html).toContain('<summary>');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('```json'); // never the structured-payload fallback
  });

  it('renders a thinking block verbatim (escaped), dimmed', () => {
    const html = renderMessage(digestMessage([{ kind: 'thinking', text: 'check <tag> & flag' }]));
    expect(html).toContain('class="digest-thinking"');
    expect(html).toContain('check &lt;tag&gt; &amp; flag'); // verbatim, HTML-escaped
  });

  it('renders a tool-use as a nested expandable detail with its input and trimmed result', () => {
    const html = renderMessage(
      digestMessage([
        { kind: 'tool', name: 'Bash', input: { command: 'factor 91' }, result: '91: 7 13', truncated: false },
      ]),
    );
    expect(html).toContain('class="digest-tool"');
    expect(html).toContain('⚙ Bash');
    expect(html).toContain('factor 91'); // the actual command is visible for post-mortem
    expect(html).toContain('result:');
    expect(html).toContain('91: 7 13');
  });

  it('marks a trimmed tool result so a reader knows output was elided', () => {
    const html = renderMessage(
      digestMessage([{ kind: 'tool', name: 'Read', input: { file: 'a.ts' }, result: 'head…tail', truncated: true }]),
    );
    expect(html).toContain('result (trimmed):');
  });

  it('summarises the trail by counts and omits the result line for a tool that had not returned', () => {
    const html = renderMessage(
      digestMessage([
        { kind: 'thinking', text: 'plan' },
        { kind: 'tool', name: 'Write', input: { file: 'x' } },
      ]),
    );
    expect(html).toContain('1 thinking, 1 tool');
    expect(html).not.toContain('result:'); // no result captured → no result block
  });
});
