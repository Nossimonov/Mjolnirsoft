# Agent Norms — Mjolnirsoft

Read this file before starting any task. It lists the rules that apply to every agent in this repository, then points you to your role's norms file. Read your role file and follow it too.

---

## Shell Tool Usage on Windows

This project runs on Windows. The Bash tool is available and preferred over PowerShell for readability. The Bash tool starts in the project root — no `cd` needed. When you reference absolute paths, use MSYS2/Git Bash mount-style — drive letter lowercased and prefixed with `/`:

```bash
git status
cat /c/Users/<you>/development/Mjolnirsoft/some/path.txt
```

**Never use backslash paths in the Bash tool** (`c:\Users\...` fails). Backslashes are only valid in PowerShell tool calls. Reserve the PowerShell tool for Windows-only operations with no Bash equivalent (registry, PS-native cmdlets).

---

## Anchor-Extend-Test

For any problem where the full solution is not immediately apparent, do not attempt to reason through the entire solution before acting. Extended pre-computation in reasoning is slow and error-prone. Instead loop:

1. **Anchor** — identify what is externally confirmed: a passing test, a written-and-verified value, a hard constraint from the spec. This is your only ground truth. Beliefs and unverified derivations do not count, however confident.
2. **Extend** — derive the smallest next step consistent with the anchor. Do not plan further than one step.
3. **Test** — run it. The result becomes your new anchor. Repeat.

**Underdetermination:** when several next steps are equally consistent with the anchor, do not analyse to resolve the ambiguity — the anchor lacks the information to, and more reasoning cannot supply it. Pick the most natural option and test; the feedback resolves it. The tell is noticing yourself weighing options *before acting on any*. That is the moment to stop analysing and pick one.

**Irreversible actions** (deleting files, dropping data, force-pushing, publishing): the loop only works if you can recover from a wrong answer. State the intended action and get explicit confirmation first.

---

## Build & Environment Rules

All build/setup must be **environment-agnostic**. No hardcoded paths, tool locations, or developer-machine assumptions in committed scripts.

- Machine-specific values (tool paths, SDK locations, secrets) live in a **gitignored local config** (e.g. `.local.env`).
- A **setup script** detects or prompts for those values and writes the local config on first run; it validates required dependencies and gives actionable guidance when something is missing.
- The first-run entry point is **`./setup.sh`** (run in Git Bash on Windows). It validates Node/npm, installs dependencies, and creates `.local.env` from the checked-in `.local.env.example` template.
- When you change any build/setup step, update `setup.sh` (and `.local.env.example`) too so the dependency or path stays covered.

---

## First-Time Integration Verification

When this codebase implements a pattern with an external framework or SDK **for the first time** (an MCP server, a CLI framework, a cloud API, any third-party library), verify the **complete required setup** against that framework's documentation or source before committing. Do not rely on recall.

The trigger is: *this codebase has not done this before.* Memory of "what the integration looks like" is unreliable — API details vary by version, and required boilerplate (entry points, init sequences, registration steps, mandatory base classes) can be partially or wholly forgotten. Verify every required file exists, every identifier exists in the version this project uses, and the correct base/context is targeted. If documentation is unavailable, flag each unverified assumption explicitly before committing.

---

## Testing Discipline

**Every feature gets at least one automated test covering its acceptance criteria, and tests must pass in CI before the issue is closed.** Map each acceptance criterion to at least one assertion.

Run every test suite whose inputs your change touches and confirm they pass before handing off or committing. A previously-passing suite that fails after your change is a regression — fix it, don't work around it.

The test runner is Vitest (`npm test`). From a worktree, invoke vitest via the main repo's `node_modules`:

```bash
node /path/to/repo/node_modules/vitest/vitest.mjs run
```

---

## Role-Norms Directory

Each spawned role has a norms file with project-specific guidance. Find your role below and read it before starting your task.

| Role | Norms file | Covers |
|------|-----------|--------|
| Orchestrator | [`docs/agents/orchestrator.md`](docs/agents/orchestrator.md) | Branch/PR conventions; bookkeeping protocol: issue discipline, commit-phase walk, GitHub conventions, design documentation, capturing deferred scope |
| Executor | [`docs/agents/executor.md`](docs/agents/executor.md) | Code-change norms: no speculative design in code artifacts |
| Evaluator | *(no project-specific norms yet — the extension's evaluator role layer is sufficient)* | — |
| Investigator | [`docs/agents/investigator.md`](docs/agents/investigator.md) | Source-citation discipline; read-only constraint; what counts as a valid cited finding |
