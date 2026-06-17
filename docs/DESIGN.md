# Mjolnirsoft Design Record

This document describes **what the project currently does and why** — shipped reality, not aspiration. Proposed and in-progress design lives in open GitHub issues ("design candidates"); language only lands here once the issue that introduced it has closed. See *Design Documentation* in `CLAUDE.md` for the methodology.

Organised by subsystem. When a component does not yet exist, it does not yet appear here.

---

## Project foundation & tooling

**What it does.** The repository is a TypeScript/Node project. Tests run on [vitest](https://vitest.dev) via `npm test`; `npm run typecheck` runs `tsc --noEmit`. A GitHub Actions workflow (`.github/workflows/ci.yml`) runs the typecheck and the test suite on every push and pull request. Machine-specific configuration is kept out of source via the gitignored `.local.env` convention. First-run setup is automated by `./setup.sh`, which validates that Node and npm are present, installs dependencies, and creates `.local.env` from the checked-in `.local.env.example` template.

**Why.** The orchestration tooling coordinates Claude Code sessions; Claude Code is itself a Node CLI and the Claude Agent SDK ships for TypeScript, so building in the same ecosystem minimises impedance — and the dominant future host-integration surface (VS Code extensions) is TypeScript regardless. vitest was chosen for native TypeScript execution without a separate compile step. CI runs the suite on every push because the project's testing discipline requires tests to pass in CI before an issue closes; wiring it once makes that enforceable rather than aspirational. `setup.sh` exists so a fresh checkout fails fast with actionable guidance when a dependency is missing, rather than surfacing cryptic downstream errors.

---

## Orchestration core — shared channel

**What it does.** The headless core (`src/core/`) defines the coordination seam. A `Channel` lets participants join under a unique id in a `Role` (`planner` or `worker`) and exchange typed `Message`s; a participant's handler receives every message sent by *other* participants, and `close()` lets it leave and release resources. The core has no terminal or host dependency. The `Message` shape is deliberately minimal (`from`, `type`, optional `payload`) — an attributed turn in the shared transcript — and expected to evolve.

Two `Channel` implementations exist:
- **`InMemoryChannel`** — in-process, synchronous delivery; for single-process use and tests.
- **`FileChannel`** — backs a session with a per-session append-only JSONL log (one `Message` per line). Sending appends a line; the channel polls the file and delivers new lines authored by others. The same file is the transport, the persistence (a durable transcript), and the shared conversation, so participants in separate OS processes that open the same path share one channel. A participant sees only messages appended after it joins; constructing the channel with `replay` instead delivers the existing history first and then streams live — the basis for attaching a window to a running session.

**Why.** The architecture treats the channel as the single seam between the orchestration engine and any host (terminal, IDE, CI), the way LSP/MCP separate a server from its clients — which is why the transport could be chosen *after* the core and adapter shapes were known. The file-backed transport was chosen so delivery and persistence are one mechanism: an append-only log carries messages across processes and *is* the durable record a session can be queried about later. A file (rather than a broker daemon) is the smallest thing that delivers both, and it sits behind the `Channel` seam, so a broker can replace it later without touching the core or adapters.

---

## CLI host adapter

**What it does.** A thin CLI adapter (`src/cli/`) hosts a session from the terminal. Invoked as `<planner|worker> [id] [--log <path>]` (via `npm run session`), it joins a channel in that role and bridges I/O: each stdin line is sent as a `text` message, and messages received from the channel are written to stdout. With `--log` it uses a shared `FileChannel`, so two CLI processes pointed at the same log share one session; without it, an in-process `InMemoryChannel`. Adding `--replay` attaches to an existing session and replays its transcript before streaming live — so the session CLI doubles as an interactive window onto a running session, where the user's typed lines are sent as attributed turns. A missing or invalid role is rejected with a usage message and a non-zero exit. The terminal bridging (`hostSession`) is separate from the core and takes an injected `Channel` — selecting the channel needs no adapter change.

**Why.** Adapters are how the host-agnostic design reaches a concrete host: the core never imports terminal APIs — only the adapter does. The CLI runs via Node's native TypeScript execution (`node src/cli/main.ts`, Node ≥ 23.6), avoiding a build step while the project is small. Because Node runs TypeScript in *strip-only* mode, the project enables `erasableSyntaxOnly` so only type-erasable syntax is used (no parameter properties, enums, or namespaces) and `tsc` flags violations before they reach the runtime. If broad Node-version compatibility or distribution later matters, a minimum-version check or a build step is the lever (deferred).

---

## Orchestrator — worker supervision

**What it does.** `spawnWorker` (`src/orchestrator/`) launches a worker bound to a per-session log and returns a handle that reports lifecycle state (`running` → `exited`), can `stop()` the worker, notifies `onExit` listeners, and exposes the orchestrator's own `Participant` (planner role) on that session's channel. The default launcher spawns the worker CLI as a Node child process with stdin piped and left open (so the worker tails until stopped) and stdout/stderr inherited; the launcher is injectable so the supervisor is unit-tested without spawning a real process. When the worker exits, the orchestrator's channel participant is closed, but the session log — the durable transcript — persists.

**Why.** This is the first component that makes the tool an *orchestrator* rather than two manually-launched peers: it owns the worker's lifecycle. Process life and record life are deliberately decoupled — stopping a worker ends the process while its transcript survives for later inspection. Messaging is reused unchanged from the session-log channel; this layer adds only spawning and supervision, so the seam keeps the orchestrator ignorant of how messages physically travel.

---

_Remaining toward end-to-end coordination, tracked under Feature #6: multiple clients attaching to one live session with replay-on-join (the interactive window); and querying a past session's recorded transcript. These are proposed design candidates and will be recorded here as they ship._
