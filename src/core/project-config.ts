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

/**
 * Compaction settings for the orchestrator (#165). After integrating a task the
 * orchestrator checks its accumulated weighted-token total; if it exceeds the
 * threshold it writes a self-hand-off and requests a context rotation.
 */
export interface CompactionConfig {
  /**
   * Accumulated weighted-token threshold above which the orchestrator is invited
   * to compact its context after a task boundary. Weighted cost: output × 5,
   * cache-read × 0.1, cache-creation × 1.25, input × 1. A lower value triggers
   * more frequent compaction (smaller context, cheaper cache misses); a higher
   * value allows longer sessions before rotating.
   *
   * Default: 500_000 weighted tokens — roughly a medium-heavy orchestrator session.
   * The architect tunes this in mjolnir.config.json ("compaction.thresholdWeightedTokens").
   */
  readonly thresholdWeightedTokens: number;
}

/** The committed, machine-readable project strategy (see `mjolnir.config.json`). */
export interface ProjectConfig {
  readonly storage: StorageConfig;
  readonly compaction: CompactionConfig;
}

/** Default when no committed config is present: the dependency-free local backend. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  storage: { backend: 'local' },
  compaction: { thresholdWeightedTokens: 500_000 },
};

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
  const { storage, compaction } = parsed;
  if (storage !== undefined && !isJsonObject(storage)) {
    throw new Error(`invalid mjolnir.config.json: "storage" must be an object, got ${describeJson(storage)}`);
  }
  const backend = storage?.backend ?? DEFAULT_PROJECT_CONFIG.storage.backend;
  if (typeof backend !== 'string') {
    throw new Error(`invalid mjolnir.config.json: storage.backend must be a string, got ${describeJson(backend)}`);
  }
  if (compaction !== undefined && !isJsonObject(compaction)) {
    throw new Error(`invalid mjolnir.config.json: "compaction" must be an object, got ${describeJson(compaction)}`);
  }
  const thresholdWeightedTokens =
    compaction?.thresholdWeightedTokens ?? DEFAULT_PROJECT_CONFIG.compaction.thresholdWeightedTokens;
  if (typeof thresholdWeightedTokens !== 'number') {
    throw new Error(
      `invalid mjolnir.config.json: compaction.thresholdWeightedTokens must be a number, got ${describeJson(thresholdWeightedTokens)}`,
    );
  }
  return { storage: { backend }, compaction: { thresholdWeightedTokens } };
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
