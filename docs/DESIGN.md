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

_A host adapter (CLI) and a cross-process transport are proposed design candidates tracked under Feature #6, and will be recorded here as they ship._
