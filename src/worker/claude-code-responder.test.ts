import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createClaudeCodeResponder,
  resolveClaudeBin,
  buildClaudeArgs,
  buildWorkerSettings,
  DEFAULT_WORKER_ROLE,
  WORKER_PERMISSIONS,
} from './claude-code-responder.ts';

const task = { from: 'orchestrator', type: 'text', payload: 'write a haiku to haiku.md' } as const;

describe('createClaudeCodeResponder', () => {
  it('runs Claude Code with the task and the default worker-role prompt, replying with its result', async () => {
    const run = vi.fn().mockResolvedValue('Created haiku.md with a haiku.');
    const respond = createClaudeCodeResponder({ workdir: '/tmp/worker-1', run });

    const reply = await respond(task);

    expect(reply).toEqual({ type: 'result', payload: 'Created haiku.md with a haiku.' });
    expect(run).toHaveBeenCalledWith(
      'write a haiku to haiku.md',
      expect.objectContaining({ cwd: '/tmp/worker-1', appendSystemPrompt: DEFAULT_WORKER_ROLE, resume: false }),
    );
  });

  it('lets the caller override the appended worker-role prompt', async () => {
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
    const respond = createClaudeCodeResponder({ workdir: '/tmp/worker-1', run: async () => '   ' });
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

  it('reads learned "Always" rules per turn and passes them to the run (#70)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const loadLearnedRules = vi.fn().mockReturnValue(['Write(C:/x/**)']);
    const respond = createClaudeCodeResponder({ workdir: '/w', loadLearnedRules, run });
    await respond(task);
    expect(loadLearnedRules).toHaveBeenCalledTimes(1); // read fresh each turn
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ learnedAllowRules: ['Write(C:/x/**)'] }),
    );
    await respond(task);
    expect(loadLearnedRules).toHaveBeenCalledTimes(2); // a rule learned mid-session is picked up next turn
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
    expect(args).toEqual(['-p', 'do it', '--output-format', 'json', '--settings', WORKER_PERMISSIONS]);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('applies the worker permission policy — commands allowed, foot-guns denied', () => {
    const policy = JSON.parse(WORKER_PERMISSIONS) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(policy.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'Edit(./**)', 'Read']));
    expect(policy.permissions.deny).toEqual(expect.arrayContaining(['Bash(rm -rf *)', 'Bash(git push *)']));
  });

  it('merges learned "Always" allow rules into the spawn policy, leaving deny untouched (#70)', () => {
    const args = buildClaudeArgs('go', { learnedAllowRules: ['Write(C:/x/**)', 'Read'] });
    const settingsIndex = args.indexOf('--settings');
    const policy = JSON.parse(args[settingsIndex + 1]) as { permissions: { allow: string[]; deny: string[] } };
    // Base allows survive and the learned rule is added.
    expect(policy.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'Edit(./**)', 'Write(C:/x/**)']));
    // 'Read' is already a base allow — merging dedups rather than duplicating.
    expect(policy.permissions.allow.filter((r) => r === 'Read')).toHaveLength(1);
    // The deny floor is never widened by a learned rule.
    expect(policy.permissions.deny).toEqual(expect.arrayContaining(['Bash(rm -rf *)', 'Bash(git push *)']));
  });

  it('uses the exact base policy when nothing has been learned (#70)', () => {
    expect(buildWorkerSettings()).toBe(WORKER_PERMISSIONS);
    expect(buildClaudeArgs('go')[buildClaudeArgs('go').indexOf('--settings') + 1]).toBe(WORKER_PERMISSIONS);
  });

  it('appends --append-system-prompt with the role text when given', () => {
    const args = buildClaudeArgs('do it', { appendSystemPrompt: 'be a worker' });
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'be a worker']);
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
