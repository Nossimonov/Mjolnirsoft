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

## Sessions — addressing by id

**What it does.** Sessions are addressed by id behind a `SessionBackend` seam (`src/core/`): `open(id, {replay})` returns a `Channel` for that id and `list()` returns the known session ids. The shipped backend is `local` — `SessionStore`, which maps ids to a `FileChannel` over `.mjolnir/sessions/<id>.jsonl`, validating ids to letters, digits, `_` and `-` so a name can never escape the sessions directory (`..` and path separators are rejected). Which backend is mounted is chosen by a committed `mjolnir.config.json` (`storage.backend`): `loadProjectConfig` reads it and `createSessionStore` maps the id to an implementation, defaulting to `local` when the file is absent and failing fast on an unknown backend. The CLI (`--session`), the orchestrator (`spawnWorker`), the engage handle (`attachInvitation`), and the VS Code view all address sessions by id; the CLI and orchestrator obtain the backend through the factory rather than constructing one.

**Why.** The file is invisible plumbing — a user communicates with workers through the tool, not by editing transport files — so the durable transcript's *location* should never appear in a CLI flag, a handle, or a picker. Hiding it behind an id gives one naming scheme across every surface. Putting the backend behind a seam selected by config (rather than hardcoding the file) means a project chooses its storage strategy once, in a committed file every agent and headless/CI run reads — distinct from the gitignored, per-machine `.local.env` — and git/cloud backends can later be added as adapters without touching callers. The factory is the single place mapping a backend id to an implementation, and validating the session id at the store boundary keeps path-traversal concerns in one place rather than at every caller.

---

## CLI host adapter

**What it does.** A thin CLI adapter (`src/cli/`) hosts a session from the terminal. Invoked as `<planner|worker> [id] [--session <id>]` (via `npm run session`), it joins a channel in that role and bridges I/O: each stdin line is sent as a `text` message, and messages received from the channel are written to stdout. With `--session <id>` it opens that session through the `SessionStore` (a shared `FileChannel` behind the scenes), so two processes naming the same session share one channel; without it, an in-process `InMemoryChannel`. Adding `--replay` attaches to an existing session and replays its transcript before streaming live — so the session CLI doubles as an interactive window onto a running session, where the user's typed lines are sent as attributed turns. With `--auto` the process runs an automated worker (see below) that responds to messages programmatically instead of bridging a terminal. At startup the adapter loads `.local.env` into the environment (machine-specific config such as `CLAUDE_BIN`), so values a spawned worker needs are present regardless of how the process was launched. A missing or invalid role is rejected with a usage message and a non-zero exit. The terminal bridging (`hostSession`) is separate from the core and takes an injected `Channel` — selecting the channel needs no adapter change.

**Why.** Adapters are how the host-agnostic design reaches a concrete host: the core never imports terminal APIs — only the adapter does. The CLI runs via Node's native TypeScript execution (`node src/cli/main.ts`, Node ≥ 23.6), avoiding a build step while the project is small. Because Node runs TypeScript in *strip-only* mode, the project enables `erasableSyntaxOnly` so only type-erasable syntax is used (no parameter properties, enums, or namespaces) and `tsc` flags violations before they reach the runtime. If broad Node-version compatibility or distribution later matters, a minimum-version check or a build step is the lever (deferred).

---

## Orchestrator — worker supervision

**What it does.** `spawnWorker` (`src/orchestrator/`) launches a worker bound to a session (by id, resolved through the `SessionStore`) and returns a handle that reports lifecycle state (`running` → `exited`), can `stop()` the worker, notifies `onExit` listeners, and exposes the orchestrator's own `Participant` (planner role) on that session's channel. The default launcher spawns the worker CLI as a Node child process in automated (`--auto`) mode (`worker <id> --session <id> --auto`), with stdin piped and left open (so the worker stays alive until stopped) and stdout/stderr inherited; the launcher is injectable so the supervisor is unit-tested without spawning a real process. When the worker exits, the orchestrator's channel participant is closed, but the session log — the durable transcript — persists.

**Why.** This is the first component that makes the tool an *orchestrator* rather than two manually-launched peers: it owns the worker's lifecycle. Process life and record life are deliberately decoupled — stopping a worker ends the process while its transcript survives for later inspection. Messaging is reused unchanged from the session-log channel; this layer adds only spawning and supervision, so the seam keeps the orchestrator ignorant of how messages physically travel.

---

## Automated worker

