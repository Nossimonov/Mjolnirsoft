import { describe, it, expect } from 'vitest';
import { isAuthError, AUTH_ERROR_SIGNATURES } from './auth-error.ts';

describe('isAuthError', () => {
  // AC: "A test asserts auth-vs-non-auth string classification." Every known
  // signature must classify as auth, so the re-login card fires for each.
  it('classifies each known auth-error signature as an auth failure', () => {
    for (const signature of AUTH_ERROR_SIGNATURES) {
      const failure = `executor executor-1 failed to respond: Error: claude exited — ${signature}`;
      expect(isAuthError(failure)).toBe(true);
    }
  });

  it('matches case-insensitively (the strings are a heuristic, not exact tokens)', () => {
    expect(isAuthError('oauth token has expired')).toBe(true);
    expect(isAuthError('PLEASE RUN /LOGIN')).toBe(true);
  });

  it('classifies a generic (non-auth) failure as not-auth, so it falls back to the plain error turn (#89)', () => {
    expect(isAuthError('executor executor-1 failed to respond: Error: ENOENT spawn claude')).toBe(false);
    expect(isAuthError('executor executor-1 failed to respond: Error: claude exited 1')).toBe(false);
    expect(isAuthError('rate limit exceeded; try again later')).toBe(false);
  });
});
