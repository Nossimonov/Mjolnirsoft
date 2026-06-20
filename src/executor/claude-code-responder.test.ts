import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createClaudeCodeResponder,
  resolveClaudeBin,
  buildClaudeArgs,
  senderAttribution,
  interpretClaudeResult,
  DEFAULT_EXECUTOR_ROLE,
  EXECUTOR_PERMISSIONS,
} from './claude-code-responder.ts';
import { isAuthError } from './auth-error.ts';
import { SHARED_CORE, EXECUTOR_INSERT } from '../core/agent-instructions.ts';

const task = { from: 'orchestrator', role: 'planner', type: 'text', payload: 'write a haiku to haiku.md' } as const;

describe('interpretClaudeResult', () => {
  it('returns the result on a successful run', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'wrote haiku.md' });
    expect(interpretClaudeResult(stdout, '', 0)).toBe('wrote haiku.md');
  });

  it('surfaces the JSON `result` on failure — where claude puts the error, not stderr (#90)', () => {
    // The actual shape `claude -p --output-format json` emits when logged out:
    // exit 1, empty stderr, the error in stdout's `result` with is_error:true.
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
    let message = '';
    try {
      interpretClaudeResult(stdout, '', 1);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('Not logged in · Please run /login');
    // The whole point: the surfaced failure now carries the auth signal, so the
    // re-login card (#90) classifies it instead of seeing a blank stderr.
    expect(isAuthError(message)).toBe(true);
  });

  it('treats is_error:true as a failure even on a zero exit', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'OAuth token has expired' });
    expect(() => interpretClaudeResult(stdout, '', 0)).toThrow(/OAuth token has expired/);
  });

  it('falls back to a code message when neither stdout nor stderr carries detail', () => {
    expect(() => interpretClaudeResult('', '', 1)).toThrow(/exit 1/);
  });

  it('reports unparseable output on an otherwise-clean exit', () => {
    expect(() => interpretClaudeResult('not json', '', 0)).toThrow(/could not parse/);
  });
});

describe('DEFAULT_EXECUTOR_ROLE (executor instructions)', () => {
  it('composes the shared model, the executor insert, and operational guidance (#71)', () => {
    expect(DEFAULT_EXECUTOR_ROLE).toContain(SHARED_CORE);
    expect(DEFAULT_EXECUTOR_ROLE).toContain(EXECUTOR_INSERT);
  });

  it('carries the design-integrity classification and escalate-when-unsure bias (#71)', () => {
    expect(SHARED_CORE).toContain('route it up; never invent it');
    expect(SHARED_CORE).toContain('no agent self-approves');
    expect(SHARED_CORE).toContain('treat it as the more-escalated kind');
  });

  it('preserves the executor operational guidance', () => {
    expect(DEFAULT_EXECUTOR_ROLE).toContain('Read widely, write narrowly');
    expect(DEFAULT_EXECUTOR_ROLE).toContain("Don't commit; hand off");
  });
});

