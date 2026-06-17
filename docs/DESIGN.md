# Mjolnirsoft Design Record

This document describes **what the project currently does and why** — shipped reality, not aspiration. Proposed and in-progress design lives in open GitHub issues ("design candidates"); language only lands here once the issue that introduced it has closed. See *Design Documentation* in `CLAUDE.md` for the methodology.

Organised by subsystem. When a component does not yet exist, it does not yet appear here.

---

## Project foundation & tooling

**What it does.** The repository is a TypeScript/Node project. Tests run on [vitest](https://vitest.dev) via `npm test`; `npm run typecheck` runs `tsc --noEmit`. A GitHub Actions workflow (`.github/workflows/ci.yml`) runs the typecheck and the test suite on every push and pull request. Machine-specific configuration is kept out of source via the gitignored `.local.env` convention. First-run setup is automated by `./setup.sh`, which validates that Node and npm are present, installs dependencies, and creates `.local.env` from the checked-in `.local.env.example` template.

**Why.** The orchestration tooling coordinates Claude Code sessions; Claude Code is itself a Node CLI and the Claude Agent SDK ships for TypeScript, so building in the same ecosystem minimises impedance — and the dominant future host-integration surface (VS Code extensions) is TypeScript regardless. vitest was chosen for native TypeScript execution without a separate compile step. CI runs the suite on every push because the project's testing discipline requires tests to pass in CI before an issue closes; wiring it once makes that enforceable rather than aspirational. `setup.sh` exists so a fresh checkout fails fast with actionable guidance when a dependency is missing, rather than surfacing cryptic downstream errors.

---

## Orchestration core — shared channel

**What it does.** The headless core (`src/core/`) defines the coordination seam. A `Channel` lets participants join under a unique id in a `Role` (`planner` or `worker`) and exchange typed `Message`s; a participant's handler receives every message sent by *other* participants. `InMemoryChannel` is an in-process implementation that delivers messages synchronously and never echoes a message back to its sender. The core has no host, transport, or external I/O. The `Message` shape is deliberately minimal (`from`, `type`, optional `payload`) and expected to evolve as coordination needs are pinned down.

**Why.** The architecture treats the channel as the single seam between the orchestration engine and any host (terminal, IDE, CI), the way LSP/MCP separate a server from its clients. Building the core headless with an in-memory channel first establishes and tests that seam before committing to a wire transport — the transport decision is deferred to a later story so it is made once the surrounding shape is known, rather than guessed up front.

---

## CLI host adapter

**What it does.** A thin CLI adapter (`src/cli/`) hosts a session from the terminal. Invoked as `<planner|worker> [id]` (via `npm run session`), it joins a channel in that role and bridges I/O: each stdin line is sent as a `text` message, and messages received from the channel are written to stdout. A missing or invalid role is rejected with a usage message and a non-zero exit. The terminal bridging (`hostSession`) is separate from the core and takes an injected `Channel`, so a transport can replace the in-memory one without touching the adapter. It runs via Node's native TypeScript execution (`node src/cli/main.ts`), which requires Node ≥ 23.6.

**Why.** Adapters are how the host-agnostic design reaches a concrete host: the core never imports terminal APIs — only the adapter does. Building the adapter against the in-memory channel first proves the host-bridging in isolation, before a transport lets two CLI processes share one channel. Running TypeScript directly on Node avoids a build step while the project is small; if broad Node-version compatibility or distribution later matters, a minimum-version check or a build step is the lever (deferred).

---

_A cross-process transport (so two CLI sessions share one channel) and the end-to-end coordination it enables are proposed design candidates tracked under Feature #6, and will be recorded here as they ship._
