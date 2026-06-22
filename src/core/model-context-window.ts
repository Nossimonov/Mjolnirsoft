/**
 * Context window sizes (tokens) per Claude model, sourced from the claude-api skill
 * (cached 2026-06-04). Used to translate a fractional compaction threshold into an
 * absolute token count for the orchestrator's context-size note (#180).
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5':            1_000_000,
  'claude-opus-4-8':           1_000_000,
  'claude-opus-4-7':           1_000_000,
  'claude-opus-4-6':           1_000_000,
  'claude-sonnet-4-6':         1_000_000,
  'claude-haiku-4-5':            200_000,
  'claude-haiku-4-5-20251001':   200_000,
};

/**
 * Returns the context window size in tokens for the given model string.
 *
 * Handles:
 * - Full model IDs (e.g. `'claude-sonnet-4-6'`)
 * - Claude Code CLI shorthand aliases (e.g. `'sonnet'`, `'opus'`, `'haiku'`)
 * - `undefined` — orchestrator inherits the user's Claude Code default, which in
 *   this project is invariably an Opus-class model (1M window); using 1M avoids
 *   false "PAST THRESHOLD" alerts at normal orchestrator context sizes (~300K).
 * - Unrecognised strings — conservative 200K fallback (smallest known production
 *   window) so compaction triggers early rather than letting context overflow.
 */
export function contextWindowFor(model: string | undefined): number {
  if (model === undefined) return 1_000_000;
  if (CONTEXT_WINDOWS[model] !== undefined) return CONTEXT_WINDOWS[model];
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 200_000;
  if (lower.includes('sonnet') || lower.includes('opus') || lower.includes('fable')) return 1_000_000;
  return 200_000;
}
