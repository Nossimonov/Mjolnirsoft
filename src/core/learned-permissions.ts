/**
 * Learned worker permission rules (#70) — the "Always" side of the permission card.
 *
 * The permission escalation (#66) surfaces a gated tool use as an allow/deny card.
 * "Always" is a third choice that allows the action *and* remembers it, so the
 * same action stops escalating in future. There is no Claude "remember" feature
 * behind this: Claude's verdict stays a plain `allow`; the memory is entirely our
 * side-effect. On an "Always" decision we derive a `--settings` allow-rule from
 * the request and persist it to a gitignored, per-project file; a later worker
 * spawn merges those rules into its policy (see `buildWorkerSettings`), and since
 * allow rules are checked before the permission-prompt tool, the action no longer
 * reaches the human — the allow-list has *learned* from the decision.
 *
 * Granularity is **parent-directory / prefix** (the decision recorded for #70):
 * an "Always" on a write to `C:/x/y.txt` remembers `Write(C:/x/**)`, not just that
 * one file — fewer future prompts, at the cost of auto-approving siblings in the
 * same directory the human never explicitly saw. The `deny` floor in
 * `WORKER_PERMISSIONS` still wins over any learned `allow`, so a broadened rule
 * can't unlock a denied foot-gun.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Path (relative to a project root) of the gitignored learned-rules file. */
export const LEARNED_PERMISSIONS_RELPATH = path.join('.mjolnir', 'worker-permissions.json');

/** The on-disk shape: a single list of `--settings` allow-rule strings. */
interface LearnedPermissionsFile {
  /** Settings allow rules, e.g. `Write(C:/x/**)`, learned from "Always" clicks. */
  readonly allow: string[];
}

/** Absolute path of a project's learned-rules file. */
function filePathFor(projectDir: string): string {
  return path.join(projectDir, LEARNED_PERMISSIONS_RELPATH);
}

/**
 * Derive a Claude `--settings` allow-rule from an "Always" decision's tool
 * request, at parent-directory / prefix granularity. Returns `undefined` only
 * when there is no tool name to anchor a rule on.
 *
 * - A path-bearing tool (`file_path`/`path`/`notebook_path`) → the *parent
 *   directory* as a glob, e.g. `Write(C:/x/**)`. Paths are normalised to forward
 *   slashes because Claude matches these patterns gitignore-style.
 * - A `Bash` (or other `command`-bearing) tool → the command's leading token as a
 *   prefix, e.g. `Bash(npm *)`. A bare-token prefix is the command-side analogue
 *   of "parent directory"; `deny` rules still gate the dangerous specifics.
 * - Anything else → the bare tool name, the whole tool being its own scope when no
 *   narrower sub-scope can be extracted.
 */
export function learnedRuleFor(toolName: string, input: unknown): string | undefined {
  if (!toolName) return undefined;
  const target = pathFrom(input);
  if (target) {
    const dir = path.posix.dirname(target.replace(/\\/g, '/'));
    return `${toolName}(${dir}/**)`;
  }
  const command = commandFrom(input);
  if (command) {
    const prefix = command.trim().split(/\s+/)[0];
    if (prefix) return `${toolName}(${prefix} *)`;
  }
  return toolName;
}

/** Pull a filesystem path out of a tool input, across the keys Claude's file tools use. */
function pathFrom(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Pull a shell command out of a tool input (Bash's `command`). */
function commandFrom(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>).command;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a project's learned allow rules. Missing file or malformed content yields
 * an empty list (the feature is purely additive — a corrupt file must never block
 * a spawn), and only string entries survive so a hand-edited file can't inject a
 * non-string into the policy.
 */
export function loadLearnedAllowRules(projectDir: string): string[] {
  let text: string;
  try {
    text = readFileSync(filePathFor(projectDir), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as Partial<LearnedPermissionsFile>;
    if (!parsed || !Array.isArray(parsed.allow)) return [];
    return parsed.allow.filter((rule): rule is string => typeof rule === 'string');
  } catch {
    return [];
  }
}

/**
 * Persist a learned allow rule for an "Always" decision, deduplicating against
 * what's already recorded. Returns the rule string when it was newly added, or
 * `undefined` when an equivalent rule was already present — so the caller can log
 * the first time an action becomes remembered. Writes pretty JSON so the file
 * stays human-readable and hand-editable.
 */
export function recordLearnedRule(projectDir: string, toolName: string, input: unknown): string | undefined {
  const rule = learnedRuleFor(toolName, input);
  if (!rule) return undefined;
  const existing = loadLearnedAllowRules(projectDir);
  if (existing.includes(rule)) return undefined;
  const allow = [...existing, rule];
  const target = filePathFor(projectDir);
  const dir = path.dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target, `${JSON.stringify({ allow } satisfies LearnedPermissionsFile, null, 2)}\n`);
  return rule;
}
