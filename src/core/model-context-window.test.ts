import { describe, it, expect } from 'vitest';
import { contextWindowFor } from './model-context-window.ts';

describe('contextWindowFor', () => {
  it('returns 1M for undefined (orchestrator inherits user default)', () => {
    expect(contextWindowFor(undefined)).toBe(1_000_000);
  });

  it('returns correct sizes for known full model IDs', () => {
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-7')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-6')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(1_000_000);
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('handles CLI shorthand aliases via substring match', () => {
    expect(contextWindowFor('opus')).toBe(1_000_000);
    expect(contextWindowFor('sonnet')).toBe(1_000_000);
    expect(contextWindowFor('haiku')).toBe(200_000);
    expect(contextWindowFor('fable')).toBe(1_000_000);
  });

  it('falls back to 200K for completely unrecognised model strings', () => {
    expect(contextWindowFor('unknown-model-9999')).toBe(200_000);
    expect(contextWindowFor('')).toBe(200_000);
  });
});
