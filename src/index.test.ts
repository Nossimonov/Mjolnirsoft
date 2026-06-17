import { describe, it, expect } from 'vitest';
import { sum } from './index';

describe('test harness smoke test', () => {
  it('runs and exercises a module imported from src', () => {
    expect(sum(2, 3)).toBe(5);
  });
});
