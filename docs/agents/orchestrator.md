# Orchestrator Norms — Mjolnirsoft

Project-specific guidance for the orchestrator role. You own the bookkeeping protocol for this project, running it in coordination with the architect. This file is the authoritative reference for how that protocol works.

---

## Branch and PR Conventions

- **Branch naming:** executor worktrees use `mjolnir/work/<session-id>`. The system creates these automatically — do not rename or reuse them.
- **PR keyword:** every PR that closes an issue must include `closes #N` (or `fixes #N` / `resolves #N`) in the commit message or PR body so GitHub auto-closes the issue on merge.
- **Working directory:** you work out of the **main repo** (no worktree), so your git commands operate on the main checkout directly.
- **Never merge or force-push:** push the branch and open the PR; the architect merges. Force-push is denied outright.

---

## No Speculative Design in Artifacts

Every artifact that outlives the conversation — GitHub issue bodies, acceptance criteria, commit messages, PR descriptions — reads as endorsed direction once written. Future sessions (and the architect) treat them as real planned things, and work gets scoped against the invention.

**When this fires:** you are about to write into an artifact a design direction that (a) hasn't been discussed, (b) isn't already established in the repo/docs, and (c) names a specific future mechanism. If all three apply, **stop.**

**Two paths only:** (A) surface the question, propose options, get a decision — then the artifact records a real decision; or (B) implement the smallest thing that works and stop, writing nothing speculative down. What's forbidden is recording the speculation as if it were commitment ("will route through X later," "deferred until Y exists") — once written it contaminates future work and forces someone to fulfil or unwind it.

---

## Issue-Driven Work Discipline

Productive work not anchored to a tracked goal compounds into drift. This protocol keeps every commit traceable to a tracked goal and forces "should we be doing this now?" before each session shifts from talking to typing.

### When it fires

At the moment the **first source mutation** would occur in a session. Read-only investigation, design discussion, and analysis don't trigger it — but the moment a tool call would Edit/Write/otherwise change repo files, the protocol runs. Sessions start free and shift into issue-tracked mode when the first change is imminent.

### Session-start check (run when the trigger fires)

```bash
gh issue list --repo Nossimonov/Mjolnirsoft --assignee Nossimonov --state open --limit 50
```

`--limit 50` defends against the `gh ... list` family's silent default-page-size truncation — an unset `--limit` can return fewer than the real matches with no indicator. Use it on any `gh ... list` where count accuracy matters.

To read a *specific* issue's parent or milestone, use the `parent` GraphQL query (see "Checking an Issue's Existing Parent") — `gh issue list` and `gh issue view` do **not** show the sub-issue parent.

**Empty list:** Stop. Ask the architect what to accomplish. Identify or create the active **milestone** (feature-sized — one deliverable bundle, due in weeks), choose or create an issue under it per the hierarchy, assign it, then begin.

**Non-empty list:** Confirm every active issue belongs to a single active milestone (directly or via parent chain). If active issues span milestones, raise it — that's drift, not parallel progress. Then verify the work you're about to start falls under one of the active issues; if unclear, ask.

### Blocked state

When an active issue A surfaces a prereq B that must complete first, both stay assigned, and A gets the `blocked` label (`gh issue edit <A#> --add-label blocked`), removed when B closes. The assigned issues *without* `blocked` are the set actively progressing.

### In-flight discovery

When work surfaces a separable concern outside any active issue's scope: (1) note it in working memory immediately; (2) decide **prereq** (current work can't ship without it → file/surface it, mark the original `blocked`, do the prereq first) vs **defer** (ships without it → set aside, keep it out of the current commit). Refinements to *closed* work get **new** issues, not reopened ones. An unrelated **bug** found incidentally also gets the `in-flight-bug` label (in addition to its type label) so the set is discoverable for a focused fix pass.

### On commit — walk these phases in order

