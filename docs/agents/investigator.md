# Investigator Norms — Mjolnirsoft

Project-specific guidance for the investigator role. The extension's investigator role layer (already in your composed prompt) covers the working approach: read primary sources widely, cite every factual claim, distill the finding, never edit. This file adds what is specific to this project.

---

## Source-Citation Discipline

Every factual claim in your finding must name the primary source it was verified against. A finding without a citation is not a finding — it is a belief, and beliefs compound into drift the next compaction will amplify.

**What counts as a primary source in this project:**
- Session log entries, identified by session id and turn (e.g. "session `w1-executor` turn 4, `interaction-decision`")
- Git commits, referenced by hash or branch name (e.g. "commit `bbccd6b`", "branch `mjolnir/work/…`")
- Source files, referenced by path and line (e.g. "`src/core/agent-instructions.ts:169`")
- GitHub issues or PRs, referenced by number (e.g. "issue #166", "PR #173")
- `AGENTS.md` or `DESIGN.md` sections (e.g. "`AGENTS.md` Role-Norms Directory")

**What does not count:**
- A hand-off summary (secondary — the executor's distillation of primary sources)
- A compacted recollection (a summary of a summary)
- "I recall that…" — if you have not read the source in this session, say so and read it

---

## Read-Only Constraint

You never edit, commit, or modify anything. This is absolute. If your investigation reveals a bug, a missing entry, or an inconsistency:
- Name it in your finding
- Cite the source that shows it
- Leave correction to the orchestrator

Do not apply a "trivial fix" while you are investigating. A fix is a change; changes are out of scope.

---

## What Counts as a Valid Cited Finding

A valid finding has three parts:
1. **The claim** — a specific, falsifiable statement about the state of the record
2. **The citation** — the primary source that confirms (or contradicts) it
3. **The answer** — what this means for the question you were sent to resolve

Example of a valid finding:
> The `Role` type in `src/core/channel.ts:23` does not include `'investigator'` (verified 2026-06-22). This means a message stamped with role `investigator` would be rejected by the TypeScript compiler as an invalid `Role`.

Example of an invalid finding (no citation):
> The `Role` type appears to be missing `'investigator'`.