describe('createClaudeCodeResponder', () => {
  it('runs Claude Code with the task and the default executor-role prompt, replying with its result', async () => {
    const run = vi.fn().mockResolvedValue('Created haiku.md with a haiku.');
    const respond = createClaudeCodeResponder({ workdir: '/tmp/executor-1', run });

    const reply = await respond(task);

    expect(reply).toEqual({ type: 'result', payload: 'Created haiku.md with a haiku.' });
    expect(run).toHaveBeenCalledWith(
      '[Message from architect — authoritative (id: orchestrator)]\n\nwrite a haiku to haiku.md',
      expect.objectContaining({ cwd: '/tmp/executor-1', appendSystemPrompt: DEFAULT_EXECUTOR_ROLE, resume: false }),
    );
  });

  it('prefixes the prompt with the sender attribution so the agent knows who it is hearing from (#86)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });

    // From the authoritative human (planner role) vs. a peer agent (executor role).
    await respond(task);
    await respond({ from: 'executor-2', role: 'executor', type: 'text', payload: 'please review' });

    expect(run.mock.calls[0][0]).toBe(
      '[Message from architect — authoritative (id: orchestrator)]\n\nwrite a haiku to haiku.md',
    );
    expect(run.mock.calls[1][0]).toBe('[Message from agent (id: executor-2)]\n\nplease review');
  });

  it('carries a multi-line payload through to the executor with its newlines intact (#95 regression guard)', async () => {
    // The #95 fix is display-only (the VS Code view renders newlines as <br>); the
    // transported payload must keep every newline so the executor reads the message
    // as composed, not collapsed to one line.
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    await respond({ from: 'orchestrator', role: 'planner', type: 'text', payload: 'line one\nline two\n\npara two' });
    expect(run.mock.calls[0][0]).toContain('line one\nline two\n\npara two');
  });

  it('lets the caller override the appended executor-role prompt', async () => {
    const run = vi.fn().mockResolvedValue('done');
    const respond = createClaudeCodeResponder({ workdir: '/w', appendSystemPrompt: 'on branch X', run });
    await respond(task);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/w', appendSystemPrompt: 'on branch X' }),
    );
  });

  it('pins a Claude session: creates it on the first turn, resumes it on the next', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });
    await respond(task);
    await respond(task);
    expect(run.mock.calls[0][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: false });
    expect(run.mock.calls[1][1]).toMatchObject({ sessionId: 'fixed-uuid', resume: true });
  });

  it('rotates the session id after a failed first turn so a retry creates cleanly, not "already in use" (#90)', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude failed (exit 1): Not logged in · Please run /login'))
      .mockResolvedValueOnce('ok');
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });

    await expect(respond(task)).rejects.toThrow(); // first turn fails (logged out)
    await respond(task); // retry, after the user logs in

    // The retry must still *create* (no session was established), but with a
    // fresh id — reusing the failed id would collide with claude's registration.
    expect(run.mock.calls[1][1].resume).toBe(false);
    expect(run.mock.calls[1][1].sessionId).not.toBe(run.mock.calls[0][1].sessionId);
  });

  it('keeps the session id after an established session, resuming on a later failure (#90)', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('ok') // first turn establishes the session
      .mockRejectedValueOnce(new Error('claude failed (exit 1): transient'))
      .mockResolvedValueOnce('ok'); // a later retry
    const respond = createClaudeCodeResponder({ workdir: '/w', claudeSessionId: 'fixed-uuid', run });

    await respond(task);
    await expect(respond(task)).rejects.toThrow();
    await respond(task);

    // Once established, the id is kept and later turns resume — context preserved.
    const ids = run.mock.calls.map((c) => c[1].sessionId);
    expect(ids).toEqual(['fixed-uuid', 'fixed-uuid', 'fixed-uuid']);
    expect(run.mock.calls[2][1].resume).toBe(true);
  });

  it('returns undefined when Claude Code produces no result', async () => {
    const respond = createClaudeCodeResponder({ workdir: '/tmp/executor-1', run: async () => '   ' });
    expect(await respond(task)).toBeUndefined();
  });

  it('ignores permission interaction messages rather than treating them as prompts (#66)', async () => {
    const run = vi.fn().mockResolvedValue('x');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    const req = {
      from: 'p',
      role: 'planner',
      type: 'interaction-request',
      payload: { requestId: 'r', toolName: 'Write', input: {} },
    } as const;
    const dec = {
      from: 'p',
      role: 'planner',
      type: 'interaction-decision',
      payload: { requestId: 'r', behavior: 'allow' },
    } as const;
    expect(await respond(req)).toBeUndefined();
    expect(await respond(dec)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores delegation control messages rather than treating them as prompts (#93)', async () => {
    const run = vi.fn().mockResolvedValue('x');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    const req = {
      from: 'd',
      role: 'executor',
      type: 'delegation-request',
      payload: { requestId: 'r', action: 'spawn', role: 'evaluator', task: 'review' },
    } as const;
    const res = {
      from: 'host',
      role: 'planner',
      type: 'delegation-response',
      payload: { requestId: 'r', delegateId: 'x-evaluator-1' },
    } as const;
    expect(await respond(req)).toBeUndefined();
    expect(await respond(res)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('passes the permission-prompt tool and MCP config through to the run (#66)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const respond = createClaudeCodeResponder({
      workdir: '/w',
      permissionPromptTool: 'mcp__perm__approve',
      mcpConfigPath: '/cfg.json',
      run,
    });
    await respond(task);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ permissionPromptTool: 'mcp__perm__approve', mcpConfigPath: '/cfg.json' }),
    );
  });
});