1. **Test** — run the suite(s) your commit touches; a newly-failing previously-passing suite blocks the commit.
2. **Verify (manual, when applicable)** — if an acceptance criterion is out of the automated suite's reach, surface for architect verification and wait (see *Pause for Manual Verification*). Feedback iterates in the working tree, not follow-up issues.
3. **Review** — for each assigned issue ask: did the work complete a stated criterion? were the criteria complete, or did delivery expose gaps? did running it surface refinements that should land before close? **are all artifacts the work depends on actually in source control** (run `git status`; trace names referenced from staged content back to tracked files; include user-authored content)? Gaps → treat as in-flight discoveries; do not close.
4. **Update AC/task checkboxes** — flip `- [ ]` to `- [x]` for criteria this commit satisfies (via `gh issue edit --body`), even when the issue isn't closing — the checkboxes are the resumable state. Check *after* Verify confirms correctness, *before* Close.
5. **Update the design record** — for work that changes what the system does, fold the now-true design language from the closing issue into the correct `docs/DESIGN.md` component section, **and** prune/replace any prior text the change made inaccurate, in this same commit (see *Design Documentation*). The "remove what's now false" half is not optional. Pure internal refactors with no behavioural or contract change skip this step.
6. **Close (only if review is clean)** — observe the hierarchy closing rules (sub-issues first; parents only when every child is closed); cascade upward; remove `blocked` from any issue whose blocker just closed. Prefer the commit-message auto-close keyword (`closes #N` / `fixes #N` / `resolves #N`) over an explicit `gh issue close`; reserve the explicit close for cascading parent closes the commit body can't express.
7. **File deferred-discovery issues** noted during the session — all of them — before writing the commit message.
8. **Write the commit message** referencing the advancing issue. The closing keyword goes only on the commit that lands after Verify is satisfied; intermediate commits use a plain `(#N)` reference.

### Pause for Manual Verification Before Committing

When the work has user-visible or behavioural effects the automated suite cannot fully verify, **do not commit until the architect has exercised it and confirmed it behaves as intended.** Surface the change as ready for verification, name what to test, and wait. Iterate in the working tree (use `git stash` for mid-iteration checkpoints, not commits). Only once confirmed do you commit, and only then does the closing keyword (`closes #N`) go on the message.

Triggers: a new CLI/tool surface, an interactive flow, output a human must judge as correct, behaviour in a code path the suite doesn't cover. Does **not** trigger for pure refactors, fixes covered by a new/existing regression test, or doc/config changes — commit those directly once automated tests pass.

### Exceptions

**Hotfixes:** a production-breaking issue may be fixed before its issue exists, provided the retroactive issue is created in the same session. **Side investigations:** read-only exploration doesn't trigger the protocol; the first edit toward a fix does.

---

## GitHub Issue Conventions

### Hierarchy

Strict four-level hierarchy — every issue lives at the correct level; do not skip levels.

```
Epic
└── Feature
    └── User Story
        └── Task (optional)
```

- **Epic** — top-level grouping for a major system. Long-lived, rarely closed.
- **Feature** — a discrete deliverable capability within an epic. Has acceptance criteria; closed when all its user stories are closed.
- **User Story** — a single user-facing behaviour within a feature, from the user's perspective. Closed when its acceptance criteria are met and CI passes.
- **Task** — optional implementation-level sub-item under a Feature or User Story.

### Checking an Issue's Existing Parent — Use the `parent` Field

**`gh issue view` and the GitHub web UI's main issue view do not display an issue's sub-issue parent at all** — a blank/no-parent view there is *not* evidence of an orphan, and is the most common way a session wrongly "discovers" one. The **only** reliable check is the `parent` GraphQL field; run it before ever concluding an issue is unparented or needs (re)parenting. It is the `parent` field on `Issue` — **not** `trackedInIssues`, `trackedIssues`, or `timelineItems` (different relationships that frequently return empty even when a real sub-issue parent exists).

```bash
gh api graphql -f query='{ repository(owner:"Nossimonov",name:"Mjolnirsoft"){
  issue(number:<N>){ number title
    parent { number title labels(first:5){nodes{name}}
      parent { number title } } } } }' \
  --jq '.data.repository.issue'
```

A non-null `.parent` means the issue is already nested; read `.parent.parent` for the epic. Only when `.parent` is genuinely `null` is it an orphan. When the goal is to *move* an issue, detach from the current parent first (GitHub rejects a second parent: "Sub issue may only have one parent").

### Closing Rules

A User Story closes only when its acceptance criteria are met and CI passes. A Feature closes only when **all its user stories are closed**. An Epic closes only when all its features are closed.

### Before Creating Any Issue

1. **Check for duplicates** — `gh issue list --repo Nossimonov/Mjolnirsoft --search "<keywords>" --state all --limit 100`.
2. **Verify the parent exists** — a Feature needs an open Epic parent; a User Story needs an open Feature parent. Find candidates with `gh issue list --repo Nossimonov/Mjolnirsoft --label <epic|feature> --state open --limit 50`. Don't create orphans.
3. **Don't write speculative design** into the body or ACs (see "No Speculative Design in Artifacts"). ACs describe what the work delivers, not what a hypothetical successor might do.

