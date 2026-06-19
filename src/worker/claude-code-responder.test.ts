import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClaudeCodeResponder, resolveClaudeBin } from './claude-code-responder.ts';

const task = { from: 'orchestrator', type: 'text', payload: 'write a haiku to haiku.md' } as const;

describe('createClaudeCodeResponder', () => {
  it('runs Claude Code with the task in the workspace and replies with its result', async () => {
    const run = vi.fn().mockResolvedValue('Created haiku.md with a haiku.');
    const respond = createClaudeCodeResponder({ workdir: '/tmp/worker-1', run });

    const reply = await respond(task);

    expect(reply).toEqual({ type: 'result', payload: 'Created haiku.md with a haiku.' });
    expect(run).toHaveBeenCalledWith('write a haiku to haiku.md', { cwd: '/tmp/worker-1' });
  });

  it('returns undefined when Claude Code produces no result', async () => {
    const respond = createClaudeCodeResponder({ workdir: '/tmp/worker-1', run: async () => '   ' });
    expect(await respond(task)).toBeUndefined();
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
