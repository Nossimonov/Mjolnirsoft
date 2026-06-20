import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  learnedRuleFor,
  loadLearnedAllowRules,
  matchesLearnedRule,
  recordLearnedRule,
  LEARNED_PERMISSIONS_RELPATH,
} from './learned-permissions.ts';

describe('learnedRuleFor', () => {
  it('remembers a path-bearing tool at parent-directory granularity', () => {
    // The #70 decision: an "Always" on C:/x/y.txt remembers the directory, not the file.
    expect(learnedRuleFor('Write', { file_path: 'C:/x/y.txt', content: 'hi' })).toBe('Write(C:/x/**)');
  });

  it('normalises backslash paths to forward slashes (Claude matches gitignore-style)', () => {
    expect(learnedRuleFor('Edit', { file_path: 'C:\\Users\\k\\notes.md' })).toBe('Edit(C:/Users/k/**)');
  });

  it('reads the path from path/notebook_path too, not only file_path', () => {
    expect(learnedRuleFor('Read', { path: '/etc/hosts' })).toBe('Read(/etc/**)');
    expect(learnedRuleFor('NotebookEdit', { notebook_path: '/a/b/n.ipynb' })).toBe('NotebookEdit(/a/b/**)');
  });

  it('remembers a command-bearing tool at leading-token prefix granularity', () => {
    expect(learnedRuleFor('Bash', { command: 'npm install left-pad' })).toBe('Bash(npm *)');
  });

  it('falls back to the bare tool name when no path or command anchors a sub-scope', () => {
    expect(learnedRuleFor('WebFetch', { url: 'https://example.com' })).toBe('WebFetch');
    expect(learnedRuleFor('SomeMcpTool', undefined)).toBe('SomeMcpTool');
  });

  it('returns undefined with no tool name to anchor on', () => {
    expect(learnedRuleFor('', { file_path: '/x/y' })).toBeUndefined();
  });
});

describe('loadLearnedAllowRules / recordLearnedRule', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'mjolnir-perms-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns an empty list when no learned-rules file exists', () => {
    expect(loadLearnedAllowRules(projectDir)).toEqual([]);
  });

  it('persists a derived rule and reads it back', () => {
    const recorded = recordLearnedRule(projectDir, 'Write', { file_path: 'C:/x/y.txt' });
    expect(recorded).toBe('Write(C:/x/**)');
    expect(loadLearnedAllowRules(projectDir)).toEqual(['Write(C:/x/**)']);
  });

  it('writes the file at the gitignored .mjolnir path, as an { allow: [...] } document', () => {
    recordLearnedRule(projectDir, 'Write', { file_path: 'C:/x/y.txt' });
    const text = readFileSync(join(projectDir, LEARNED_PERMISSIONS_RELPATH), 'utf8');
    expect(JSON.parse(text)).toEqual({ allow: ['Write(C:/x/**)'] });
  });

  it('appends distinct rules and deduplicates an already-learned action', () => {
    expect(recordLearnedRule(projectDir, 'Write', { file_path: 'C:/x/a.txt' })).toBe('Write(C:/x/**)');
    // Same directory → same rule → already remembered, so no duplicate.
    expect(recordLearnedRule(projectDir, 'Write', { file_path: 'C:/x/b.txt' })).toBeUndefined();
    expect(recordLearnedRule(projectDir, 'Read', { path: '/etc/hosts' })).toBe('Read(/etc/**)');
    expect(loadLearnedAllowRules(projectDir)).toEqual(['Write(C:/x/**)', 'Read(/etc/**)']);
  });

  it('treats a malformed file as no rules rather than throwing', () => {
    mkdirSync(join(projectDir, '.mjolnir'), { recursive: true });
    writeFileSync(join(projectDir, LEARNED_PERMISSIONS_RELPATH), 'not json{');
    expect(loadLearnedAllowRules(projectDir)).toEqual([]);
  });

  it('keeps only string entries from a hand-edited file', () => {
    mkdirSync(join(projectDir, '.mjolnir'), { recursive: true });
    writeFileSync(join(projectDir, LEARNED_PERMISSIONS_RELPATH), JSON.stringify({ allow: ['Read', 42, null, 'Bash'] }));
    expect(loadLearnedAllowRules(projectDir)).toEqual(['Read', 'Bash']);
  });
});

describe('matchesLearnedRule', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'mjolnir-perms-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns the matched rule for a request the parent-dir rule already covers', () => {
    recordLearnedRule(projectDir, 'Write', { file_path: 'C:/x/y.txt' });
    // A sibling in the same directory derives the same Write(C:/x/**) rule → match.
    expect(matchesLearnedRule(projectDir, 'Write', { file_path: 'C:/x/z.txt' })).toBe('Write(C:/x/**)');
  });

  it('returns undefined for a request no learned rule covers', () => {
    recordLearnedRule(projectDir, 'Write', { file_path: 'C:/x/y.txt' });
    // Different directory and a different tool both derive non-recorded rules.
    expect(matchesLearnedRule(projectDir, 'Write', { file_path: 'C:/other/z.txt' })).toBeUndefined();
    expect(matchesLearnedRule(projectDir, 'Bash', { command: 'npm test' })).toBeUndefined();
  });

  it('returns undefined when nothing has been learned', () => {
    expect(matchesLearnedRule(projectDir, 'Write', { file_path: 'C:/x/y.txt' })).toBeUndefined();
  });

  it('matches a remembered command at its leading-token prefix', () => {
    recordLearnedRule(projectDir, 'Bash', { command: 'npm install left-pad' });
    expect(matchesLearnedRule(projectDir, 'Bash', { command: 'npm test' })).toBe('Bash(npm *)');
  });
});
