# Mjolnirsoft Design Record

This document describes **what the project currently does and why** — shipped reality, not aspiration. Proposed and in-progress design lives in open GitHub issues ("design candidates"); language only lands here once the issue that introduced it has closed. See *Design Documentation* in `CLAUDE.md` for the methodology.

When a component does not yet exist, it does not appear here.

---

## System Overview

Mjolnirsoft is a coordination system that orchestrates Claude Code agent sessions. It lets an architect (human authority) direct an **orchestrator** agent, which in turn spawns **executor** and **evaluator** delegates — each isolated in its own worktree and session.

**Agent chain:** architect → orchestrator → executor(s) → evaluator(s). Work flows down; design and permission decisions flow up. The orchestrator owns the bookkeeping protocol; executors and evaluators surface discoveries upward rather than enacting it.

**Structural seam:** a `Channel` is the single coupling between every component. Transport is swappable behind it (in-memory for tests, file-backed for live sessions); the core has no host dependency. Host adapters (CLI, VS Code extension) connect the core to a concrete environment without touching it.

---

## Project Foundation & Tooling

TypeScript/Node project. Tests run on [Vitest](https://vitest.dev) via `npm test`; `npm run typecheck` runs `tsc --noEmit`. A GitHub Actions workflow (`.github/workflows/ci.yml`) runs both on every push and pull request. Machine-specific configuration is gitignored (`.local.env`); `./setup.sh` bootstraps a fresh checkout.

**Key decisions:**

- **TypeScript/Node** — Claude Code is a Node CLI and the Agent SDK ships for TypeScript; the primary host surface (VS Code extensions) is TypeScript regardless. Same ecosystem minimises impedance.
- **Vitest** — native TypeScript execution without a separate compile step.
- **`erasableSyntaxOnly`** — Node ≥ 23.6 strips types in-place (no build step); only type-erasable syntax is valid at runtime (`tsc` flags violations before they reach the runtime — no parameter properties, enums, or namespaces).
- **`.local.env` / `setup.sh`** — machine-specific values stay out of source; a fresh checkout fails fast with actionable guidance when a dependency is missing rather than surfacing cryptic downstream errors.
- **CI gate** — tests must pass in CI before an issue closes; wiring it once makes that enforceable rather than aspirational.

---

## Orchestration Core — Shared Channel

`src/core/` defines the coordination seam. A `Channel` lets participants join under a unique id in a `Role` and exchange typed `Message`s. A participant's handler receives every message sent by *other* participants; `close()` leaves and releases resources.

**Roles:** `planner` (the authoritative architect), `orchestrator`, `executor`, `evaluator`.

**Message shape** (`from`, `role`, `type`, optional `payload`) is deliberately minimal. The sender's `role` is **stamped by the channel** on `send` — callers supply neither `from` nor `role`. A `FileChannel` recipient is a separate process that can't resolve a remote sender's role locally, so the role must travel in the delivered message. This is the integrity seam: authority is legible from the channel's own stamping, so an `executor` peer can never be mistaken for the authoritative `planner` (#86).

**Two implementations:**

- **`InMemoryChannel`** — in-process, synchronous delivery; for single-process use and tests.
- **`FileChannel`** — per-session append-only JSONL log. Sending appends a line; the channel polls for new lines authored by others. The same file is transport, persistence, and shared conversation — separate OS processes opening the same path share one channel.
  - Normal join: delivers only messages appended after joining.
  - `replay: true`: delivers the existing history first, then streams live — the basis for attaching a window to a running session.
  - Replay delivers a participant its **own** historical messages too; live delivery withholds them (already rendered locally). A re-attaching window shows a full conversation, not just the other side (#126).

**Why.** The channel is the single seam between the orchestration engine and any host (terminal, IDE, CI) — analogous to how LSP/MCP separate a server from its clients. File-backed transport makes delivery and persistence one mechanism: an append-only log carries messages across processes *and* is a durable record queryable later. A file (not a broker daemon) is the smallest thing that delivers both, sitting behind the `Channel` seam so a broker could replace it without touching the core or adapters.

---

## Sessions — Addressing by ID

Sessions are addressed by id behind a `SessionBackend` seam (`src/core/`): `open(id, {replay})` returns a `Channel`; `list()` returns known session ids. Session ids are validated to letters, digits, `_` and `-` — `..` and path separators are rejected, so a name can never escape the sessions directory.

**`local` backend (`SessionStore`):** maps ids to a `FileChannel` over `.mjolnir/sessions/<id>.jsonl`.

**`git` backend:** runs the live session on the local file channel; on channel close commits the session record into `refs/mjolnir/sessions` — a dedicated ref **out of the working tree** — durable and pushable without ever touching the working tree, index, HEAD, or any checked-out branch. `list()` enumerates sessions from the ref (unioned with any local-only ones). Uses git plumbing only (`hash-object` → temp-index tree → `commit-tree` → `update-ref`) with a fixed record identity that doesn't depend on git config. Fails fast when git or a repository is absent.

**Backend selection:** `mjolnir.config.json` (`storage.backend`). `loadProjectConfig` reads it; `createSessionStore` maps the id to an implementation, defaulting to `local` when the file is absent and failing fast on an unknown backend. The CLI, orchestrator, `attachInvitation`, and VS Code view all address sessions by id through the factory.

**Why:**
- Hiding the transport file behind an id gives one naming scheme across every surface; file paths never appear in CLI flags, handles, or pickers.
- Backend behind a config-selected seam (not hardcoded) means a project chooses its storage strategy once, in a committed file every agent and CI run reads — distinct from the per-machine `.local.env`. Further backends are adapters.
- The `git` backend keeps the live channel local (git is a durable record store, not a live transport) and stores records out of the working tree so they never pollute a developer's branches.
- Session id validation at the store boundary keeps path-traversal concerns in one place rather than at every caller.

---

## CLI Host Adapter

A thin CLI adapter (`src/cli/`) hosts a session from the terminal. Invoked as `<planner|executor> [id] [--session <id>]` (via `npm run session`): joins a channel in that role and bridges I/O — stdin lines sent as `text` messages, received messages written to stdout.

**Key behaviors:**

- `--session <id>`: opens that session through `SessionStore` (shared `FileChannel`); without it, uses an in-process `InMemoryChannel`.
- `--replay`: attaches to an existing session, replays its transcript before streaming live — doubles as an interactive window onto a running session.
- `--auto`: runs an automated executor (see *Automated Executor*) that responds programmatically rather than bridging a terminal.
- Loads `.local.env` into the environment at startup so values a spawned executor needs (e.g. `CLAUDE_BIN`) are present regardless of how the process was launched.
- A missing or invalid role is rejected with a usage message and non-zero exit.
- `hostSession` (terminal bridging) takes an injected `Channel` — selecting the channel needs no adapter change.

**Why.** Adapters are how the host-agnostic core reaches a concrete host; the core never imports terminal APIs. Runs via Node's native TypeScript execution (`node src/cli/main.ts`, Node ≥ 23.6), avoiding a build step while the project is small. Broad Node-version compatibility or distribution is a deferred lever (minimum-version check or build step).

---

## Orchestrator — Executor Supervision

`spawnExecutor` (`src/orchestrator/`) launches an executor bound to a session (by id, resolved through `SessionStore`) and returns a handle that:

- Reports lifecycle state: `running` → `exited`
- Exposes `stop()` to terminate the executor
- Notifies `onExit` listeners
- Exposes the orchestrator's own `Participant` (planner role) on that session's channel

**Default launcher:** spawns the executor CLI as a Node child process in automated mode (`executor <id> --session <id> --auto`), with stdin piped and left open (executor stays alive until stopped) and stdout/stderr inherited. The launcher is injectable so the supervisor is unit-tested without spawning a real process.

When the executor exits, the orchestrator's channel participant is closed; the session log — the durable transcript — persists.

**Why.** This is the first component that makes the tool an *orchestrator* rather than two manually-launched peers: it owns the executor's lifecycle. Process life and record life are deliberately decoupled — stopping an executor ends the process while its transcript survives for later inspection. This layer adds only spawning and supervision; messaging is reused unchanged from the session-log channel, keeping the orchestrator ignorant of how messages physically travel.

---

## Automated Executor

`runExecutor` (`src/executor/`) joins a session as an executor and replies to each message it receives from another participant, using a replaceable async `Respond` behavior.

### Responder: `createClaudeCodeResponder`

Spawns a headless Claude Code agent — `claude -p "<task>" --output-format stream-json --verbose --include-partial-messages --settings <permission policy>` — in a per-executor workspace. It replies with the agent's final result and streams intermediate output (reasoning, tool use) to the view as it works.

The agent runs on the user's logged-in Claude Code subscription (no API key). Spawning the `claude` CLI rather than embedding the Agent SDK is what enables subscription use (the SDK is documented for API-key auth, which is separate billing).

**Binary resolution:** `resolveClaudeBin()` — uses `CLAUDE_BIN` if set, else `claude`/`claude.exe` from PATH. `CLAUDE_BIN` exists because a spawned subprocess doesn't always inherit the PATH an interactive shell has.

### Permission Policy (`EXECUTOR_PERMISSIONS`)

Pre-allows what a dev task needs — reads, cwd-scoped edits, shell commands. Notable restrictions:

- **Denies Claude's native `Agent` tool** (#131): a spawned agent can't spin up ad-hoc sub-agents — a heavyweight, opaque token sink redundant with `mcp__delegate__*` delegation. A bare deny strips the tool from the agent's context entirely, so it falls back to direct reads or asks upward for missing context.
- **`claudeMdExcludes`** (glob `CLAUDE.md`/`CLAUDE.local.md`) — a spawned agent does **not** auto-load the project `CLAUDE.md` (#121). `claude -p` walks the directory tree to load it, which caused an executor to auto-load norms regardless of role and triggered the issue-discipline ceremony, costing turns and filing a spurious issue. (`--bare` would also drop `CLAUDE.md` but breaks subscription login by skipping OAuth/keychain reads — rejected; `claudeMdExcludes` rides settings and leaves auth untouched.) `CLAUDE.md` is a thin `@AGENTS.md` redirect for other tools; the `claudeMdExcludes` stripping ensures spawned agents never auto-load it.
- **`autoMemoryEnabled: false`** (#132): claude's built-in auto-memory keys its store to the agent's cwd (an ephemeral worktree); any saved note would orphan when the worktree is removed and never be recalled by a later session (which runs in a different worktree). A learning belongs *up* with the architect, surfaced in the hand-off. Auto-memory has no tool to deny, so this `--settings` toggle is the off switch.

### Agent Instructions (`SHARED_CORE`)

Executor-role instructions are appended via `--append-system-prompt` (a soft guardrail, overridable per spawn). They compose the shared model (#71):

- Agent chain and role hierarchy (architect → orchestrator → executor → evaluator)
- Factual / design / permission decision classification; escalate-when-unsure bias
- **Ask-upward-for-context bias** (#131): don't self-survey the project with ad-hoc sub-agents — context is usually known above; ask up and reserve delegation for real tasks
- **Descriptive-record rule**: no speculation in artifacts
- **Project-bookkeeping boundary** (#80/#121): filing/closing issues, PRs, commit-and-close ritual are the orchestrator's to own in coordination with the architect; executors and evaluators surface tracking needs in their hand-offs
- **Pull-on-demand project-norms directive** (#80): every spawned agent reads `AGENTS.md` at the repo root and its role-specific norms file (`docs/agents/<role>.md`) before working — ordinary repo files in the agent's worktree, no loader injection needed; the human's own Claude Code session keeps the full `CLAUDE.md`
- **Session-log literacy** (#102): a recorded human decision's outcome lives in the `interaction-decision`'s `updatedInput.answers` (question → chosen label), not the offered options or any `(Recommended)` marker
- Executor role insert + operational guidance (read widely / write narrowly, cover change with a test, stay in scope, self-review non-trivial changes via an evaluator (#119), don't commit / hand off, justify changes)

The pieces are exported and composable so the orchestrator and evaluator reuse the same core with their own insert.

### Per-Role Models (#119)

Each spawned agent runs on a `--model` flag keyed to its role. Mechanical roles (executor, evaluator) default to a cheaper capable tier (`sonnet`); the orchestrator inherits the user's own default (it carries design judgment). Each is overridable in `settings.json` (`mjolnirsoft.model.<role>`).

The cost driver is *turns × model*: a single Opus task measured ~1.44M tokens (~70% orchestration overhead). Cheaper executors address this alongside ceremony-reduction (#121).

### Sender Attribution

Each message turned into a prompt is prefixed with `[Message from <descriptor> (id: <from>)]` (`senderAttribution`):

- `planner` → `architect — authoritative` (the *only* authoritative sender)
- `orchestrator` → `orchestrator — delegating` — non-authoritative, distinct so an executor can tell its supervisor from a peer while still routing design/permission decisions past it to the architect (#114)
- All other agent roles → plain (non-authoritative) `agent` (#85, #86, #71)

### Message Routing — Allowlist (#116)

`runExecutor` calls the responder only for *conversational* messages — a prompt (`text`), a peer's report (`result`), or a failure (`error`) — gated by the single `deliversToAgent`/`AGENT_PROMPT_TYPES` predicate in `executor-runtime.ts`, **before** a turn is ever queued.

The shared channel also carries infrastructure messages (permission/delegation control, per-turn usage tallies, reasoning digests); these are excluded by default. A newly added infrastructure type can never reach an agent — creating a feedback loop — without being deliberately added to the allowlist. This replaced a per-responder *denylist*, which was fail-open: a new `usage` message slipped through and caused exactly such a loop; the allowlist makes that failure structurally impossible.

### Session Pinning and Turn Serialization

- **Session pinning**: `--session-id <uuid>` on the first message, `--resume <uuid>` after (#40) — the executor retains context across an interactive exchange rather than cold-starting each message. The pinned id is exposed as `claudeSessionId` for the keystone (#40) to record.
- **Deterministic session id** (#126): derived from the session name (`claudeSessionIdFor`), so a session the extension host tore down resumes the *same* `claude` conversation when re-attached — re-deriving the id needs nothing persisted.
- **Create-vs-resume strategy**: a `--session-id` create that collides with an existing id resumes that session; a `--resume` whose conversation doesn't exist falls back to create. A re-attached responder starts already-resumed (first turn uses `--resume`); if the conversation doesn't exist, it falls back to creating fresh and retries.
- **Turn serialization** (#100): turns are chained — only one `claude` run in flight at a time. A message arriving while a turn runs is queued and executed in order once the current turn settles. A failed turn still settles the chain so one failure can't wedge the queue.

### Transient Failure Recovery (#141)

A turn **recovers within itself**: `529`/`503`/`429`/overloaded errors are retried with exponential backoff. Re-running re-sends the same prompt, so the task is never lost. The pinned session id is **never rotated**.

This replaced an earlier scheme that rotated to a fresh id on any pre-session failure — which discarded the session and, when the retry arrived as a different prompt (e.g. a human "Resume"), silently dropped the delegated task during an overload.

### Streaming and Reasoning Digest (#108, #110)

`claude` is invoked with `--output-format stream-json --verbose --include-partial-messages`. The responder reads NDJSON line-by-line via `createStreamReader` (pure and unit-tested), feeds the `result` line to `interpretClaudeResult`, and feeds all lines to a **reasoning-digest assembler** (`reasoning-digest.ts`) that serves both the live view and the durable log from one source (so they can't diverge).

**Assembler behavior:**
- Coalesces per-token deltas into **block-level** entries: whole thinking block(s), interim narration (each assembled verbatim from deltas), and tool-uses with action detail (tool input + trimmed head+tail of result, capped at `MAX_TOOL_RESULT_CHARS` to avoid log bloat)
- Tracks the assistant message's open content blocks by index (`message_start` restarts indices; `content_block_stop` finalizes a block in order) and attaches each tool's `tool_result` by `tool_use_id`
- The turn's **final answer text is excluded** from the digest — a trailing text block is held back and dropped (an interim text block is kept once a later block follows it); the digest is *reasoning*, not a duplicate of the answer
- Emits a fresh **snapshot** via `onReasoningChange` each time an entry finalizes (drives the live view); hands the final digest back via `onDigest` on close
- Pure of I/O; unit-tested against captured stream lines with no real `claude`

The responder posts the assembled digest as a `reasoning-digest` message **before** the `result`, distinct from it; an empty digest (no reasoning or tools) is skipped. `Respond` returns a single message *or an ordered list*, which `runExecutor` sends in order — this path is host-agnostic, so every host (CLI included) gets the digest.

`parseStreamEvent` is retained for `result` detection and direct stream-shape tests; the live view no longer consumes its per-token `ViewEvent`s.

On the user's subscription (`apiKeySource:"none"`), the headless stream carries text + tool-use but **not** extended-thinking blocks; the assembler captures thinking correctly if it ever appears (unit-tested, forward-compatible). Enabling thinking headless was declined — `think`/`ultrathink` keyword triggers don't work in `-p` and the extra-output token cost isn't judged worth the value.

### Turn Failure Handling (#89)

When a turn fails (the `claude` subprocess exits non-zero), `runExecutor` posts the failure onto the channel as an attributed `error` message (and to stderr for host-log detail). Routing through the channel means it reaches every host and the durable log, and stops the view's "working" indicator instead of leaving it ticking forever on a wedged session.

The failure detail is taken from `claude`'s stdout JSON `result` (where it writes the human-readable error — an expired/absent login surfaces `"Not logged in · Please run /login"` with `is_error: true`), via the pure, tested `interpretClaudeResult`. Taking it from stderr alone left it empty. The VS Code view recognises an auth failure to offer guided re-login and retry (#90 — see *VS Code Session View*).

### Testing

The spawn step is injectable; CI never invokes the real `claude`. A trivial `acknowledge` responder exists for transport-only tests. The session CLI runs an executor via `--auto` and the orchestrator spawns its executors in `--auto` mode, so spawning an executor, sending it a task, and receiving its Claude Code result is a complete coordination round-trip — observable by attaching a `--replay` window to the same session.

**Why.** Keeping the agent behind a single replaceable `Respond` seam meant transport, lifecycle, and attach were proven with a stub first, then the real Claude Code agent dropped in without touching them. The seam is also where a different agent implementation could attach later. Replies go only to others' messages, and an agent is routed only conversation (the allowlist above), so neither the round-trip nor an infrastructure message can loop the agent.

---

## Token Usage Accounting

Each turn's token usage is captured from the `claude` result line. `extractUsage` reads `input`/`output`/`cache-read`/`cache-creation` token counts into a `Usage` (USD cost is *not* recorded — the subscription result carries no `total_cost_usd`).

**`UsageMeter` (`usage-meter.ts`):**
- Accumulates each turn's `Usage` **by code** — no agent turn spent counting
- Exposes a running total and a subscribe seam
- A meter created with `onAdd` **rolls up** into its spawner's meter, so an orchestrator's total includes every delegate it spawned, recursively

**Persistence (#116):** each turn's usage is posted as a `usage` message onto the session channel as the turn completes — it lands in the durable JSONL continuously, not batched at session close. A long-lived session (the orchestrator can stay open for weeks) keeps up-to-date accounting that survives teardown; each turn's cost is individually recoverable for post-mortem ("which turn thought hardest").

**Post-hoc analysis (#233):** a committed CLI — `npm run usage` (`src/cli/usage.ts`), with pure analysis in `src/executor/usage-report.ts` — reads per-turn `usage` deltas from session JSONL:
- `--tree`: aggregates a delegate's sub-sessions
- `--from`: anchors a time window
- `--mermaid`: emits an xychart + composition pie
- Reuses `weightedUsage` so the report and the in-product figure can never diverge
- Flags sessions that logged no usage (e.g. evaluators, whose persistence is #232) so a tree total isn't silently undercounted

**Why.** Token usage is a performance dimension alongside elapsed time (#76) and per-role model choice (#119) — together the levers of sustainable spend (#118). Capturing from the result line by code keeps it free and accurate (summing the project transcript double-counts under `--include-partial-messages`). Persisting **per turn** rather than one close-time total makes accounting correct for long-lived components, resilient to teardown, and analyzable per operation rather than one opaque lifetime number. Per-task tallies and context-growth visibility for the orchestrator build on this per-turn foundation and are deferred to orchestrator work (#58).

---

## Agent-to-Agent Delegation

`createDelegationManager` (`src/executor/delegation.ts`) is the transport-free primitive by which a *spawner* agent delegates to a *delegate* agent and sees the delegate's report on its own channel (#88, rung 2 of #85).

### Delegation Primitive

`spawn(role, openingTask)` derives the delegate's id as `${spawnerId}-${role}-${n}-${token}`:
- `n` — per-manager monotonic counter (cosmetic, keeps spawn order legible in logs)
- `token` — 8 random hex chars from `randomUUID()`, collision-resistant (~1-in-4-billion per pair of spawns). Uniqueness comes from the token, not the resettable counter, so the id survives a counter reset (a window reload destroys the in-process manager and resets `n` to 0) and never collides with leftover branches from squash-merged delegates.
- Token generator injectable via `DelegationDeps.generateToken` for deterministic tests

Each delegate stands up three seats:
- **delegate** — a `runExecutor` responder on the sub-channel, in its own role
- **reporter** — the delegate's seat on the *spawner's* channel
- **driver** — the spawner's seat on the sub-channel

The driver sends the opening task; the delegate's reply bridges **up** through the reporter. The channel stamps the report `from: <delegateId>, role`, so `senderAttribution` reads it as a (non-authoritative) agent report, never indistinguishable from the architect's instruction.

The delegate's full exchange stays on its sub-channel; only the **distilled report** crosses up. The driver bridges only conversational messages (gated by `deliversToAgent` from #116) — a delegate's reasoning digest and other infrastructure persist on its own sub-channel log for later post-mortem without being fed up to the spawner as a turn.

`spawn` **returns the id immediately without awaiting the reply** — delegation never blocks the spawner.

`shutdown(id)` leaves all three seats and closes the sub-channel (idempotent for an unknown id). `runExecutor` gained an optional `role` parameter (default `executor`, unchanged callers) so a delegate joins its sub-channel honestly attributed.

`DelegationDeps.createDelegate(role, id, sub) → { close, reportFrom? }` is injectable: rung 2 proved the whole seam with an `acknowledge` echo delegate and no real `claude`; a real `claude`-backed delegate dropped in behind the same seam in rung 3. The optional `reportFrom` names which sub-channel seat carries the delegate's report (default: the delegate id), so the bridge tracks the agent's reply even when its agent runs under a suffixed seat (`${id}-executor`).

### Live Delegation — MCP Tools (Rung 3, #93)

An executor's `claude` calls MCP tools — `mcp__delegate__spawn` / `shutdown` — exposed by a second bundled server (`delegation-mcp-server.ts`) and pre-allowed in the executor policy so a spawn never dead-ends on a prompt. The server posts a `delegation-request` onto the session channel (`delegation-protocol.ts`); the host answers from `createDelegationHost`, which validates the requested role is a real `AgentRole` before spawning. The channel is the bridge (same log, no extra transport).

**Evaluator role** (`composeAgentInstructions('evaluator')`, #57): a fresh-eyes, no-stake critic that reviews "the changes or state under review" — phrased generally so the one role serves an executor's diff, an orchestrator's design review, or a contributor's PR — and returns a distilled finding, never an edit.

**Finding classification (#104):**
- **Legible** findings (objective — a bug, an omission, something that renders invisibly): scored cold, flagged actionable
- **Judgment** findings (turn on a reader-effect a cold read can miss): tagged and routed up for the human to weigh, not settled with a cold verdict

The evaluator raises these by reporting up the chain — the evaluator marks, its spawner escalates. Direct mid-evaluation escalation to the architect was deferred as overlapping #58's inter-session routing.

A spawned delegate runs on **the spawner's own worktree** (critique shape), so it reviews what *is* (an evaluator runs `git diff` against the executor's uncommitted work). The review trigger is task-scoped, not baked into standing instructions. Proven end-to-end: an executor spawned an evaluator that cold-read its diff and caught, on its first run, that an HTML comment renders invisibly in Markdown.

### Multi-Turn Delegation (#111)

Alongside `spawn`/`shutdown`, a pre-allowed `mcp__delegate__send` tool carries a follow-up to a *live* delegate: the host routes it through the delegate's stored driver onto its sub-channel; the responder takes it as another turn (`--resume`s its pinned `claude` session) and its reply bridges up as before. `send` reports whether a live delegate received it.

Role guidance bounds the exchange:
- A delegate **asks upward when blocked** — an operational blocker or clarification — by ending its turn with the question rather than degrading the task and burying the limitation in its hand-off
- The spawner **answers operationally** (enablement — a path, env var, command) but **never steers an evaluator's judgment**, preserving the no-stake stance (#71/#104)

Surfaced by #109, where a spawned evaluator could only do a static review because it couldn't run the suite and had no way to ask for the PATH.

### Executor-Delegate Mode (#114, Rung 1 of #58)

`createDelegationHost` provisions a delegate by **role**:

- **Critique role (evaluator):** shared worktree mode — a `claude` responder on the *spawner's own* worktree, so it reviews "what is"
- **Executor role:** provisions a **fresh isolated worktree + full executor wiring** (responder, permission/delegation MCP, a nested delegation host, a live reasoning stream) on the delegate's own sub-channel via the same session-provisioning helper the `Start … Session` commands use — a *real, attachable* session (appears in the session list; architect attaches on demand; no panel is auto-opened)

The distilled hand-off bridges up to the spawner as the spawner's turn; the delegate's reasoning trail and permission cards stay on its own sub-channel. The host's `spawnerRole` is configurable (default `executor`): an orchestrator host stamps its driver seat `orchestrator`, so an executor delegate reads its opening task attributed to its delegating supervisor (#86).

**Orchestrator review and integration (#137):** on a hand-off the orchestrator reviews the delegate's branch against the goal (leaning on the executor's own self-review, spawning an evaluator only on doubt) and either integrates it — pushing the branch and opening a PR for the architect to review and merge — or sends the delegate a follow-up to refine (#111). The architect's merge is the ratification (#71).

Integration discipline (#142): before opening a delegate's diff at all, the orchestrator must name the specific unresolved question reading it will answer; if it can't, it's done reviewing and integrates from the hand-off as it stands. An early run's integrate turn hit 2.1M cache-read tokens pulling a full diff into its long-lived context — that is the failure mode this discipline exists to prevent.

**Role-specific permission policy (`permissionPolicyFor`):** the orchestrator can `git push` and run `gh` for integration (force-push still denied); executors keep the no-push base.

### Why

Built and proven standalone before the AI orchestrator (#58), which depends on it — as do the Evaluator, Investigator, and Arbitrator roles. Deliberately **async and channel-native** rather than a blocking `delegate→await` call: a delegate is just another participant whose messages trigger the spawner's turns exactly as the architect's do, reusing the existing channel + responder model without inventing a new mechanism.

The **sub-channel** keeps a delegate's full output out of the spawner's context — only the distilled report crosses up; the spawner can ask for more on the live sub-channel or read the delegate's log later.

Posting the report through a seat joined *as the delegate* (rather than re-tagging) makes attribution structural: authority is legible from the channel's own stamping, so a delegate cannot borrow the architect's authority and subvert "route design up" (#71).

Mirroring `PermissionBridge`'s transport-free shape keeps it unit-testable over `InMemoryChannel`s with no real `claude`, so the bridge plumbing was proven before any agent-invokable tool or live delegate was layered on.

---

## Arbitrator Delegate Role (#99)

The **arbitrator** is a delegate role whose single task is **reconciling two conflicting branches into a clean merge**. It is neutral with no stake in either side and works from each side's *intent* (what its session log shows it was trying to accomplish) rather than from the textual diff alone. It is *not* a critic (it produces a reconciled branch, not a finding) and it never authors new design.

**Provisioned on the executor shape:** isolated worktree + full executor wiring via `provisionExecutorDelegate` (not the shared-worktree critique shape used by the evaluator). It can edit and commit work in its own branch and hand it off to the orchestrator the same way an executor does. The orchestrator integrates via the normal push + PR path; the architect's merge is the ratification.

### Opening Task

The orchestrator conveys the following in the arbitrator's opening task (no new plumbing — all named in the task text):

- **Branch A name** and **Branch B name** — the conflicting branches
- **Session id for A** and **Session id for B** — so the arbitrator reads each side's full session log via the session store (with the git backend, logs live on `refs/mjolnir/sessions`, not in the working tree)
- **Reconciliation goal** — what the merged result should accomplish (the context the orchestrator held when it originally delegated both tasks)

### Escalation

When the arbitrator encounters a conflict it cannot resolve from the record — both sides' intents are genuine and the logs don't establish which should win — it ends its turn with a precise escalation question: the conflicting goals, what is at stake, and the specific decision needed. Guessing would entrench a direction the architect never authorized.

### Scope and Parallel Delegation (#153)

The role exists, is spawnable, and is provisioned on the executor (isolated-worktree) shape. Conflict auto-detection is a later step. The orchestrator's "one task at a time" constraint was lifted in #153: parallel delegation is now permitted when the architect directs it. The orchestrator spawns an Arbitrator to reconcile conflicting parallel branches at integration; non-conflicting parallel branches integrate as separate PRs.

**Why.** When two executor delegates work on related tasks in isolation and their branches diverge, the orchestrator integrating both would have to absorb each side's full context to make a principled merge — exactly the heavy, context-bloating work delegation is designed to avoid. The arbitrator absorbs that context in its own isolated session and produces one clean branch. Intent-driven reconciliation (reading session logs) is what distinguishes this from a mechanical `git merge`: the arbitrator can apply design intent the diff can't encode, and it knows to escalate when the design record is the missing piece.

---

## Structured Executor–Human Interactions

`#62`'s `--settings` policy pre-allows common in-worktree work, but a static allow-list can't be exhaustive — a headless executor hitting something it isn't pre-allowed to do would dead-end with a prompt no one can answer. An executor can be spawned with `--permission-prompt-tool mcp__perm__approve --mcp-config <generated>` pointing at a permission MCP server (`src/executor/permission-mcp-server.ts`).

### Permission Bridge

When Claude wants a tool use not auto-approved, it calls the server's `approve` tool with `{ tool_name, input, tool_use_id }`. The server:

1. Posts an `interaction-request` onto the executor's session channel
2. Blocks until a matching `interaction-decision` returns
3. Returns the verdict Claude expects — `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`

The channel is the bridge: file-backed and cross-process, so the standalone server and the view meet on the same session log with no new transport. The interaction vocabulary lives in `src/core/interaction.ts` (`interaction-request`/`interaction-decision`, plus `decisionToVerdict`). The request-and-await-decision logic is a transport-free `PermissionBridge` (`src/executor/permission-bridge.ts`) unit-tested over an in-memory channel. The Claude responder ignores interaction messages so it never re-enters Claude on its own mid-run request.

**What actually escalates:** in headless `claude -p`, print mode auto-approves most tool use (in-worktree edits, Bash) without consulting the prompt tool, and gates boundary-crossing actions — writes outside the worktree or to a protected path. The escalation surface lines up with the worktree-confinement boundary; #62's `deny` rules remain the hard floor for the dangerous auto-approved cases.

### `AskUserQuestion` — Clarifying Questions (#68)

An executor's `AskUserQuestion` arrives through the identical `approve` tool as `{ tool_name: "AskUserQuestion", input: { questions } }`. The view dispatches on `tool_name` to render its options (single- or multi-select) instead of allow/deny. The pick returns as the allow's `updatedInput = { questions, answers }` — the shape Claude's tool expects — with no server or protocol change, only a second renderer.

### Learned Rules (#70)

The card also offers "Always": the host records a learned allow-rule at parent-directory granularity (an "Always" on `C:/x/y.txt` remembers `Write(C:/x/**)`) into a gitignored per-project file (`.mjolnir/executor-permissions.json`). On each `approve` call the server derives the request's rule (`learnedRuleFor`) and, if it is in the persisted set (`matchesLearnedRule`), returns `allow` without prompting and posts an audit line to the transcript.

Consuming the rule in our MCP layer is deliberate and load-bearing: Claude's `--settings` allow rules **don't** reach an out-of-cwd write (it gates those at its access layer before allow rules are consulted, verified across six rule formats plus `--add-dir`), so a learned `--settings` entry would silently do nothing. An unset project dir disables auto-allow so a misconfigured server fails *toward asking*; the `deny` floor still wins (enforced before `approve` is called), so a learned rule can't unlock a denied foot-gun.

### Worktree-Confinement Guardrail (#101)

Because the worktree is nested in the repo, every file exists twice, and a careless allow on a write to the *main* copy would pollute the developer's working tree. Before any auto-allow or escalation, `approve` runs `outOfWorktreeWriteDenial` (`worktree-confinement.ts`) — a pure, tested function that auto-denies a gated **write** (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) whose target resolves outside the executor's worktree. Running it *before* the learned-rule check means no "Always" rule can unlock it. Reads and in-worktree writes pass through untouched; `Bash` shell-writes are out of scope (no clean path arg — left to the `deny` floor).

Path comparison is lexical via `path.win32` (deterministic on Linux CI, correct on the Windows host), canonicalised and prefix-checked so siblings and `..`-escapes can't slip through. The worktree path reaches the server via `MJOLNIR_WORKTREE_DIR`; an unset value fails *toward asking*. This hardens #62's soft confinement: native Windows has no OS sandbox, so the real boundary is the worktree cwd + role instructions + the developer's branch review — the guardrail makes the write boundary non-bypassable rather than advisory, but the executor role and the developer's review remain the outer layer.

**Why.** Both permission approval and `AskUserQuestion` ride Claude's one `--permission-prompt-tool` contract (verified live against the CLI), so the channel mirrors it with a *single* `interaction-request`/`interaction-decision` envelope dispatched on `tool_name` — clarifying questions are the second renderer and cost exactly that: a renderer, not a new protocol. Bridging over the existing file-backed channel reuses the one cross-process transport already in the system; the request/decision pair also leaves a durable, attributable audit trail of every boundary-crossing action and its ruling. Staying on `--permission-prompt-tool` (the CLI's headless stand-in for the Agent SDK `canUseTool`) keeps the executor on the subscription, not the API-key SDK.

---

## Engaging with an Executor

`attachInvitation` (`src/orchestrator/`) turns a spawned executor's handle into what a user needs to engage: the executor id, its session id, and the exact `--session <id> --replay` command to open a window onto that session. The orchestrator surfaces this; the user opens the window when they choose, joins as a planner (co-prompter), sees the conversation so far, and can give feedback or corrections the executor receives as attributed turns.

**Why.** The user's window is just another participant attaching through the channel, so "opening it" is surfacing an attach handle — robust and cross-platform — not new plumbing. Automatically opening a richer surface (a graphical Markdown/Mermaid window) is the job of that surface, not a fragile terminal-spawn here.

---

## VS Code Session View (Extension)

A VS Code extension (`extension/`, an npm-workspaces package bundled with esbuild) is the rich host adapter. It contributes commands for starting and opening sessions, renders a session panel with live agent output, and handles permission escalations and interactions inline.

### Commands and Session Provisioning

**Front door — *Mjolnirsoft: Open Session View*:** lists the workspace's sessions by id in a quick-pick (no file dialog), with a "+ Start a new executor session" option above them; picking an existing session opens a webview panel attached to it. When no sessions yet exist, goes straight to starting one.

Two session-starting commands, both routing through one factored helper (`provisionSession`, parameterized by role, #114):

- **`Mjolnirsoft: Start Executor Session`:** prompts for a session name; creates a dedicated git worktree on a fresh branch (`mjolnir/work/<id>`, via `WorktreeManager`) **based on the freshest `origin/main`** — `currentRemoteBase` fetches and forks the worktree from the latest merged code; falls back to local `HEAD` when there's no remote or the fetch fails (#83). The fresh-base requirement surfaced when a prior session started on stale pre-rename code.
- **`Mjolnirsoft: Open Orchestrator`:** opens *the* single orchestrator **directly at a fixed id, no name prompt** — attaches if already live, otherwise launches/resumes it (#123, the extension presenting itself as **"Mjolnirsoft Orchestrator"**). The **orchestrator works out of the *main repo* with no worktree** (#123): it coordinates and never implements, so a separate branch is only friction; by the architect's decision it writes the repo like the architect's own session (its confinement boundary is the repo itself). Being the singleton, it always resumes its one conversation when re-opened.

`provisionSession` then: writes the per-session MCP config, opens the live reasoning stream, spawns a Claude Code agent in-process in the extension host (composing that role's instructions) with that workspace as its cwd, and stands up the in-host delegation host. The command then opens the panel — session started and driven entirely from the editor, no terminal.

### Session Panel — Rendering

The extension host joins the session as a `planner` participant through `SessionStore` (`replay: true`), replaying the transcript then streaming live. Each message is rendered host-side to HTML (`markdown-it`, with `mermaid` code fences emitted as `<pre class="mermaid">`) and posted to the webview; a bundled script runs `mermaid` to draw diagrams.

**Two renderers differing only in newline handling (#95):**
- **`renderComposed`** (`breaks: true`): for `planner` turns typed into the composer, and multi-line/Markdown content a question card shows for review — every newline survives as `<br>`, a multi-line message shows as entered. The raw question text rides in `data-question` untouched, as the answer key the webview reads back.
- **Agent output:** default soft-break Markdown semantics, which agent prose is authored against.

The split is scoped (chosen over a global `breaks: true`) so the composer is faithful without forcing ragged hard breaks on agent prose. The renderer is keyed on the message's `role`, which encodes the authoritative seat, not authorship — fine while the only `planner` turn rendered is its own composed send; a future automated orchestrator emitting prose as `planner` would want a per-message "composed" flag instead.

**Composer:** multi-line; Enter sends, Shift+Enter inserts a newline. A send posts the whole text as one `text` message and echoes the sent turn locally (the channel does not deliver a participant its own messages).

**Turn colour-coding:** each turn is colour-coded by a hue derived from the `from` id so a multi-participant conversation reads at a glance.

**Model display (#119):** a persistent session header (`<session> · <role> · model: <model>`) at the top; each response turn header shows the model that produced it. An agent's own turns carry the session's model; a bridged delegate report carries the delegate's model, looked up in the live-session registry. (Replaced a transient toast, which truncated and went unread.)

Closing the panel leaves the session. **`retainContextWhenHidden`:** the panel is created with this flag so switching editor tabs preserves the rendered conversation and any unsent composer text (a hidden webview is otherwise destroyed and recreated empty; history replays only once at join).

### Session Panel — Indicators

**"Working" indicator (#76):** shown **only when a live executor is attached** — ticks an elapsed timer from send until a reply arrives. A view-only panel warns on send that the message is logged but won't be answered. The host owns both decisions (it alone reliably knows whether an executor is attached), so the webview just renders what it's told — the indicator can never falsely claim work is happening.

**Queued messages cue (#100):** when messages stack up behind an in-flight turn, the view shows `↳ N message(s) queued…`. Only the executor's *own* reply (matched on its participant id) settles a turn, so a bridged delegate report renders without prematurely clearing the indicator.

### Live Reasoning and Digest (#108, #110)

The responder pushes **block-level digest snapshots** over an in-process, **off-channel** path (`reasoning-stream.ts`, a per-session pub/sub) to the host. The host renders each with `renderReasoningDigestLive` and posts the HTML to **replace one reasoning box in place** — a single `💭 Reasoning` box builds up block-by-block as the turn runs.

The box holds: thinking (dimmed), interim narration, and tool-uses (each a nested twisty showing input + trimmed result). The turn's **final answer renders only in its own result bubble** below, never duplicated. Snapshots are ephemeral: never on the durable channel/JSONL log, gone on reload.

The **durable counterpart** is the per-turn reasoning digest (#110, assembled in the host-agnostic runtime — see *Automated Executor*). It arrives on the channel as a `reasoning-digest` message just before the `result`:
- **Live panel:** rendered once more **collapsed**, settling the box in place (no discard, no double-show, no view swap); the `reasoning-digest` message does *not* settle the turn (the `result` that follows it does)
- **Replay/viewer panel:** renders as its own collapsed box, surviving reload

One renderer for both live and persisted makes them identical and prevents the box from ever swapping views (the #108 unification, which also folds in #113: distinct blocks render as separate paragraphs). On the subscription surface the stream emits no thinking blocks; in practice the box shows narration + tools.

### Permission and Interaction Cards

The view wires the executor's permission escalation: writes a per-session MCP config pointing Claude's `--permission-prompt-tool` at the bundled server (launched with the host's own Node via `ELECTRON_RUN_AS_NODE`, bridging the session's channel log), and renders interaction requests as inline cards dispatched on `tool_name`:
- **Permission card:** allow/deny; returns just the verdict
- **`AskUserQuestion` card:** selectable options (empty-submit guarded); the host assembles picks against the stored request into `updatedInput = { questions, answers }` before sending the decision back to the executor

### Auth Failure Recovery (#90)

The view classifies an `error` turn via `isAuthError` (`src/executor/auth-error.ts`) — known credential-failure strings matched case-insensitively: `401`, `Invalid authentication credentials`, `Not logged in`, `OAuth token has expired`/`revoked`, `Please run /login`. On a match, renders a recovery card instead of the plain `error` turn:
- **"Log in again":** opens an integrated terminal launching `claude` directly as the terminal process via `shellPath`/`shellArgs` (so a `CLAUDE_BIN` path with spaces works on any default shell, no per-shell quoting) running `auth login` — the only path since the official extension exposes no command API for its OAuth flow
- **"Retry":** re-sends the host-held last-sent task to the still-alive executor, whose next spawn reads the refreshed credentials

A non-match falls back to the plain `error` turn — never silent. Classification is view-side so the executor/core stays host-agnostic.

### Session Registry and Live-Session Attachment

Each in-host session (commands and every spawned executor delegate) registers its live wiring (agent seat, reasoning stream, role) in a small registry while it runs. When the architect picks a session from the front door, the panel attaches to the *live* session (live reasoning, role-apt label, answerable permission cards) instead of a viewer-only replay. The delegation host's executor-delegate mode (#114) provisions delegates through the same `provisionSession` code path — each delegate is a real session that appears in the front-door list.

### Window Reload Resilience (#126)

The in-host agent dies on reload, but its worktree and its `claude` conversation persist. Re-opening from the front door **resumes** it: `provisionSession` reattaches to the existing worktree (the signal for *interrupted*, not ended — a clean close removes the worktree), resumes the conversation, re-registers it live, and seeds the usage tally from the log so the header continues rather than resetting. The session's role is recovered from its log so the right kind of agent is re-provisioned. The worktree-less orchestrator has no interrupted-vs-ended signal — being the singleton it always resumes its one conversation when re-opened (#123).

Activate prunes stale `git worktree` admin entries a prior teardown left behind, while keeping the worktree directories that back resumable sessions. Re-establishing the live orchestrator→delegate bridge, and auto-reopening panels that were open before the reload, are tracked in #128. A reload still loses the single in-flight turn — inherent to an in-process agent, since `claude` persists only completed turns.

**Why.** This is the rich counterpart to the terminal CLI window, built VS Code-first because that is where the work happens. It is a host adapter: the webview is pure presentation and the extension host bridges a `Channel`, so the core is untouched and the panel is just another participant attaching to a session — agnostic to whether a human or the orchestrator started the executor. The composer sends a whole message at once because the line-per-message limit is a CLI-adapter artifact, not a session property. It is its own workspace package because a VS Code manifest and bundling cannot share the root package — esbuild here is the project's first build step (the headless code still runs build-free on Node). The webview CSP allows `'unsafe-eval'` (Mermaid uses `new Function`) and `'unsafe-inline'` styles (Mermaid injects SVG styling), scoped to our own content inside VS Code's already-sandboxed webview. The Markdown→HTML logic is unit-tested headlessly; the live attach + compose/send and spawn-from-view flow are verified manually by launching the extension (F5, or sideloaded). The spawned executor runs in-process because the extension host's `process.execPath` is VS Code, not node — spawning a node child is awkward, whereas the executor's own `claude` is a separate process found via `CLAUDE_BIN` (loaded from `.local.env`). It works in a git worktree so it can edit the real repo with hard isolation from the developer's working tree; the system captures its branch at session end for the developer to review.
