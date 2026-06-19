import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Storage strategy: which backend persists sessions. Backends are pluggable
 * adapters selected by id; today only `local` exists (more land as adapters).
 */
export interface StorageConfig {
  /** Backend id. `local` = the file-backed store under `.mjolnir/sessions`. */
  readonly backend: string;
}

/** The committed, machine-readable project strategy (see `mjolnir.config.json`). */
export interface ProjectConfig {
  readonly storage: StorageConfig;
}

/** Default when no committed config is present: the dependency-free local backend. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = { storage: { backend: 'local' } };

/**
 * Load the committed project strategy from `mjolnir.config.json` (repo root by
 * default). This is the shared, team-wide config — distinct from the gitignored,
 * per-machine `.local.env`. A missing file yields {@link DEFAULT_PROJECT_CONFIG};
 * malformed JSON or a non-string `storage.backend` throws with an actionable
 * message. The agent authors this file during onboarding; runtime only reads it.
 */
export function loadProjectConfig(path = resolve(process.cwd(), 'mjolnir.config.json')): ProjectConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return DEFAULT_PROJECT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid mjolnir.config.json: ${String(error)}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`invalid mjolnir.config.json: expected an object, got ${describeJson(parsed)}`);
  }
  const { storage } = parsed;
  if (storage !== undefined && !isJsonObject(storage)) {
    throw new Error(`invalid mjolnir.config.json: "storage" must be an object, got ${describeJson(storage)}`);
  }
  const backend = storage?.backend ?? DEFAULT_PROJECT_CONFIG.storage.backend;
  if (typeof backend !== 'string') {
    throw new Error(`invalid mjolnir.config.json: storage.backend must be a string, got ${describeJson(backend)}`);
  }
  return { storage: { backend } };
}

/** A non-null, non-array object — the only valid shape for the config and its `storage`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Human-readable type for error messages, distinguishing null and array from object. */
function describeJson(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
