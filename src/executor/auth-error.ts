/**
 * Heuristic classifier for executor auth failures (#90).
 *
 * Claude Code exposes no machine-readable "this was an auth failure" field, so we
 * detect one by matching known auth-error strings in the failure text surfaced by
 * #89's `error` turn. A match drives a guided re-login card; a non-match falls
 * back to #89's plain error turn — never silent. Kept as a pure function (no I/O,
 * no host dependency) so it unit-tests directly and is callable from either the
 * view or the core; #90 calls it view-side, leaving #89's executor/core untouched.
 */

/**
 * Substrings claude is known to emit when credentials are expired/invalid/absent
 * (verified against the Claude Code CLI). Matched case-insensitively against the
 * failure text — the strings are the heuristic, so a coincidental substring (e.g.
 * a stray `401`) at worst offers a re-login the user can ignore.
 */
export const AUTH_ERROR_SIGNATURES: readonly string[] = [
  '401',
  'Invalid authentication credentials',
  'Not logged in',
  'OAuth token has expired',
  'OAuth token revoked',
  'Please run /login',
];

/** True when `text` carries one of the known auth-failure signatures. */
export function isAuthError(text: string): boolean {
  const haystack = text.toLowerCase();
  return AUTH_ERROR_SIGNATURES.some((signature) => haystack.includes(signature.toLowerCase()));
}
