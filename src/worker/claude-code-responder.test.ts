import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createClaudeCodeResponder,
  resolveClaudeBin,
  buildClaudeArgs,
  DEFAULT_WORKER_ROLE,
} from './claude-code-responder.ts';

const task = { from: 'orchestrator', type: 'text', payload: 'write a haiku to haiku.md' } as const;

describe('createClaudeCodeResponder', () => {
  it('runs Claude Code with the task and the default worker-role prompt, replying with its result', async () => {
    const run = vi.fn().mockResolvedValue('Created haiku.md with a haiku.');
    const respond = createClaudeCodeResponder({ workdir: '/tmp/worker-1', run });

    const reply = await respond(task);

    expect(reply).toEqual({ type: 'result', payload: 'Created haiku.md with a haiku.' });
    expect(run).toHaveBeenCalledWith('write a haiku to haiku.md', {
      cwd: '/tmp/worker-1',
      appendSystemPrompt: DEFAULT_WORKER_ROLE,
    });
  });

  it('lets the caller override the appended worker-role prompt', async () => {
    const run = vi.fn().mockResolvedValue('done');
    const respond = createClaudeCodeResponder({ workdir: '/w', appendSystemPrompt: 'on branch X', run });
    await respond(task);
    expect(run).toHaveBeenCalledWith(expect.any(String), { cwd: '/w', appendSystemPrompt: 'on branch X' });
  });

  it('returns undefined when Claude Code produces no result', async () => {
    const respond = createClaudeCodeResponder({ workdir: '/tmp/worker-1', run: async () => '   ' });
    expect(await respond(task)).toBeUndefined();
  });
});

describe('buildClaudeArgs', () => {
  it('omits --append-system-prompt when no role prompt is given', () => {
    const args = buildClaudeArgs('do it');
    expect(args).toEqual(['-p', 'do it', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('appends --append-system-prompt with the role text when given', () => {
    const args = buildClaudeArgs('do it', 'be a worker');
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'be a worker']);
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
