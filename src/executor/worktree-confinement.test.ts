import { describe, it, expect } from 'vitest';
import { outOfWorktreeWriteDenial } from './worktree-confinement.ts';

// A representative nested-worktree path, in Windows form (the production host).
const WORKTREE = 'C:\\Users\\Kevin\\development\\Mjolnirsoft\\.mjolnir\\worktrees\\executor-101';

describe('outOfWorktreeWriteDenial', () => {
  it('auto-denies an absolute write into the repo-root copy (the #95 foot-gun)', () => {
    // The exact mistake #95 hit: targeting the main checkout's file by absolute path.
    const denial = outOfWorktreeWriteDenial(
      'Write',
      { file_path: 'C:\\Users\\Kevin\\development\\Mjolnirsoft\\extension\\src\\render.ts', content: 'x' },
      WORKTREE,
    );
    expect(denial).toBeDefined();
    expect(denial).toContain(WORKTREE);
  });

  it('allows a write to a file inside the worktree', () => {
    expect(
      outOfWorktreeWriteDenial(
        'Write',
        { file_path: `${WORKTREE}\\extension\\src\\render.ts`, content: 'x' },
        WORKTREE,
      ),
    ).toBeUndefined();
  });

  it('allows a worktree-relative write (resolves under the worktree by construction)', () => {
    expect(
      outOfWorktreeWriteDenial('Write', { file_path: 'extension/src/render.ts', content: 'x' }, WORKTREE),
    ).toBeUndefined();
  });

  it('treats Edit, MultiEdit and NotebookEdit as gated writes too', () => {
    expect(outOfWorktreeWriteDenial('Edit', { file_path: 'C:\\elsewhere\\a.ts' }, WORKTREE)).toBeDefined();
    expect(outOfWorktreeWriteDenial('MultiEdit', { file_path: 'C:\\elsewhere\\a.ts' }, WORKTREE)).toBeDefined();
    expect(
      outOfWorktreeWriteDenial('NotebookEdit', { notebook_path: 'C:\\elsewhere\\a.ipynb' }, WORKTREE),
    ).toBeDefined();
  });

  it('catches a relative path that climbs out of the worktree via ..', () => {
    expect(
      outOfWorktreeWriteDenial('Write', { file_path: '..\\..\\extension\\src\\render.ts' }, WORKTREE),
    ).toBeDefined();
  });

  it('allows a relative path that stays inside via ./', () => {
    expect(
      outOfWorktreeWriteDenial('Write', { file_path: './src/a.ts' }, WORKTREE),
    ).toBeUndefined();
  });

  it('normalises drive-letter case and separators (C:\\ vs c:/) before comparing', () => {
    // Same dir, different case + slashes — must still count as inside.
    const lowerSlash = 'c:/users/kevin/development/mjolnirsoft/.mjolnir/worktrees/executor-101';
    expect(
      outOfWorktreeWriteDenial('Write', { file_path: `${lowerSlash}/src/a.ts` }, WORKTREE),
    ).toBeUndefined();
  });

  it('does not treat a sibling worktree with a shared prefix as inside', () => {
    // `executor-101` must not match `executor-101-other` — the prefix check requires a separator.
    const sibling = `${WORKTREE}-other\\src\\a.ts`;
    expect(outOfWorktreeWriteDenial('Write', { file_path: sibling }, WORKTREE)).toBeDefined();
  });

  it('leaves reads (non-write tools) untouched — read widely, write narrowly', () => {
    expect(
      outOfWorktreeWriteDenial('Read', { file_path: 'C:\\Users\\Kevin\\development\\Mjolnirsoft\\README.md' }, WORKTREE),
    ).toBeUndefined();
    expect(outOfWorktreeWriteDenial('Bash', { command: 'echo hi > C:/outside.txt' }, WORKTREE)).toBeUndefined();
  });

  it('escalates (no auto-deny) when no worktree is configured — fail toward asking', () => {
    expect(outOfWorktreeWriteDenial('Write', { file_path: 'C:\\elsewhere\\a.ts' }, undefined)).toBeUndefined();
  });

  it('does not auto-deny a write whose input has no anchorable path', () => {
    expect(outOfWorktreeWriteDenial('Write', { content: 'no path here' }, WORKTREE)).toBeUndefined();
  });
});
