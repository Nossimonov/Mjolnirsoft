import { describe, it, expect, vi } from 'vitest';
import { approveToolUse } from './permission-approval.ts';
import type { InteractionDecision } from '../core/interaction.ts';

const allowDecision = (requestId: string): InteractionDecision => ({ requestId, behavior: 'allow' });

describe('approveToolUse', () => {
  it('auto-allows a remembered request without escalating, and audits it (#70)', async () => {
    const request = vi.fn(); // the bridge must not be consulted on a match
    const postAudit = vi.fn();
    const matchRule = vi.fn().mockReturnValue('Write(C:/x/**)');

    const verdict = await approveToolUse(
      { projectDir: '/proj', bridge: { request }, postAudit, matchRule },
      'Write',
      { file_path: 'C:/x/z.txt', content: 'hi' },
    );

    // Allowed with the input echoed back unchanged, so the tool runs as Claude intended.
    expect(verdict).toEqual({ behavior: 'allow', updatedInput: { file_path: 'C:/x/z.txt', content: 'hi' } });
    expect(request).not.toHaveBeenCalled();
    // The transcript records the silent auto-allow, naming the rule that fired.
    expect(postAudit).toHaveBeenCalledWith('auto-allowed (remembered): Write(C:/x/**)');
  });

  it('escalates a non-remembered request to the human and maps their verdict (#66)', async () => {
    const request = vi.fn().mockResolvedValue(allowDecision('r1'));
    const postAudit = vi.fn();
    const matchRule = vi.fn().mockReturnValue(undefined);

    const verdict = await approveToolUse(
      { projectDir: '/proj', bridge: { request }, postAudit, matchRule },
      'Write',
      { file_path: 'C:/other/z.txt' },
      'tool-use-1',
    );

    // No match → the bridge is asked, with the tool's input and use id.
    expect(request).toHaveBeenCalledWith('Write', { file_path: 'C:/other/z.txt' }, 'tool-use-1');
    // A bare allow echoes the original input back as the verdict's updatedInput.
    expect(verdict).toEqual({ behavior: 'allow', updatedInput: { file_path: 'C:/other/z.txt' } });
    expect(postAudit).not.toHaveBeenCalled();
  });

  it('relays a human deny as a deny verdict', async () => {
    const request = vi.fn().mockResolvedValue({ requestId: 'r2', behavior: 'deny', message: 'no' });
    const verdict = await approveToolUse(
      { projectDir: '/proj', bridge: { request }, postAudit: vi.fn(), matchRule: () => undefined },
      'Bash',
      { command: 'rm -rf /' },
    );
    expect(verdict).toEqual({ behavior: 'deny', message: 'no' });
  });

  it('relays the free-text "can\'t answer" reason to the agent as the deny verdict message (#96)', async () => {
    // Full round-trip: AskUserQuestion is escalated to the human, who submits a free-text
    // explanation instead of a preset. The verdict the permission MCP server returns to the
    // agent (as JSON text) must carry that reason verbatim so the agent can re-ask or revise.
    const reason = "I can't see the content being referenced — please include it directly in the question.";
    const request = vi.fn().mockResolvedValue({ requestId: 'r-ask', behavior: 'deny', message: reason });

    const verdict = await approveToolUse(
      { projectDir: '/proj', bridge: { request }, postAudit: vi.fn(), matchRule: () => undefined },
      'AskUserQuestion',
      { questions: [{ question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] }] },
      'toolu_ask_1',
    );

    // The bridge received the full AskUserQuestion call.
    expect(request).toHaveBeenCalledWith(
      'AskUserQuestion',
      { questions: [{ question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] }] },
      'toolu_ask_1',
    );
    // The verdict carries the reason verbatim — the agent reads this and can re-ask.
    expect(verdict).toEqual({ behavior: 'deny', message: reason });
  });

  it('auto-denies an out-of-worktree write before any auto-allow or escalation (#101)', async () => {
    const request = vi.fn(); // the human must never be asked
    const postAudit = vi.fn();
    // Even a matching learned rule must not unlock it — the guardrail runs first.
    const matchRule = vi.fn().mockReturnValue('Write(C:/elsewhere/**)');

    const verdict = await approveToolUse(
      {
        projectDir: '/proj',
        worktreePath: 'C:\\repo\\.mjolnir\\worktrees\\exec-1',
        bridge: { request },
        postAudit,
        matchRule,
      },
      'Write',
      { file_path: 'C:\\repo\\extension\\src\\render.ts', content: 'x' },
    );

    expect(verdict.behavior).toBe('deny');
    expect(request).not.toHaveBeenCalled();
    expect(matchRule).not.toHaveBeenCalled(); // guardrail short-circuits before the rule lookup
    expect(postAudit).toHaveBeenCalledWith('auto-denied (outside worktree): Write');
  });

  it('leaves an in-worktree write to the normal auto-allow/escalate flow', async () => {
    const request = vi.fn().mockResolvedValue(allowDecision('r4'));
    const matchRule = vi.fn().mockReturnValue(undefined);

    await approveToolUse(
      {
        projectDir: '/proj',
        worktreePath: 'C:\\repo\\.mjolnir\\worktrees\\exec-1',
        bridge: { request },
        postAudit: vi.fn(),
        matchRule,
      },
      'Write',
      { file_path: 'C:\\repo\\.mjolnir\\worktrees\\exec-1\\src\\a.ts', content: 'x' },
    );

    // Not denied: the rule is consulted and, on no match, the human is asked.
    expect(matchRule).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('escalates every request when no project dir is configured (auto-allow disabled)', async () => {
    const request = vi.fn().mockResolvedValue(allowDecision('r3'));
    const matchRule = vi.fn();

    await approveToolUse(
      { bridge: { request }, postAudit: vi.fn(), matchRule },
      'Write',
      { file_path: 'C:/x/z.txt' },
    );

    // Without a project dir we never even consult the matcher — fail toward asking.
    expect(matchRule).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});
