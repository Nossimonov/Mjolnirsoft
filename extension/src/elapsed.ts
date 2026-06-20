/**
 * Format an elapsed duration (milliseconds) as `m:ss` for the "working" timer.
 * Pure so the webview's ticking indicator can be unit-tested without a DOM.
 * Minutes are unbounded (a long turn reads `12:07`); seconds are zero-padded.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