**What it does.** `runWorker` (`src/worker/`) joins a session as a worker and replies to each message it receives from another participant, using a replaceable async `Respond` behavior. The shipped `Respond` is `createClaudeCodeResponder`: it spawns a headless Claude Code agent — `claude -p "<task>" --output-format json --permission-mode acceptEdits` — in a per-worker temp workspace, parses the `.result`, and replies with it. The agent runs on the user's logged-in Claude Code subscription (no API key); the `claude` binary is resolved at spawn time via `resolveClaudeBin()` (`CLAUDE_BIN` if set, else `claude`/`claude.exe` from PATH). The spawn step is injectable, so the round-trip is unit-tested with a fake and CI never invokes the real `claude`; a trivial `acknowledge` responder also exists for transport-only tests. The session CLI runs a worker via `--auto`, and the orchestrator spawns its workers in `--auto` mode, so spawning a worker, sending it a task, and receiving its Claude Code result is a complete coordination round-trip — observable by attaching a `--replay` window to the same session.

**Why.** Coordination needs the worker to *respond*, not merely echo. Keeping the agent behind a single replaceable `Respond` seam meant the transport, lifecycle, and attach were proven with a stub first, then the real Claude Code agent dropped in behind the same seam without touching them — and the seam is where a different agent implementation could attach later. Spawning the `claude` CLI (rather than embedding the Agent SDK) is what runs the agent on the user's subscription: the SDK is documented for API-key auth, which would be separate billing. `CLAUDE_BIN` exists because a spawned subprocess does not always inherit the PATH an interactive shell has — a binary the user can run in their terminal may still be unreachable from the worker. Replies go only to others' messages, so the round-trip does not loop.

---

## Engaging with a worker

**What it does.** `attachInvitation` (`src/orchestrator/`) turns a spawned worker's handle into what a user needs to engage: the worker id, its session id, and the exact `--session <id> --replay` command to open a window onto that session. The orchestrator surfaces this; the user opens the window when they choose, joins as a planner (co-prompter), sees the conversation so far, and can give feedback or corrections that the worker receives as attributed turns.

**Why.** The user's window is just another participant attaching through the channel, so "opening it" is surfacing an attach handle — robust and cross-platform — not new plumbing. Automatically opening a *richer* surface (a graphical Markdown/Mermaid window) is the job of that surface (tracked separately), not a fragile terminal-spawn here.

---

## VS Code session view (extension)

**What it does.** A VS Code extension (`extension/`, an npm-workspaces package bundled with esbuild) contributes the command *Mjolnirsoft: Open Session View*. It lists the workspace's sessions by id (`SessionStore.list()`) in a quick-pick — no file dialog — and opens a webview panel attached to the chosen session. The extension host joins that session as a `planner` participant through the `SessionStore` (`replay: true`), so the panel replays the transcript and then streams live; each message is rendered host-side to HTML (`markdown-it`, with `mermaid` code fences emitted as `<pre class="mermaid">`) and posted to the webview, where a bundled script runs `mermaid` to draw diagrams. The panel has a multi-line composer: a send posts the whole text as one `text` message and echoes the sent turn locally (the channel does not deliver a participant its own messages). Closing the panel leaves the session. With a Claude Code worker running on the same session, a task typed into the composer reaches the worker and its result renders live — the end-to-end objective, verified in the plugin.

**Why.** This is the rich counterpart to the terminal CLI window, built VS Code-first because that is where the work happens. It is a host adapter: the webview is pure presentation and the extension host bridges a `Channel`, so the core is untouched and the panel is just another participant attaching to a session — agnostic to whether a human or the orchestrator started the worker on it. The composer sends a whole message at once because the line-per-message limit is a CLI-adapter artifact, not a property of the session. It is its own workspace package because a VS Code manifest and bundling cannot share the root package — and esbuild here is the project's first build step (the headless code still runs build-free on Node). The webview CSP allows `'unsafe-eval'` (Mermaid uses `new Function`) and `'unsafe-inline'` styles (Mermaid injects SVG styling), scoped to our own content inside VS Code's already-sandboxed webview. The Markdown→HTML logic is unit-tested headlessly; the live attach + compose/send is verified manually by launching the extension (F5, or sideloaded into a window already open on the repo).

---

_The objective is met end-to-end: a headless Claude Code worker runs on a named session, and a user opens that session in the VS Code view, sends it a task from the composer, and watches the agent's result render live. The next step under the graphical-window feature (#25) is starting a worker session from the view itself (#36), so the orchestrator drives the spawn rather than a hand-started terminal worker._
