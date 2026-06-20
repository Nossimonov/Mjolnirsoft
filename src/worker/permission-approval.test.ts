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
