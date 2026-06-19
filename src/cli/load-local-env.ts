import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load `KEY=value` lines from `.local.env` (the gitignored, machine-specific
 * config described in CLAUDE.md) into `process.env`. Already-set variables win,
 * so a real environment variable always overrides the file. Comment lines (`#`)
 * and blanks are skipped; a missing file is not an error (there may be no
 * machine-specific config). Call once at process startup, before anything reads
 * the values it provides (e.g. `CLAUDE_BIN`).
 */
export function loadLocalEnv(path = resolve(process.cwd(), '.local.env')): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
