import { describe, it, expect } from 'vitest';
import { formatElapsed } from './elapsed.ts';

describe('formatElapsed', () => {
  it('formats sub-minute durations as 0:ss with zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5_000)).toBe('0:05');
    expect(formatElapsed(59_000)).toBe('0:59');
  });

  it('rolls seconds into minutes', () => {
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(125_000)).toBe('2:05');
  });

  it('leaves minutes unbounded for a long turn', () => {
    expect(formatElapsed(727_000)).toBe('12:07');
  });

  it('floors partial seconds rather than rounding up', () => {
    expect(formatElapsed(1_999)).toBe('0:01');
  });

  it('clamps negatives to 0:00', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
  });
});
