/**
 * The hard worktree-confinement guardrail (#101).
 *
 * An executor's worktree is nested inside the repo (`.mjolnir/worktrees/<id>/`),
 * so every file exists *twice* — once in the worktree the executor owns, once in
 * the developer's main checkout. In #95 an executor targeted the **main repo's**
 * copy of a file by absolute path; the permission card escalated it and the
 * architect denied it, but a careless "allow" (or a learned "Always" rule, #70)
 * would have let it modify the developer's working tree. The role guidance already
 * says "only modify within your own worktree" and the executor erred anyway, so
 * soft guidance isn't enough. This is the defense-in-depth hard layer: a write
 * whose target resolves outside the worktree is **auto-denied** before escalation,
 * so the human is never even asked and no learned rule can unlock it.
 *
 * The decision is a pure function (the way `isAuthError` and `learnedRuleFor` are)
 * so the policy is unit-testable without standing up the MCP server. The server is
 * the thin wiring; this is the rule.
 *
 * Scope, per the architect's #101 decisions:
 * - Boundary: **all** writes outside the worktree (the worktree cwd is already the
 *   confinement boundary, #62), not just the main-repo tracked tree.
 * - Gated tools: the file-write tools with a clear path arg — `Write`, `Edit`,
 *   `NotebookEdit`. `Bash` shell-redirection writes have no clean path arg and are
 *   left to the existing `deny` floor + soft confinement (out of scope here).
 * - Write-only: reads outside the worktree stay allowed ("read widely, write
 *   narrowly") — only the path-bearing write tools are ever auto-denied.
 */
import path from 'node:path';

/**
 * The file-write tools this guardrail gates — those with a clear target-path arg.
 * Gating is an explicit allowlist, *not* "any tool that happens to carry a path":
 * `Read` also has a `file_path`, and reads outside the worktree stay allowed
 * (architect decision — "read widely, write narrowly"), so a path-presence
 * heuristic would wrongly deny reads. The cost of an allowlist is that it must stay
 * *complete*: any write-capable tool absent here falls through to the normal
 * auto-allow/escalate path and is **not** confined. `MultiEdit` is listed for that
 * reason — it is a file-write tool with a `file_path` arg, so it belongs to the
 * same category the architect named, even though the brief enumerated only the
 * other three. Add any future write tool here too.
 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Decide whether a tool use must be auto-denied for escaping the worktree. Returns
 * the deny message Claude should see when the request is a gated write whose target
 * resolves outside `worktreePath`; returns `undefined` to let the normal flow
 * (learned-rule auto-allow, else escalate to the human) proceed.
 *
 * Fails *open toward asking*: with no worktree configured, or a tool/input the rule
 * can't anchor on, it returns `undefined` so the request still escalates rather than
 * being silently denied — the guardrail only ever *adds* a deny it is sure of.
 */
export function outOfWorktreeWriteDenial(
  toolName: string,
  input: unknown,
  worktreePath: string | undefined,
): string | undefined {
  if (!worktreePath) return undefined;
  if (!WRITE_TOOLS.has(toolName)) return undefined;
  const target = writePathFrom(input);
  if (!target) return undefined;
  if (isWithin(target, worktreePath)) return undefined;
  return (
    `This ${toolName} targets a path outside your worktree (${worktreePath}). ` +
    `You are confined to your worktree — every repo file also exists there. ` +
    `Edit the copy under your worktree (use a worktree-relative path), not the repo-root original.`
  );
}

/** Pull the target filesystem path out of a write tool's input. */
function writePathFrom(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Whether `target` resolves inside `worktreePath`. A relative target resolves
 * against the worktree (the executor's cwd), so it is inside by construction; only
 * an absolute path — the #95 foot-gun — can escape. Resolution and comparison use
 * `path.win32` deterministically: the host is Windows, and pinning win32 keeps the
 * guardrail's verdict identical whether the unit suite runs on Windows or on the
 * Linux CI runner. Both sides are absolute-resolved, then canonicalised to lower
 * case forward-slash form so drive-letter and separator/case differences (`C:\x`
 * vs `c:/x`) never let an out-of-tree write slip through. `..` segments are
 * collapsed by `resolve` before comparison, so a relative path that climbs out is
 * still caught.
 *
 * Comparison is lexical on the resolved path, not by `realpath`: a symlink/junction
 * inside the worktree that points elsewhere is judged by its in-worktree path, not
 * its target. Resolving links is left out of scope (Windows worktrees rarely
 * contain them, and this is a defense-in-depth layer over the role guidance).
 */
function isWithin(target: string, worktreePath: string): boolean {
  const base = canonical(path.win32.resolve(worktreePath));
  const resolved = canonical(path.win32.resolve(worktreePath, target));
  return resolved === base || resolved.startsWith(`${base}/`);
}

/** Canonical comparison form: absolute, forward slashes, no trailing slash, lower case. */
function canonical(p: string): string {
  return path.win32
    .normalize(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