describe('senderAttribution', () => {
  it('marks the planner (human/architect) as the authoritative sender (#86)', () => {
    expect(senderAttribution({ from: 'orchestrator', role: 'planner' })).toBe(
      '[Message from architect — authoritative (id: orchestrator)]',
    );
  });

  it('labels an executor sender as a (non-authoritative) agent, distinct from the architect (#86)', () => {
    const attribution = senderAttribution({ from: 'executor-2', role: 'executor' });
    expect(attribution).toBe('[Message from agent (id: executor-2)]');
    expect(attribution).not.toContain('authoritative');
  });

  it('labels an evaluator delegate\'s report as a (non-authoritative) agent too (#93)', () => {
    // A delegate's bridged finding carries its `evaluator` role; it must read as a
    // non-authoritative agent, never able to borrow the architect's authority.
    const attribution = senderAttribution({ from: 'w1-executor-evaluator-1', role: 'evaluator' });
    expect(attribution).toBe('[Message from agent (id: w1-executor-evaluator-1)]');
    expect(attribution).not.toContain('authoritative');
  });
});

describe('buildClaudeArgs', () => {
  it('omits --append-system-prompt when no role prompt is given', () => {
    const args = buildClaudeArgs('do it');
    expect(args).toEqual(['-p', 'do it', '--output-format', 'json', '--settings', EXECUTOR_PERMISSIONS]);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('applies the executor permission policy — commands allowed, foot-guns denied', () => {
    const policy = JSON.parse(EXECUTOR_PERMISSIONS) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(policy.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'Edit(./**)', 'Read']));
    expect(policy.permissions.deny).toEqual(expect.arrayContaining(['Bash(rm -rf *)', 'Bash(git push *)']));
  });

  it('always spawns with the exact base policy — learned "Always" rules are not merged here (#70)', () => {
    // #70's remembering is consumed in the permission MCP server's approve, not
    // in --settings (a learned allow rule doesn't reach out-of-cwd writes), so the
    // spawn policy is unconditionally the base EXECUTOR_PERMISSIONS.
    expect(buildClaudeArgs('go')[buildClaudeArgs('go').indexOf('--settings') + 1]).toBe(EXECUTOR_PERMISSIONS);
  });

  it('appends --append-system-prompt with the role text when given', () => {
    const args = buildClaudeArgs('do it', { appendSystemPrompt: 'be an executor' });
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'be an executor']);
  });

  it('pins a new session with --session-id, and resumes an existing one with --resume', () => {
    expect(buildClaudeArgs('go', { sessionId: 'sid' }).slice(-2)).toEqual(['--session-id', 'sid']);
    expect(buildClaudeArgs('go', { sessionId: 'sid', resume: true }).slice(-2)).toEqual(['--resume', 'sid']);
  });

  it('wires the permission-prompt tool and its MCP config when given (#66)', () => {
    const args = buildClaudeArgs('go', { permissionPromptTool: 'mcp__perm__approve', mcpConfigPath: '/cfg.json' });
    const tool = args.indexOf('--permission-prompt-tool');
    expect(tool).toBeGreaterThan(-1);
    expect(args[tool + 1]).toBe('mcp__perm__approve');
    expect(args.slice(-2)).toEqual(['--mcp-config', '/cfg.json']);
  });

  it('omits the permission-prompt flags when not given', () => {
    const args = buildClaudeArgs('go');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(args).not.toContain('--mcp-config');
  });
});

describe('resolveClaudeBin', () => {
  const original = process.env.CLAUDE_BIN;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = original;
  });

  it('prefers CLAUDE_BIN when set, read at call time', () => {
    process.env.CLAUDE_BIN = 'C:\\tools\\claude.exe';
    expect(resolveClaudeBin()).toBe('C:\\tools\\claude.exe');
  });

  it('falls back to a PATH-resolved command when CLAUDE_BIN is unset', () => {
    delete process.env.CLAUDE_BIN;
    expect(resolveClaudeBin()).toBe(process.platform === 'win32' ? 'claude.exe' : 'claude');
  });
});