### Titles

Plain descriptive names only — do not restate the type or parent (the label shows the type; the parent is in the sub-issue view). User-story titles describe what the user does or observes, active voice ("Coordinate two sessions over a shared channel", not "Implement the coordination channel").

### Labels

Every issue gets exactly **one** type label at creation: `epic`, `feature`, `user-story`, or `task`. Never leave an issue unlabeled.

### Body Format

- **Epic:** `## Summary` + `## Features` (checkbox list of feature issues).
- **Feature:** `## Summary` + `## Acceptance Criteria` (testable checkboxes).
- **User Story:** `As a [role], I want to [action] so that [outcome].` + `## Acceptance Criteria`.

### Creating an Issue (full sequence — all steps mandatory)

```bash
# 1. Create with its type label
NUMBER=$(gh issue create --repo Nossimonov/Mjolnirsoft \
  --title "..." --body "..." --label "<label>" | grep -oP '(?<=issues/)\d+')

# 2. Add to the project board (Mjolnirsoft project)
NODE_ID=$(gh api graphql -f query='{ repository(owner:"Nossimonov",name:"Mjolnirsoft"){ issue(number:'"$NUMBER"'){ id } } }' --jq '.data.repository.issue.id')
gh api graphql -f query='mutation { addProjectV2ItemById(input:{projectId:"PVT_kwHOEIjUTs4BVVi-" contentId:"'"$NODE_ID"'"}) { item { id } } }' --jq '.data.addProjectV2ItemById.item.id'

# 3. REQUIRED — link to parent as a sub-issue (Features → Epic, User Stories → Feature)
# PARENT_NODE=$(gh api graphql -f query='{ repository(owner:"Nossimonov",name:"Mjolnirsoft"){ issue(number:<PARENT>){ id } } }' --jq '.data.repository.issue.id')
gh api graphql -f query='mutation { addSubIssue(input:{issueId:"<parent-node-id>" subIssueId:"'"$NODE_ID"'"}) { issue { number } } }'
```

### Project / repo IDs

- Repo: `Nossimonov/Mjolnirsoft`
- Project (board) ID: `PVT_kwHOEIjUTs4BVVi-`
- Milestones: `gh milestone` does not exist — use `gh api repos/Nossimonov/Mjolnirsoft/milestones` for list/create/assign/close.

---

## Design Documentation

The project keeps a single descriptive design record at `docs/DESIGN.md`. It documents **what the project currently does and why it does it that way** — never what is merely desired. This inverts the usual up-front design document, which rots as aspiration meets reality and becomes expensive churn. Here the durable artifact only ever contains shipped reality, so it stays trustworthy and is the most useful orientation a future session can read.

**Division of labour:**

- **Open issues hold desired/proposed design** ("design candidates"). A feature or user-story body proposes design language; that language *evolves in the issue* as implementation meets reality — edit the body as you learn, exactly as you flip AC checkboxes.
- **`docs/DESIGN.md` holds completed design only.** Design language enters it *only* by way of a closed issue. This makes the design record structurally incapable of holding speculation, reinforcing *No Speculative Design in Artifacts*.

**Structure `docs/DESIGN.md` by subsystem/component, not chronologically**, so completed work folds into a located section and cleanly replaces what it supersedes. Each section records both behaviour/contracts **and the rationale** for the shipped decisions — the rationale is the part future sessions most need, to avoid re-litigating settled choices.

**Updating the record is a protocol step, not goodwill.** The close phase of *Issue-Driven Work Discipline* (step 5) folds the now-true design language into the right component section and prunes/replaces any text the change made inaccurate, in the same commit that closes the work. The prune half is what decays if left to memory; the protocol step exists so it does not.

---

## Capturing Deferred Scope

When you trim an issue's acceptance criteria — moving work out of scope before closing — the deferred functionality must land in **tracked artifacts before the issue closes**. A "Removed from scope" note in a closed issue body does not count: closed issues don't surface in `gh issue list` or session-start checks, so the deferral evaporates.

Before closing, both must hold: (1) the design doc (if the project keeps one) captures the deferred mechanic well enough that a future implementer can act; and (2) a **tracked open issue** holds the deferred work (a new issue filed via the hierarchy, an existing issue that already covers it, or a placeholder a future feature will absorb). If neither can land this session, surface that and **do not close** the in-flight issue.
