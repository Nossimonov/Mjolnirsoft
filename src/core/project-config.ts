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
 * Compaction settings for the orchestrator (#165/#167). After integrating a task the
 * orchestrator checks its context size; if it exceeds the threshold it writes a
 * self-hand-off and requests a context rotation. Separately, the host triggers an
 * idle-time compaction when the orchestrator has been inactive long enough that the
 * prompt cache is about to expire (#167).
 */
export interface CompactionConfig {
  /**
   * Fraction of the running model's context window above which the orchestrator
   * is invited to compact its context after a task boundary. Must be between 0
   * (exclusive) and 1 (inclusive). Combined with a per-model window lookup, this
   * resolves to an absolute token threshold at runtime.
   *
   * Default: 0.75 (75% of the model's context window).
   * The architect tunes this in mjolnir.config.json ("compaction.thresholdContextPercent").
   */
  readonly thresholdContextPercent: number;
  /**
   * Seconds of orchestrator idle time before the host proactively triggers a
   * self-compaction (#167). Must be ≥ 0; 0 disables the idle trigger. Default: 210
   * (3.5 min — fires well before the 300s prompt-cache TTL so the hand-off turn
   * itself is still cache-warm). The architect tunes this in mjolnir.config.json
   * ("compaction.idleThresholdSeconds").
   */
  readonly idleThresholdSeconds: number;
}

/** The committed, machine-readable project strategy (see `mjolnir.config.json`). */
export interface ProjectConfig {
  readonly storage: StorageConfig;
  readonly compaction: CompactionConfig;
}

/** Default when no committed config is present: the dependency-free local backend. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  storage: { backend: 'local' },
  compaction: { thresholdContextPercent: 0.75, idleThresholdSeconds: 210 },
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
  const thresholdContextPercent =
    compaction?.thresholdContextPercent ?? DEFAULT_PROJECT_CONFIG.compaction.thresholdContextPercent;
  if (typeof thresholdContextPercent !== 'number') {
    throw new Error(
      `invalid mjolnir.config.json: compaction.thresholdContextPercent must be a number, got ${describeJson(thresholdContextPercent)}`,
    );
  }
  if (thresholdContextPercent <= 0 || thresholdContextPercent > 1) {
    throw new Error(
      `invalid mjolnir.config.json: compaction.thresholdContextPercent must be between 0 (exclusive) and 1 (inclusive), got ${thresholdContextPercent}`,
    );
  }
  const idleThresholdSeconds =
    compaction?.idleThresholdSeconds ?? DEFAULT_PROJECT_CONFIG.compaction.idleThresholdSeconds;
  if (typeof idleThresholdSeconds !== 'number') {
    throw new Error(
      `invalid mjolnir.config.json: compaction.idleThresholdSeconds must be a number, got ${describeJson(idleThresholdSeconds)}`,
    );
  }
  if (idleThresholdSeconds < 0) {
    throw new Error(
      `invalid mjolnir.config.json: compaction.idleThresholdSeconds must be ≥ 0 (0 = disabled), got ${idleThresholdSeconds}`,
    );
  }
  return { storage: { backend }, compaction: { thresholdContextPercent, idleThresholdSeconds } };
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
