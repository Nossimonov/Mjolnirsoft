import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createClaudeCodeResponder,
  resolveClaudeBin,
  buildClaudeArgs,
  DEFAULT_EXECUTOR_ROLE,
  EXECUTOR_PERMISSIONS,
} from './claude-code-responder.ts';
import { SHARED_CORE, EXECUTOR_INSERT } from '../core/agent-instructions.ts';

const task = { from: 'orchestrator', type: 'text', payload: 'write a haiku to haiku.md' } as const;

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
      'write a haiku to haiku.md',
      expect.objectContaining({ cwd: '/tmp/executor-1', appendSystemPrompt: DEFAULT_EXECUTOR_ROLE, resume: false }),
    );
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

  it('returns undefined when Claude Code produces no result', async () => {
    const respond = createClaudeCodeResponder({ workdir: '/tmp/executor-1', run: async () => '   ' });
    expect(await respond(task)).toBeUndefined();
  });

  it('ignores permission interaction messages rather than treating them as prompts (#66)', async () => {
    const run = vi.fn().mockResolvedValue('x');
    const respond = createClaudeCodeResponder({ workdir: '/w', run });
    const req = { from: 'p', type: 'interaction-request', payload: { requestId: 'r', toolName: 'Write', input: {} } };
    const dec = { from: 'p', type: 'interaction-decision', payload: { requestId: 'r', behavior: 'allow' } };
    expect(await respond(req)).toBeUndefined();
    expect(await respond(dec)).toBeUndefined();
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
