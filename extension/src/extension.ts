import * as vscode from 'vscode';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Channel, Participant, Message } from '../../src/core/channel.ts';
import { SessionStore } from '../../src/core/session-store.ts';
import { WorktreeManager, currentRemoteBase } from '../../src/core/worktree.ts';
import { loadLocalEnv } from '../../src/cli/load-local-env.ts';
import { loadProjectConfig } from '../../src/core/project-config.ts';
import { contextWindowFor } from '../../src/core/model-context-window.ts';
import { runExecutor } from '../../src/executor/executor-runtime.ts';
import { createClaudeCodeResponder, resolveClaudeBin, addUsage, ZERO_USAGE, USAGE_MESSAGE, claudeSessionIdFor, permissionPolicyFor, weightedUsage, type Usage } from '../../src/executor/claude-code-responder.ts';
import { createReasoningStream, type ReasoningStream } from '../../src/executor/reasoning-stream.ts';
import { createUsageMeter, type UsageMeter } from '../../src/executor/usage-meter.ts';
import { createDelegationHost } from '../../src/executor/delegation-host.ts';
import type { DelegateWiring } from '../../src/executor/delegation.ts';
import { composeAgentInstructions, isAgentRole, type AgentRole } from '../../src/core/agent-instructions.ts';
import { recordLearnedRule } from '../../src/core/learned-permissions.ts';
import {
  INTERACTION_DECISION,
  INTERACTION_REQUEST,
  type InteractionRequest,
} from '../../src/core/interaction.ts';
import { DELEGATION_REQUEST, DELEGATION_RESPONSE } from '../../src/core/delegation-protocol.ts';
import {
  COMPACTION_REQUEST,
  COMPACTION_RESPONSE,
  COMPACTION_GENERATION,
  type CompactionRequest,
  type CompactionResponse,
} from '../../src/core/compaction-protocol.ts';
import { createIdleCompactionTrigger, type IdleCompactionTrigger } from '../../src/executor/idle-compaction.ts';
import { inspectSession, orchestratorSessionKey } from '../../src/executor/session-inspector.ts';
import { projectDelegationLedger } from '../../src/executor/delegation-ledger.ts';
import { REASONING_DIGEST } from '../../src/executor/reasoning-digest.ts';
import { renderMessage, renderInteractionRequest, renderReasoningDigestLive, linkifySessionIds } from './render.ts';

// The MCP server is named `perm` in the generated config, so its `approve` tool
// is addressed as `mcp__perm__approve` to `--permission-prompt-tool`.
const PERMISSION_PROMPT_TOOL = 'mcp__perm__approve';

// Quick-pick sentinel offered above the session list; the input validation for
// session names forbids spaces/'+', so this can never collide with a real id.
const START_NEW_SESSION = '+ Start a new executor session…';

/**
 * Tracks which session panels are open so they can be restored after a window
 * reload (#128). `track` is called when a panel opens, `untrack` when it closes.
 */
interface PanelTracker {
  track(id: string): void;
  untrack(id: string): void;
}

// The single orchestrator's fixed session id (#123). There is only ever one
// orchestrator per workspace, so it's opened directly under this id — no name prompt —
// and re-opening attaches to it (if live) or resumes its one conversation.
const ORCHESTRATOR_ID = 'orchestrator';

// Prompt injected by the idle-compaction trigger (#167). Sent as a planner-attributed
// 'text' message when the orchestrator has been idle long enough that the prompt cache
// is about to expire, instructing it to write a self-hand-off and call mcp__compact__request.
const IDLE_COMPACTION_PROMPT =
  'Your session has been idle long enough that the prompt cache is about to expire. ' +
  'To avoid an expensive full-context cache miss on the next turn, write a comprehensive ' +
  'self-hand-off now — include the current goal, any active delegates and their status, ' +
  'recent integrations (issue/PR ids), and pointers to the sources you will need next — ' +
  'then call mcp__compact__request. This is a proactive idle self-compaction (#167); ' +
  'act on this immediately and do not defer.';

// USAGE_MESSAGE (#116) is the channel message type carrying one turn's usage. It's
// posted per turn as the turn completes (not on close), so a long-lived session's
// usage lands in the durable log continuously and survives teardown (#126), and each
// turn's "think" is recoverable for post-mortem. The payload is that turn's delta,
// not a running total; a live panel shows the running tally from its meter, a replayed
// panel sums these. Defined in the responder (which short-circuits it so an agent
// never feeds its own usage back to itself) and imported here.

/** Compact a token count: 1234 → "1.2K", 1_234_567 → "1.2M". */
function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** The header token tally (#116/#133): grand total, cost-weighted equivalent, and output count. */
function formatUsage(u: Usage): string {
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  return `${formatTokens(total)} tok · ${formatTokens(weightedUsage(u))} wt · ${formatTokens(u.outputTokens)} out`;
}

// inspectSession is imported from src/executor/session-inspector.ts (#165/#126):
// reads role, usage, and compaction generation from the session JSONL in one pass.

/**
 * What a live, in-host session exposes for *attach-on-demand* (#114). A session
 * the extension started (an orchestrator or executor command) — and every executor
 * delegate an orchestrator spawns — registers here while it runs, so when the
 * architect opens it from the front door the panel attaches to the *live* wiring
 * (its reasoning stream, its agent seat, a role-apt label) rather than a viewer-
 * only replay. A delegate is deliberately not auto-opened — the architect attaches
 * when they choose ("each session's info in its own tab"); this registry is how
 * that attach finds the live session.
 */
interface LiveSession {
  /** The agent participant whose reply settles a turn (and whose digest is live). */
  readonly agentId: string;
  /** This session's live reasoning stream, to forward to a panel that attaches. */
  readonly reasoning: ReasoningStream;
  /** The session's role, for an apt "working" label in an attached panel. */
  readonly role: AgentRole;
  /** The model this session's agent runs on (#119), for the attached panel's header. */
  readonly model?: string;
  /** This session's token meter (#116) — running total incl. rolled-up sub-agents — for the header tally. */
  readonly meter: UsageMeter;
}
type LiveSessions = Map<string, LiveSession>;

export function activate(context: vscode.ExtensionContext): void {
  // Sessions started in-host (commands + every executor delegate) register here
  // while live, so the front door can attach to the live wiring on demand (#114).
  const liveSessions: LiveSessions = new Map();

  // Best-effort: a prior window reload tears the host down without running a session's
  // cleanup, which can leave stale `git worktree` admin entries behind. Prune them on
  // activate so the worktree list stays tidy; the worktree *directories* themselves are
  // kept — they're how an interrupted session resumes (#126). No repo/git → ignore.
  // Active-delegation worktrees are excluded from pruning (#204): read the orchestrator's
  // delegation ledger and lock those worktrees before calling git worktree prune, so a
  // compaction restart cannot unregister an in-flight delegate's worktree.
  const startupFolder = vscode.workspace.workspaceFolders?.[0];
  if (startupFolder) {
    try {
      const repoDir = startupFolder.uri.fsPath;
      const activeDelegateIds = new Set(
        projectDelegationLedger(storeFor(startupFolder).logPath(ORCHESTRATOR_ID))
          .filter((e) => e.active)
          .map((e) => e.delegateId),
      );
      new WorktreeManager({ repoDir }).prune(activeDelegateIds.size > 0 ? activeDelegateIds : undefined);
    } catch {
      /* not a git repo, or git absent — nothing to prune */
    }
  }

  // Panel persistence (#128): track which sessions have open panels in globalState so
  // they can be restored after a window reload. `track` when a panel opens,
  // `untrack` when it closes — the Set survives reloads via VS Code's storage.
  const OPEN_PANELS_KEY = 'mjolnirsoft.openPanels';
  const openPanelIds = new Set<string>(context.globalState.get<string[]>(OPEN_PANELS_KEY) ?? []);
  const persistPanels = (): void => { void context.globalState.update(OPEN_PANELS_KEY, [...openPanelIds]); };
  const panelTracker: PanelTracker = {
    track(id: string): void { openPanelIds.add(id); persistPanels(); },
    untrack(id: string): void { openPanelIds.delete(id); persistPanels(); },
  };

  // Restore panels that were open before the reload (#128). Each session resumes
  // via #126 if its worktree exists; otherwise it replays as viewer-only. The
  // orchestrator always resumes (no worktree — its resume path is always live).
  if (startupFolder) {
    const restoreStore = storeFor(startupFolder);
    const allSessions = restoreStore.list();
    const repoDir = startupFolder.uri.fsPath;
    // Construct WorktreeManager once for the whole restore loop so assertGitRepo
    // runs a single git subprocess rather than one per session.
    let wt: WorktreeManager | undefined;
    try { wt = new WorktreeManager({ repoDir }); } catch { /* not a git repo */ }
    for (const sessionId of [...openPanelIds]) {
      if (sessionId === ORCHESTRATOR_ID) {
        openOrchestrator(context, startupFolder, restoreStore, liveSessions, undefined, panelTracker);
        continue;
      }
      if (!allSessions.includes(sessionId)) {
        // Session no longer in the store — drop it from tracking.
        panelTracker.untrack(sessionId);
        continue;
      }
      if (wt?.exists(sessionId)) {
        // Check whether the orchestrator's rewire loop already provisioned this
        // delegate — if so, attach to the live session rather than double-launching (#128).
        const live = liveSessions.get(sessionId);
        if (live) {
          openSessionPanel(context, restoreStore, sessionId, repoDir, liveSessions, {
            executorAttached: true,
            executorId: live.agentId,
            reasoning: live.reasoning,
            agentLabel: live.role,
            model: live.model,
            meter: live.meter,
            onOpen: () => panelTracker.track(sessionId),
            onDispose: () => panelTracker.untrack(sessionId),
            openSession: (id) => openSessionById(id, context, startupFolder, restoreStore, liveSessions, panelTracker),
          });
        } else {
          const { role } = inspectSession(restoreStore.logPath(sessionId), sessionId);
          launchSession(context, startupFolder, restoreStore, sessionId, role ?? 'executor', liveSessions, true, undefined, panelTracker);
        }
      } else {
        // Ended cleanly (or no git repo) — restore as a viewer-only replay (already tracked).
        openSessionPanel(context, restoreStore, sessionId, repoDir, liveSessions, {
          onDispose: () => panelTracker.untrack(sessionId),
          openSession: (id) => openSessionById(id, context, startupFolder, restoreStore, liveSessions, panelTracker),
        });
      }
    }
  }

  const openView = vscode.commands.registerCommand('mjolnirsoft.openSessionView', async () => {
    const folder = requireFolder();
    if (!folder) return;
    const store = storeFor(folder);

    // List-or-create front door: with no sessions, skip the dead-end message and
    // take the newcomer straight into starting an executor.
    const sessions = store.list();
    if (sessions.length === 0) {
      await startSession(context, folder, store, 'executor', liveSessions, panelTracker);
      return;
    }
    const pick = await vscode.window.showQuickPick([START_NEW_SESSION, ...sessions], {
      title: 'Open a Mjolnirsoft session',
      placeHolder: 'Pick a session to open, or start a new executor',
    });
    if (!pick) return;
    if (pick === START_NEW_SESSION) {
      await startSession(context, folder, store, 'executor', liveSessions, panelTracker);
      return;
    }
    // Dispatch through the shared open-by-id path (#186): handles orchestrator,
    // live attach, interrupted resume, and ended viewer all in one place.
    openSessionById(pick, context, folder, store, liveSessions, panelTracker);
  });

  const startExecutor = vscode.commands.registerCommand('mjolnirsoft.startExecutorSession', async () => {
    const folder = requireFolder();
    if (!folder) return;
    await startSession(context, folder, storeFor(folder), 'executor', liveSessions, panelTracker);
  });

  const startOrchestrator = vscode.commands.registerCommand('mjolnirsoft.startOrchestratorSession', () => {
    const folder = requireFolder();
    if (!folder) return;
    openOrchestrator(context, folder, storeFor(folder), liveSessions, undefined, panelTracker);
  });

  context.subscriptions.push(openView, startExecutor, startOrchestrator);
}

/** A live in-host session's wiring, returned by {@link provisionSession}. */
interface ProvisionedSession {
  /** The agent participant on the session channel (`${sessionId}-executor`). */
  readonly agentId: string;
  /** The session's live reasoning stream (forward it to a panel that attaches). */
  readonly reasoning: ReasoningStream;
  /** The branch holding the session's work, for the developer to review; undefined for the worktree-less orchestrator (#123). */
  readonly branch?: string;
  /** The model the agent runs on (#119); undefined inherits the user's default. */
  readonly model?: string;
  /** This session's token meter (#116): its own usage plus every sub-agent it spawned. */
  readonly meter: UsageMeter;
  /** Tear down the agent + delegation host + MCP config, capture and drop the workspace. Returns whether anything was committed. Does NOT close the channel (the caller owns it). */
  close(): boolean;
  /**
   * Tear down the orchestrator's own resources for a compaction restart (#204):
   * closes the agent, usage seat, and MCP config, but calls
   * {@link DelegationHost.releaseForCompaction} instead of {@link DelegationHost.close},
   * so live delegate sessions and their worktrees survive. The new generation
   * re-establishes delegate bridges via the rewire scan. Only meaningful for the
   * orchestrator (executor sessions use close() only).
   */
  closeForCompaction(): void;
}

/**
 * Provision a full in-host agent session on `channel` — **everything but the
 * panel** (#114): an isolated git worktree on its own branch, the per-session MCP
 * config (permission + delegation servers), the live reasoning stream, the
 * `claude`-backed responder composing the role's instructions, and the in-host
 * delegation host that answers its spawn/shutdown requests. Factored out of the
 * old `startExecutorSession` so three callers share one wiring: the
 * `Start Executor Session` and `Start Orchestrator Session` commands, and the
 * delegation host's **executor-delegate mode** (an orchestrator spawning an
 * executor delegate provisions one of these on the delegate's sub-channel).
 *
 * The session's own delegation host provisions *its* executor delegates by
 * recursing into this same function (a fresh worktree per delegate), and runs
 * shared-worktree critique delegates (the evaluator) on *this* session's worktree
 * — so an evaluator reviews "what is". Each provisioned session registers in
 * `liveSessions` while it runs so the architect can attach to it on demand; it
 * unregisters on close.
 */
function provisionSession(args: {
  context: vscode.ExtensionContext;
  folder: vscode.WorkspaceFolder;
  store: SessionStore;
  sessionId: string;
  role: AgentRole;
  channel: Channel;
  liveSessions: LiveSessions;
  /** Roll this session's token usage up into the spawner's meter (#116); omit for a top-level session. */
  onUsage?: (turn: Usage) => void;
}): ProvisionedSession {
  const { context, folder, store, sessionId, role, channel, liveSessions } = args;
  const repoDir = folder.uri.fsPath;
  const model = modelForRole(role); // the per-role model this agent runs on (#119)
  const meter = createUsageMeter(args.onUsage); // accumulate token usage; bubble to the spawner (#116)

  // Where the agent works. An executor (and any worktree role) gets an isolated git
  // worktree so it edits the repo without touching the developer's working tree; the
  // **orchestrator** coordinates out of the *main repo* with no worktree (#123) — it
  // plans/delegates/relays and (by the architect's decision) writes the repo like the
  // architect's own session, so a separate branch is only friction. `workspace`
  // abstracts the two: a real worktree, or the bare repo with no-op capture/teardown.
  const isOrchestrator = role === 'orchestrator';
  let workspace: { path: string; branch?: string; commit(message: string): boolean; remove(): void };
  let resuming: boolean;
  // The stable claude session id (#126): for the orchestrator this is generation-indexed
  // (#165) so each compaction rotation starts a fresh claude conversation (blank context)
  // while the Mjolnir session log remains continuous. Generation 0 uses the plain id for
  // backward compatibility with pre-compaction sessions.
  let claudeSessionId: string;
  if (isOrchestrator) {
    // The singleton orchestrator always continues its one conversation: resume its
    // pinned claude session (the #126 not-found fallback covers the very first launch).
    // No worktree to create, capture, or remove; it works out of the main repo.
    resuming = true;
    workspace = { path: repoDir, commit: () => false, remove: () => {} };
    // Derive the session id from the current compaction generation (#165). Generation 0
    // is backward-compatible; generation N uses a suffix so the new conversation is blank.
    const { generation } = inspectSession(store.logPath(sessionId), sessionId);
    claudeSessionId = claudeSessionIdFor(orchestratorSessionKey(sessionId, generation));
  } else {
    // If a worktree already exists for this id, the session was interrupted by a reload
    // (a clean close removes it), so **reattach** + resume its conversation rather than
    // creating (#126). Otherwise create fresh from the freshest origin/main (not local
    // HEAD), so it starts from the latest merged code (#83). A create failure (e.g. the
    // branch already exists) throws before anything else is allocated, so it propagates
    // cleanly to the caller (the command surfaces it; the host answers the spawn with an error).
    const worktrees = new WorktreeManager({ repoDir });
    resuming = worktrees.exists(sessionId);
    workspace = resuming
      ? worktrees.open(sessionId)
      : new WorktreeManager({ repoDir, base: currentRemoteBase(repoDir) }).create(sessionId);
    claudeSessionId = claudeSessionIdFor(sessionId); // stable, so a reload can --resume (#126)
  }
  // Seed the meter with this session's own usage so far, so a resumed header continues
  // its tally instead of resetting — the durable per-turn log holds it (#116/#126).
  // Use lifetimeUsage (all-time total) for the header so the tally never resets on
  // compaction (#9).
  const seedUsage = resuming ? inspectSession(store.logPath(sessionId), sessionId) : undefined;
  if (seedUsage) meter.add(seedUsage.lifetimeUsage);
  // Context-size snapshot for the orchestrator (#9): the raw prompt-side token count
  // from the most recently completed turn (inputTokens + cacheReadTokens +
  // cacheCreationTokens). Seeded from the log on reload so the first post-reload turn
  // shows a meaningful figure rather than 0; undefined/zero for a fresh start or
  // immediately after a compaction (new blank conversation, nothing in context yet).
  const seedLast = isOrchestrator ? seedUsage?.lastTurnUsage : undefined;
  let contextSnapshot = seedLast
    ? seedLast.inputTokens + seedLast.cacheReadTokens + seedLast.cacheCreationTokens
    : 0;

  // Once the worktree exists, a later failure must not leave it (or a written MCP
  // config) orphaned — track what's been allocated and unwind on a partial failure.
  let mcpConfigPath: string | undefined;
  let usageSeat: Participant | undefined;
  try {
    // MCP-backed capabilities: one per-session config wiring Claude to both bundled
    // servers — the permission server for escalation (#66/#70) and the delegation
    // server for spawning delegates (#93) — each bridging over this session's channel.
    const permParticipantId = `${sessionId}-perms`;
    const delegateParticipantId = `${sessionId}-delegate`;
    // The compaction MCP server is wired only for the orchestrator (#165).
    const compactParticipantId = isOrchestrator ? `${sessionId}-compact` : undefined;
    mcpConfigPath = writeExecutorMcpConfig(
      context,
      store.logPath(sessionId),
      permParticipantId,
      delegateParticipantId,
      repoDir,
      workspace.path,
      compactParticipantId,
    );

    // The live, ephemeral path for the agent's reasoning (#108): the responder pushes
    // block-level digest snapshots here as it streams, and a panel that attaches
    // subscribes to forward them. Off the channel — never logged or replayed.
    const reasoning = createReasoningStream();

    // Durable per-turn usage (#116): a passive seat that posts this session's own
    // usage to the channel one turn at a time, as each turn completes. Persisting
    // per-turn (rather than a single total on close) keeps a long-lived session's
    // accounting in the log continuously, survives teardown (#126), and preserves
    // each turn's cost individually for "which operation thought hardest" analysis.
    // `meter.add` still accumulates the running total (and bubbles to the spawner);
    // this just also writes the delta down. Delegates log their own turns on their
    // own channels, so we record only this session's own responder turns here.
    usageSeat = channel.join(`${sessionId}-usage`, role, () => {});
    const recordTurnUsage = (turn: Usage): void => {
      meter.add(turn);
      // Update the context snapshot: raw prompt-side tokens from this turn = how much
      // of the context window Claude just consumed. Next turn reads this via getContextNote.
      contextSnapshot = turn.inputTokens + turn.cacheReadTokens + turn.cacheCreationTokens;
      usageSeat?.send({ type: USAGE_MESSAGE, payload: turn });
    };

    // Context-size note injected into each orchestrator turn (#165/#180): the prompt-side
    // raw token count from the most recently completed turn tells the orchestrator how
    // much of the context window is currently occupied, so it can self-judge whether
    // to compact (#9). Raw tokens (not weighted) are the right unit — the context
    // window limit is in raw tokens, not weighted-cost tokens.
    const compactionPercent = isOrchestrator
      ? loadProjectConfig(join(repoDir, 'mjolnir.config.json')).compaction.thresholdContextPercent
      : undefined;
    const getContextNote = compactionPercent !== undefined
      ? (): string => {
          const tokens = contextSnapshot; // raw prompt tokens = current context window occupancy
          const windowSize = contextWindowFor(model);
          const thresholdTokens = Math.round(windowSize * compactionPercent);
          const pct = Math.round(compactionPercent * 100);
          const aboveThreshold = tokens > thresholdTokens;
          const verdict = aboveThreshold
            ? `⚠ PAST THRESHOLD — after integrating the current task, write a self-hand-off and call mcp__compact__request.`
            : `Below threshold — continue.`;
          return `[Context size: ${formatTokens(tokens)} tokens (threshold ${formatTokens(thresholdTokens)} tokens — ${pct}% of ${formatTokens(windowSize)} window). ${verdict}]`;
        }
      : undefined;

    // Run the agent in-process: it joins the session in its role and answers each
    // message by running a headless Claude Code agent with the worktree as workspace.
    const agentId = `${sessionId}-executor`;
    const agent = runExecutor(
      channel,
      agentId,
      createClaudeCodeResponder({
        workdir: workspace.path,
        appendSystemPrompt: composeAgentInstructions(role),
        claudeSessionId, // stable id (#126/#165): generation-indexed for the orchestrator
        resume: resuming, // first turn --resume the interrupted conversation rather than create (#126)
        permissionPromptTool: PERMISSION_PROMPT_TOOL,
        mcpConfigPath,
        settings: permissionPolicyFor(role), // the orchestrator may push + open PRs (#137); executors can't
        model,
        onReasoningChange: reasoning.emit,
        onUsage: recordTurnUsage, // accumulate the running total *and* log this turn (#116)
        getContextNote, // inject context-size note for the orchestrator (#165)
      }),
      role,
    );

    // Host the live side of delegation (#93/#114): answer this agent's spawn/shutdown
    // requests. An `executor` spawn provisions a *full executor delegate* — a fresh
    // worktree + this same wiring on the delegate's own sub-channel (a real,
    // attachable session) — while a critique role (the evaluator) runs a `claude`
    // responder on *this* session's worktree so it reviews "what is". Either way the
    // delegate's distilled report bridges up onto this session, attributed (#86).
    const configPath = mcpConfigPath;
    const delegationHost = createDelegationHost({
      spawnerChannel: channel,
      spawnerId: agentId,
      spawnerRole: role,
      hostId: `${sessionId}-delegation-host`,
      openSubChannel: (id) => store.open(id),
      provisionExecutorDelegate: (delegateRole, id, sub, resuming): DelegateWiring => {
        const child = provisionSession({ context, folder, store, sessionId: id, role: delegateRole, channel: sub, liveSessions, onUsage: meter.add });
        // Surface the delegate so the architect can find it: it's a real, attachable
        // session with no auto-panel (#114), so tell them it exists, on which branch,
        // and that it's opened on demand from the session view.
        void vscode.window.showInformationMessage(
          `Executor delegate “${id}” ${resuming ? 'resumed' : 'started'} on branch ${child.branch} — ` +
            `open it from “Mjolnirsoft: Open Session View” to watch or answer it.`,
        );
        return { reportFrom: child.agentId, close: () => void child.close() };
      },
      createResponder: (delegateRole) =>
        createClaudeCodeResponder({
          workdir: workspace.path,
          appendSystemPrompt: composeAgentInstructions(delegateRole),
          settings: permissionPolicyFor(delegateRole), // a critique delegate gets its role's policy (#137)
          model: modelForRole(delegateRole),
          onUsage: meter.add, // a shared-worktree critique delegate's usage rolls into this session (#116)
          // claudeSessionId defaults to a fresh UUID — a delegate's *channel* id is
          // not a valid `--session-id`, and a critique delegate is short-lived anyway.
        }),
    });

    // Re-establish bridges for isolated-worktree delegates that survived a reload
    // (#128). Only applies when the orchestrator resumes. The delegation ledger
    // returns exactly the orchestrator's own direct delegates (not grandchildren) by
    // reading the actual delegation protocol messages from the orchestrator's log —
    // semantically correct and no fragile string matching. A delegate with
    // `active: false` was explicitly shut down; one whose worktree is gone ended
    // cleanly (e.g. panel closed) — both are skipped. Critique roles have no
    // persistent worktree and never appear in ISOLATED_WORKTREE_ROLES, so
    // `rewireDelegate` silently skips them if they somehow appear.
    if (isOrchestrator && resuming) {
      const wt = new WorktreeManager({ repoDir });
      for (const entry of projectDelegationLedger(store.logPath(sessionId))) {
        if (!entry.active) continue; // explicitly shut down — skip
        if (!wt.exists(entry.delegateId)) continue; // worktree gone — finished
        if (!isAgentRole(entry.role)) continue;
        delegationHost.rewireDelegate(entry.role as AgentRole, entry.delegateId);
      }
    }

    liveSessions.set(sessionId, { agentId, reasoning, role, model, meter });

    return {
      agentId,
      reasoning,
      branch: workspace.branch,
      model,
      meter,
      close(): boolean {
        liveSessions.delete(sessionId);
        // Usage is already in the log per turn (#116) — nothing to flush on close; just
        // release the seat. This also means a teardown that skips close (a reload, #126)
        // loses at most the in-flight turn, not the whole session's accounting.
        usageSeat?.close();
        delegationHost.close();
        agent.close();
        rmSync(configPath, { force: true });
        // System capture: commit whatever the session changed onto its branch, then
        // drop the worktree (the branch survives for review).
        const captured = workspace.commit(`Mjolnir ${role} session ${sessionId}`);
        workspace.remove();
        return captured;
      },
      closeForCompaction(): void {
        liveSessions.delete(sessionId);
        usageSeat?.close();
        // Release the delegation host without shutting down live delegates: detaches
        // old bridge wiring so there's no double-delivery, but preserves each
        // delegate's session and worktree for the new orchestrator generation to rewire.
        delegationHost.releaseForCompaction();
        agent.close();
        rmSync(configPath, { force: true });
        workspace.commit(`Mjolnir ${role} session ${sessionId}`); // no-op for orchestrator
        workspace.remove(); // no-op for orchestrator
      },
    };
  } catch (error) {
    // Unwind the partial allocation so a failed provision leaves nothing behind:
    // release the usage seat, delete any written MCP config, remove the workspace.
    usageSeat?.close();
    if (mcpConfigPath) rmSync(mcpConfigPath, { force: true });
    workspace.remove();
    throw error;
  }
}

/**
 * Open a session by id using the same dispatch as the front-door picker (#186/#139):
 * attach to live wiring if running, resume an interrupted session, or open a viewer
 * for an ended one. Used by session-link clicks in rendered markdown so the architect
 * can navigate directly from a summary to the named session.
 */
function openSessionById(
  sessionId: string,
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  store: SessionStore,
  liveSessions: LiveSessions,
  tracker?: PanelTracker,
): void {
  if (sessionId === ORCHESTRATOR_ID) {
    openOrchestrator(context, folder, store, liveSessions, undefined, tracker);
    return;
  }
  if (!store.list().includes(sessionId)) return; // id not known — ignore stale link
  const openChild = (id: string) => openSessionById(id, context, folder, store, liveSessions, tracker);
  const live = liveSessions.get(sessionId);
  if (live) {
    openSessionPanel(context, store, sessionId, folder.uri.fsPath, liveSessions, {
      executorAttached: true,
      executorId: live.agentId,
      reasoning: live.reasoning,
      agentLabel: live.role,
      model: live.model,
      meter: live.meter,
      onOpen: () => tracker?.track(sessionId),
      onDispose: () => tracker?.untrack(sessionId),
      openSession: openChild,
    });
    return;
  }
  if (new WorktreeManager({ repoDir: folder.uri.fsPath }).exists(sessionId)) {
    const role = inspectSession(store.logPath(sessionId), sessionId).role ?? 'executor';
    launchSession(context, folder, store, sessionId, role, liveSessions, true, undefined, tracker);
    return;
  }
  openSessionPanel(context, store, sessionId, folder.uri.fsPath, liveSessions, {
    onOpen: () => tracker?.track(sessionId),
    onDispose: () => tracker?.untrack(sessionId),
    openSession: openChild,
  });
}

/**
 * Open *the* orchestrator (#123): the singleton coordinator, addressed by a fixed id
 * with no name prompt. Attach to it if it's already live in this host; otherwise launch
 * it — resuming its one conversation when it has run before. It works out of the main
 * repo with no worktree, so there's no "ended vs interrupted" distinction: re-opening
 * always continues it (the `resumed` flag here only picks the wording).
 *
 * After a compaction restart (#165), `compactionHandoff` carries the self-hand-off text
 * that the previous orchestrator wrote; it's posted as the new session's first message
 * so the fresh context picks up without loss.
 */
function openOrchestrator(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  store: SessionStore,
  liveSessions: LiveSessions,
  compactionHandoff?: string,
  tracker?: PanelTracker,
): void {
  const live = liveSessions.get(ORCHESTRATOR_ID);
  const openChild = (id: string) => openSessionById(id, context, folder, store, liveSessions, tracker);
  if (live) {
    openSessionPanel(context, store, ORCHESTRATOR_ID, folder.uri.fsPath, liveSessions, {
      executorAttached: true,
      executorId: live.agentId,
      reasoning: live.reasoning,
      agentLabel: live.role,
      model: live.model,
      meter: live.meter,
      onOpen: () => tracker?.track(ORCHESTRATOR_ID),
      onDispose: () => tracker?.untrack(ORCHESTRATOR_ID),
      openSession: openChild,
    });
    return;
  }
  launchSession(
    context,
    folder,
    store,
    ORCHESTRATOR_ID,
    'orchestrator',
    liveSessions,
    store.list().includes(ORCHESTRATOR_ID),
    compactionHandoff,
    tracker,
  );
}

/**
 * Prompt for a name, provision an agent session of `role` in its own git worktree,
 * and open its panel. Shared by the `Start Executor Session` command and the front
 * door's start-a-new path, so the start-a-session logic lives in one place (#114).
 * (The orchestrator is launched directly by {@link openOrchestrator}, not named here.)
 */
async function startSession(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  store: SessionStore,
  role: AgentRole,
  liveSessions: LiveSessions,
  tracker?: PanelTracker,
): Promise<void> {
  const sessionId = await vscode.window.showInputBox({
    title: `Start ${article(role)} ${role} session`,
    prompt: 'Name this session',
    placeHolder: role === 'orchestrator' ? 'e.g. coordinate-feature-x' : 'e.g. add-feature-x',
    validateInput: (value) =>
      /^[A-Za-z0-9_-]+$/.test(value) ? undefined : "use letters, digits, '_' or '-'",
  });
  if (!sessionId) return;

  if (store.list().includes(sessionId)) {
    void vscode.window.showErrorMessage(`Session "${sessionId}" already exists — open it instead.`);
    return;
  }

  launchSession(context, folder, store, sessionId, role, liveSessions, false, undefined, tracker);
}

/**
 * Provision an in-host agent session on its channel and open its panel (#114),
 * wiring the panel's dispose to capture-and-drop the workspace. Shared by the start
 * commands and the front door's **resume** path (#126): `provisionSession` reattaches
 * to an existing worktree (resuming the interrupted conversation) when one is present,
 * or creates a fresh one — so this same wiring serves both "start" and "resume".
 *
 * For the orchestrator after a compaction restart (#165), `compactionHandoff` is the
 * self-hand-off the previous orchestrator wrote. It's posted as the first channel
 * message so the fresh claude session's first turn answers it.
 */
function launchSession(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  store: SessionStore,
  sessionId: string,
  role: AgentRole,
  liveSessions: LiveSessions,
  resumed: boolean,
  compactionHandoff?: string,
  tracker?: PanelTracker,
): void {
  // The in-process agent shells out to `claude`; load machine-specific config
  // (CLAUDE_BIN) so it's found even when the extension host's PATH lacks it.
  loadLocalEnv(join(folder.uri.fsPath, '.local.env'));

  // Open this session's channel once for the live wiring; the panel attaches its
  // own (replaying) handle separately. The command owns this channel's lifecycle.
  const channel = store.open(sessionId);
  let provisioned: ProvisionedSession;
  try {
    provisioned = provisionSession({ context, folder, store, sessionId, role, channel, liveSessions });
  } catch (error) {
    channel.close();
    void vscode.window.showErrorMessage(
      `Could not ${resumed ? 'resume' : 'start'} ${role} session "${sessionId}": ${String(error)}`,
    );
    return;
  }

  // If this is a compaction restart (#165), post the self-hand-off as the first message
  // so the fresh orchestrator session's first turn answers it. The `planner` role marks
  // it as an authoritative instruction (it is — the previous orchestrator wrote it).
  // Post before the panel opens so it replays for the new panel immediately.
  if (compactionHandoff) {
    const handoffSeat = channel.join(`${sessionId}-compaction-handoff`, 'planner', () => {});
    handoffSeat.send({ type: 'text', payload: compactionHandoff });
    handoffSeat.close();
  }

  // Compaction host (#165, orchestrator only): listens for COMPACTION_REQUEST from the
  // orchestrator's compaction MCP server, acknowledges it, then waits for the turn's
  // result message to confirm the turn is complete before performing the restart. This
  // fires only at task boundaries (the instruction layer enforces no live delegates).
  let compactionPending = false;
  let compactionObserver: Participant | undefined;
  let compacted = false; // set when compaction takes over lifecycle; suppresses onDispose cleanup
  let idleTrigger: IdleCompactionTrigger | undefined; // set below for the orchestrator (#167)
  const isOrchestrator = role === 'orchestrator';

  const compactionHost = isOrchestrator
    ? channel.join(`${sessionId}-compact-host`, 'planner', (message: Message) => {
        if (message.type !== COMPACTION_REQUEST || compactionPending) return;
        const request = message.payload as CompactionRequest;
        if (!request?.handoff?.trim()) {
          const response: CompactionResponse = { requestId: request.requestId, error: 'empty handoff' };
          compactionHost?.send({ type: COMPACTION_RESPONSE, payload: response });
          return;
        }
        compactionPending = true;
        // Acknowledge immediately so the MCP tool returns and the turn can complete.
        const response: CompactionResponse = { requestId: request.requestId };
        compactionHost?.send({ type: COMPACTION_RESPONSE, payload: response });

        // Watch for the agent's result message — that marks turn completion. Only then
        // do we perform the restart, so the orchestrator's reply is in the log first.
        compactionObserver = channel.join(`${sessionId}-compact-observer`, 'planner', (msg: Message) => {
          if (msg.from !== provisioned.agentId || msg.type !== 'result') return;
          compactionObserver?.close();
          compactionObserver = undefined;
          void performCompaction(request.handoff);
        });
      })
    : undefined;

  // Tear down the current orchestrator session and relaunch from the hand-off (#165).
  // Called after the compacted turn's result arrives on the channel.
  async function performCompaction(handoff: string): Promise<void> {
    // 1. Read the current generation and compute the next one.
    const { generation } = inspectSession(store.logPath(sessionId), sessionId);
    const nextGeneration = generation + 1;

    // 2. Persist the new generation to the JSONL before closing (so inspectSession
    //    recovers it on a subsequent window reload).
    compactionHost?.send({
      type: COMPACTION_GENERATION,
      payload: { generation: nextGeneration },
    });

    // 3. Close the compaction host seat and idle trigger (no more activity on old session).
    compactionHost?.close();
    idleTrigger?.close();

    // 4. Mark as compacted so onDispose doesn't double-close.
    compacted = true;

    // 5. Tear down the old agent and MCP config, releasing (not closing) delegate
    //    sessions so their worktrees survive for the new generation to rewire (#204).
    provisioned.closeForCompaction();

    // 6. Close the command-level channel. The panel's own channel handle stays open
    //    (closed by the panel's onDidDispose), so it continues to display history.
    channel.close();

    // 7. Relaunch: open a fresh orchestrator session on the next generation's claude
    //    session id, sending the hand-off as its first turn.
    openOrchestrator(context, folder, store, liveSessions, handoff, tracker);
  }

  // Idle-triggered compaction (#167, orchestrator only): proactively compact when the
  // orchestrator has been idle long enough that the prompt cache is about to expire,
  // so the hand-off turn is still cache-warm and the eventual post-idle resume is cheap.
  if (isOrchestrator) {
    const idleThresholdMs =
      loadProjectConfig(join(folder.uri.fsPath, 'mjolnir.config.json')).compaction.idleThresholdSeconds * 1000;
    if (idleThresholdMs > 0) {
      idleTrigger = createIdleCompactionTrigger({
        channel,
        agentId: provisioned.agentId,
        thresholdMs: idleThresholdMs,
        participantId: `${sessionId}-idle-observer`,
        // Activity gate (#167): exclude the compaction hand-off message (the first
        // turn of a freshly-restarted generation) and our own injected prompts, so the
        // trigger does not re-arm after a compaction whose new generation has only
        // processed its launch hand-off and gone idle (which would loop indefinitely).
        internalSenderIds: new Set([
          `${sessionId}-compaction-handoff`,
          `${sessionId}-idle-trigger`,
        ]),
        onFire: () => {
          // Inject a planner-attributed 'text' prompt so the orchestrator's next turn
          // writes its self-hand-off and calls mcp__compact__request. This reuses the
          // existing compaction flow — the host's compactionHost listener picks up the
          // resulting COMPACTION_REQUEST and performs the restart.
          const seat = channel.join(`${sessionId}-idle-trigger`, 'planner', () => {});
          seat.send({ type: 'text', payload: IDLE_COMPACTION_PROMPT });
          seat.close();
        },
      });
    }
  }

  openSessionPanel(context, store, sessionId, folder.uri.fsPath, liveSessions, {
    executorAttached: true,
    executorId: provisioned.agentId,
    reasoning: provisioned.reasoning,
    agentLabel: role,
    model: provisioned.model,
    meter: provisioned.meter,
    onOpen: () => tracker?.track(sessionId),
    onDispose: () => {
      tracker?.untrack(sessionId);
      if (compacted) return; // compaction already cleaned up; don't double-close
      compactionObserver?.close();
      compactionHost?.close();
      idleTrigger?.close();
      const captured = provisioned.close();
      channel.close();
      // The orchestrator has no branch (it works out of the main repo, #123), so only
      // a worktree session mentions one.
      const onBranch = provisioned.branch ? ` (branch ${provisioned.branch})` : '';
      void vscode.window.showInformationMessage(
        captured
          ? `${capitalize(role)} session "${sessionId}" ended — review its work${onBranch}.`
          : `${capitalize(role)} session "${sessionId}" ended${captured || !provisioned.branch ? '' : ' — it made no changes'}${onBranch}.`,
      );
    },
    openSession: (id) => openSessionById(id, context, folder, store, liveSessions, tracker),
  });
  const onBranch = provisioned.branch ? ` on branch ${provisioned.branch}` : '';
  void vscode.window.showInformationMessage(
    resumed
      ? `${capitalize(role)} session "${sessionId}" resumed${onBranch} — pick up where it left off.`
      : `${capitalize(role)} session "${sessionId}" started${onBranch} — ` +
          `type ${role === 'orchestrator' ? 'a goal' : 'a task'} in the panel.`,
  );
}

/** "an" for orchestrator, "a" otherwise — for the input-box title. */
function article(role: AgentRole): string {
  return /^[aeiou]/i.test(role) ? 'an' : 'a';
}

/** Capitalize a role for a user-facing message ("Orchestrator", "Executor"). */
function capitalize(role: AgentRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * The model to run an agent of `role` on (#119), passed to `--model`. Defaults live
 * in code — cheaper tier (`sonnet`) for the mechanical roles, *empty* for the
 * orchestrator so it inherits the user's own Claude Code default (it's the design
 * agent). A user can still override per role in `settings.json`
 * (`mjolnirsoft.model.<role>` = an alias/id, or empty to inherit). This is read as a
 * plain setting rather than a contributed configuration: a `package.json` manifest
 * change isn't picked up by the dev-host's window-reload/restart (only dist changes
 * are), so contributing a settings-UI entry would silently fail to load — deferred
 * to a proper versioned release. An empty value means "no `--model`" (inherit).
 */
function modelForRole(role: AgentRole): string | undefined {
  const DEFAULTS: Record<AgentRole, string> = { executor: 'sonnet', evaluator: 'sonnet', orchestrator: '', arbitrator: 'sonnet', investigator: 'sonnet' };
  const configured = vscode.workspace.getConfiguration('mjolnirsoft.model').get<string>(role);
  const value = (configured ?? DEFAULTS[role]).trim();
  return value || undefined;
}

export function deactivate(): void {}

function requireFolder(): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a workspace folder to use Mjolnirsoft sessions.');
  }
  return folder;
}

function storeFor(folder: vscode.WorkspaceFolder): SessionStore {
  return new SessionStore({ baseDir: vscode.Uri.joinPath(folder.uri, '.mjolnir', 'sessions').fsPath });
}

/**
 * Open a webview panel attached to a session: replay history, stream live, compose.
 *
 * `executorAttached` says whether a live executor is answering this session. Only the
 * executor-spawning caller sets it true; the "open existing session" front door
 * attaches a viewer with no executor, so its panel must never show "working" (the
 * indicator once lied for 49 minutes on a session nobody was running) and warns
 * before a typed message vanishes into an unanswered log (#76).
 */
function openSessionPanel(
  context: vscode.ExtensionContext,
  store: SessionStore,
  sessionId: string,
  projectDir: string,
  liveSessions: LiveSessions,
  options: {
    /** Called immediately after the panel is created — used to track the panel in persistent storage (#128). */
    onOpen?: () => void;
    onDispose?: () => void;
    executorAttached?: boolean;
    executorId?: string;
    reasoning?: ReasoningStream;
    /** What to call the working agent in the indicator (e.g. "orchestrator"); default "executor". */
    agentLabel?: string;
    /** The model this session's agent runs on, shown in the header (#119); undefined → "default". */
    model?: string;
    /** This session's token meter (#116); its running total (incl. sub-agents) shows in the header. */
    meter?: UsageMeter;
    /** Open a session by id when a session-link in the rendered HTML is clicked (#186). */
    openSession?: (id: string) => void;
  } = {},
): void {
  const executorAttached = options.executorAttached ?? false;
  const agentLabel = options.agentLabel ?? 'executor';
  // The executor whose replies settle a sent turn. Only this participant's
  // messages advance the queue/indicator — a bridged delegate report (#93) is
  // someone else's id, so it renders but never counts as a turn completion (#100).
  const executorId = options.executorId;
  // The model a sender ran on (#119), for the per-response turn header: this
  // session's own agent uses the session model; a bridged delegate report is looked
  // up by its id in the live registry. So a mixed-model view (the orchestrator's own
  // Opus turns next to a bridged Sonnet executor report) is legible per response.
  const modelFor = (from: string): string | undefined =>
    from === executorId ? options.model : liveSessions.get(from)?.model;
  const panel = vscode.window.createWebviewPanel(
    'mjolnirsoftSessionView',
    // The singleton orchestrator reads as itself, not "Session: orchestrator" (#123);
    // executor sessions keep the id-tagged title.
    sessionId === ORCHESTRATOR_ID ? 'Mjolnirsoft Orchestrator' : `Session: ${sessionId}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      // Keep the webview alive while hidden so switching editor tabs doesn't
      // destroy the conversation (and unsent composer text). History is only
      // replayed once at join, so a recreated webview would come back empty.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    },
  );
  panel.webview.html = renderHtml(panel.webview, context.extensionUri, sessionId, agentLabel, options.model);
  options.onOpen?.();

  // Forward the executor's live reasoning (#108) to the webview ephemerally: each
  // block-level snapshot is rendered with the *same* renderer the durable digest
  // uses and posted as HTML that replaces the in-progress reasoning box, so it
  // builds up block-by-block in place and settles into the identical collapsed box
  // (no token smear, no view swap). This bypasses the channel entirely, so nothing
  // here is logged or replayed. No-op for a viewer-only panel (no executor, no stream).
  const unsubscribeReasoning = options.reasoning?.subscribe((digest) => {
    void panel.webview.postMessage({
      kind: 'reasoning',
      html: renderReasoningDigestLive(executorId ?? '', digest),
    });
  });

  // Live token tally (#116): the session's meter pushes its running total (this
  // session + rolled-up sub-agents) into the header as it climbs. No-op for a
  // viewer-only panel (no meter); a replayed ended session instead picks up its
  // final tally from the persisted `usage` message handled below.
  const unsubscribeUsage = options.meter?.subscribe((total) => {
    void panel.webview.postMessage({ kind: 'usage', text: formatUsage(total) });
  });

  // Attach to the session: replay history, then stream live messages.
  const channel = store.open(sessionId, { replay: true });
  // Pending interactions by request id, so a decision from the webview (which
  // only knows the id + the user's picks) can be assembled against the original
  // request — e.g. echoing a question's `questions` back alongside the answers.
  const pendingRequests = new Map<string, InteractionRequest>();
  // The last task we sent, held so an auth-failure card's "Retry" can re-send it
  // (#90). A single interactive executor answers this session, so the last-sent
  // message is the one that failed.
  let lastSentText: string | undefined;
  // How many sent turns are awaiting a reply. The executor serializes turns
  // (#100), running them one at a time, so when more than one is outstanding the
  // extras are queued behind the in-flight turn — the count drives a "queued" cue
  // so a message typed mid-turn doesn't look ignored.
  let outstanding = 0;
  // Running sum of replayed per-turn usage (#116), for a replayed/ended session that
  // has no live meter to drive the header. A live session ignores these (its meter,
  // which already counts the same turns plus sub-agents, owns the header).
  let replayedUsage = ZERO_USAGE;
  // Linkify session ids in rendered HTML (#186): snapshot the known ids at render
  // time so newly spawned sessions are included without extra state to maintain.
  const linkify = (html: string): string =>
    linkifySessionIds(html, [...new Set([...store.list(), ...liveSessions.keys()])]);
  const participant = channel.join('vscode-view', 'planner', (message) => {
    // Delegation control messages (#93) are plumbing between the executor's MCP
    // server and the in-host delegation manager — not conversation. Skip them so
    // they don't render as noisy turns or toggle the working indicator; the
    // delegate's *report* arrives as an ordinary message and renders normally.
    if (message.type === DELEGATION_REQUEST || message.type === DELEGATION_RESPONSE) return;
    // Compaction control messages (#165) are plumbing — the request/response between
    // the compaction MCP server and the in-host compaction listener. The generation
    // bookmark is a JSONL bookkeeping entry. None render as conversation turns.
    if (
      message.type === COMPACTION_REQUEST ||
      message.type === COMPACTION_RESPONSE ||
      message.type === COMPACTION_GENERATION
    ) return;
    // A persisted per-turn token tally (#116). For a live session the meter already
    // drives the header (and counts these turns plus rolled-up sub-agents), so skip
    // them to avoid clobbering it with a single turn's delta. For a replayed/ended
    // session there's no meter, so sum the deltas to reconstruct the running total.
    // Never rendered as a conversation turn either way.
    if (message.type === USAGE_MESSAGE) {
      if (!options.meter) {
        replayedUsage = addUsage(replayedUsage, message.payload as Usage);
        void panel.webview.postMessage({ kind: 'usage', text: formatUsage(replayedUsage) });
      }
      return;
    }
    // An interaction decision is the human's answer sent back to the perm bridge —
    // plumbing, not conversation. On replay the vscode-view's own decisions are
    // echoed back; skip them so they don't render as raw JSON (#161).
    if (message.type === INTERACTION_DECISION) return;
    // An interaction request means the executor is blocked waiting on us — render
    // its card and keep the "working" indicator on (it hasn't replied yet).
    if (message.type === INTERACTION_REQUEST) {
      const request = message.payload as InteractionRequest;
      pendingRequests.set(request.requestId, request);
      void panel.webview.postMessage({ kind: 'message', html: linkify(renderInteractionRequest(request)) });
      return;
    }
    // The durable reasoning digest (#110) lands just before the turn's result, and
    // carries the same entries the live snapshots already built up. It must NOT
    // settle the turn: the `result`, which follows it, does.
    if (message.type === REASONING_DIGEST) {
      if (message.from === executorId) {
        // Live: the box is already on screen from the snapshots. Render it once more
        // collapsed (final counts) to replace the open in-progress box, then stop
        // tracking it — the same box settles in place; nothing vanishes or swaps.
        void panel.webview.postMessage({ kind: 'reasoning', html: renderMessage(message, modelFor(message.from)) });
        void panel.webview.postMessage({ kind: 'reasoning-settle' });
      } else {
        // Replay/viewer: no live box existed (the stream is per live session), so
        // render the digest as its own collapsed box in the conversation.
        void panel.webview.postMessage({ kind: 'message', html: linkify(renderMessage(message, modelFor(message.from))) });
      }
      return;
    }
    void panel.webview.postMessage({ kind: 'message', html: linkify(renderMessage(message, modelFor(message.from))) });
    // Only the executor's own reply settles a sent turn. A bridged delegate
    // report (#93) — e.g. an evaluator's finding — renders above, but the executor
    // is still mid-turn (about to react to it), so it must not advance the queue or
    // flip the indicator off (#100). Anything that isn't the executor's reply
    // renders and stops here.
    if (message.from !== executorId) return;
    // The reasoning box already settled when the digest message arrived (just above
    // the result); the result is the clean answer bubble. No reasoning cleanup here.
    // A reply settles the in-flight turn. With serialization (#100) the executor
    // runs queued turns one at a time, so if more were sent while this one ran the
    // next now starts: keep "working" on and drop the queued count by one. Only
    // when nothing is left outstanding does "working" stop.
    if (outstanding > 0) outstanding -= 1;
    if (outstanding === 0) {
      void panel.webview.postMessage({ kind: 'working', on: false });
      void panel.webview.postMessage({ kind: 'queued', count: 0 });
    } else {
      void panel.webview.postMessage({ kind: 'working', on: true });
      void panel.webview.postMessage({ kind: 'queued', count: outstanding - 1 });
    }
  });

  // Send one (possibly multi-line) message: render the sent turn locally (the
  // channel doesn't echo a participant's own messages), put it on the channel,
  // and hold it as the last-sent task for an auth "Retry" (#90). With an executor
  // attached, show "working" until a reply arrives; without one, warn — the
  // message is logged but unanswered. Both decisions are made here, where
  // `executorAttached` is reliable, so the webview never needs attachment state.
  const dispatchSend = (text: string): void => {
    const sent = { from: participant.id, role: participant.role, type: 'text', payload: text };
    void panel.webview.postMessage({ kind: 'message', html: renderMessage(sent) });
    participant.send({ type: 'text', payload: text });
    lastSentText = text;
    if (executorAttached) {
      outstanding += 1;
      if (outstanding === 1) {
        // First turn: the executor starts on it immediately.
        void panel.webview.postMessage({ kind: 'working', on: true });
      } else {
        // A turn is already in flight; #100 serialization queues this one behind
        // it. Show how many are waiting so a mid-turn send doesn't look ignored.
        void panel.webview.postMessage({ kind: 'queued', count: outstanding - 1 });
      }
    } else {
      void panel.webview.postMessage({
        kind: 'notice',
        text: '⚠ No executor is attached — this message is logged but won’t be answered.',
      });
    }
  };

  // Compose-and-send: one (possibly multi-line) message per send.
  panel.webview.onDidReceiveMessage(
    (event: {
      kind?: string;
      text?: string;
      requestId?: string;
      behavior?: 'allow' | 'deny' | 'always';
      answers?: Record<string, string | string[]>;
      message?: string;
      id?: string;
    }) => {
      if (event.kind === 'send' && event.text) {
        dispatchSend(event.text);
      } else if (event.kind === 'auth-login') {
        // Guided re-login (#90): the official Claude Code extension exposes no
        // command API to invoke its OAuth flow, so open a terminal that runs
        // `claude auth login`. The user completes the browser flow; refreshed
        // per-machine credentials are picked up by the next executor spawn.
        // Launch claude as the terminal's own process (shellPath + shellArgs)
        // rather than typing a command into a shell: the binary path is an exec
        // argument, never parsed by a shell, so a CLAUDE_BIN with spaces (e.g.
        // `C:\Program Files\...\claude.exe`) works regardless of the user's
        // default shell — no per-shell quoting. This is how the executor already
        // spawns claude (a direct exec, no shell). Reuse `resolveClaudeBin()` so
        // a `.local.env` CLAUDE_BIN is honored.
        const terminal = vscode.window.createTerminal({
          name: 'Claude login',
          shellPath: resolveClaudeBin(),
          shellArgs: ['auth', 'login'],
        });
        terminal.show();
      } else if (event.kind === 'auth-retry') {
        // Re-send the held failed task to the still-alive executor (runExecutor's
        // catch doesn't tear it down), which re-spawns claude and reads the
        // refreshed creds. Show "working" like a normal send.
        if (lastSentText !== undefined) dispatchSend(lastSentText);
      } else if (event.kind === 'decision' && event.requestId) {
        const request = pendingRequests.get(event.requestId);
        pendingRequests.delete(event.requestId);
        if (event.answers) {
          // Clarifying question: echo the original `questions` back with the
          // picks, the shape AskUserQuestion expects, as the allow's updatedInput.
          const questions = (request?.input as { questions?: unknown[] } | undefined)?.questions ?? [];
          participant.send({
            type: INTERACTION_DECISION,
            payload: { requestId: event.requestId, behavior: 'allow', updatedInput: { questions, answers: event.answers } },
          });
        } else if (event.behavior) {
          // Permission: a verdict + requestId is enough; the server fills the
          // original input on a bare allow. "Always" is *our* side-effect — we
          // persist a learned allow rule for the action and then send a plain
          // `allow`, so the executor/MCP server never sees "always" (#70).
          // A deny from a question card (the free-text "can't answer" path, #96)
          // carries a `message` — pass it through so the agent can read and adapt.
          if (event.behavior === 'always' && request) {
            recordLearnedRule(projectDir, request.toolName, request.input);
          }
          const behavior = event.behavior === 'deny' ? 'deny' : 'allow';
          participant.send({
            type: INTERACTION_DECISION,
            payload: { requestId: event.requestId, behavior, ...(event.message ? { message: event.message } : {}) },
          });
        }
        // The executor resumes once it has our answer, so show "working" again.
        // (Interaction requests only come from a live executor, but stay honest.)
        if (executorAttached) {
          void panel.webview.postMessage({ kind: 'working', on: true });
        }
      } else if (event.kind === 'open-session' && event.id && options.openSession) {
        // Session-link click (#186): open the named session via the front-door dispatch.
        options.openSession(event.id);
      }
    },
  );

  panel.onDidDispose(() => {
    unsubscribeReasoning?.();
    unsubscribeUsage?.();
    participant.close();
    channel.close();
    options.onDispose?.();
  });
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  sessionId: string,
  agentLabel: string,
  model: string | undefined,
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Mjolnirsoft Session View</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); display: flex; flex-direction: column; }
  /* Persistent session header (#119): the session name and the model this agent
     runs on, at the top where users look — not a transient toast. */
  #session-header { padding: 0.4rem 1rem; font-size: 0.85em; border-bottom: 1px solid var(--vscode-panel-border);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #session-header .sh-name { font-weight: 600; }
  #session-header .sh-model { opacity: 0.85; }
  #session-header .sh-usage { opacity: 0.85; }
  #content { flex: 1; overflow-y: auto; padding: 0 1rem; }
  .turn { padding: 0.4rem 0.6rem; margin: 0.45rem 0; border-radius: 4px; }
  /* An executor-failure turn (#89): a theme warning colour so it reads as a problem. */
  .turn.error { border-inline-start: 3px solid var(--vscode-inputValidation-warningBorder, #cca700);
                background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,0.1)); }
  .turn.error .from { color: var(--vscode-inputValidation-warningForeground, #cca700); opacity: 1; }
  /* The auth-failure recovery card (#90): the warning frame plus log-in/retry actions. */
  .auth-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .auth-login { border: none; padding: 0.25rem 0.9rem; cursor: pointer; border-radius: 3px;
                background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .auth-retry { border: none; padding: 0.25rem 0.9rem; cursor: pointer; border-radius: 3px;
                background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); }
  .auth-actions button:disabled { opacity: 0.5; cursor: default; }
  .from { font-size: 0.8em; opacity: 0.7; margin-bottom: 0.25rem; }
  .mermaid { background: #fff; padding: 0.5rem; border-radius: 4px; }
  /* The in-progress "working" block (#76): the elapsed-timer header. The live
     reasoning now renders in its own block-level box (below), not here. */
  #working { padding: 0.4rem 1rem; font-size: 0.85em; }
  #working[hidden] { display: none; }
  #working-header { opacity: 0.75; }
  /* The reasoning box (#108): one block-level view shared by the live stream and the
     persisted digest (#110). It builds up block-by-block as the turn runs (open),
     then settles collapsed in place — same markup, so no view swap. Thinking dimmed,
     interim narration normal-weight; each tool-use is its own nested twisty showing
     input + a trimmed result. The final answer is not here — it renders in its own
     result bubble. */
  .reasoning-digest .from { font-style: italic; }
  .reasoning-digest-trail > summary { cursor: pointer; opacity: 0.75; font-style: italic; user-select: none; }
  .reasoning-digest-trail .digest-body { margin-top: 0.35rem; }
  .digest-thinking { white-space: pre-wrap; word-break: break-word; opacity: 0.6; font-style: italic;
                     margin: 0.25rem 0; }
  .digest-text { white-space: pre-wrap; word-break: break-word; margin: 0.25rem 0; }
  .digest-tool { margin: 0.25rem 0; }
  .digest-tool > summary { cursor: pointer; user-select: none; }
  .digest-label { font-size: 0.8em; opacity: 0.7; margin-top: 0.25rem; }
  /* Clickable session-id links (#186): styled as links using the VS Code theme colours. */
  .session-link { cursor: pointer; color: var(--vscode-textLink-foreground, #4daafc);
                  text-decoration: underline; text-underline-offset: 2px; }
  .session-link:hover { color: var(--vscode-textLink-activeForeground, #4daafc); }
  #queued { padding: 0.25rem 1rem; font-size: 0.85em; opacity: 0.75; }
  #queued[hidden] { display: none; }
  #notice { padding: 0.25rem 1rem; font-size: 0.85em; color: var(--vscode-inputValidation-warningForeground, #cca700); }
  #notice[hidden] { display: none; }
  #composer { display: flex; gap: 0.5rem; padding: 0.5rem 1rem; border-top: 1px solid var(--vscode-panel-border); }
  #input { flex: 1; min-height: 3em; font: inherit; resize: vertical; padding: 0.4rem;
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border, transparent); }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
          border: none; padding: 0 1rem; cursor: pointer; }
  .interaction-input { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
                       padding: 0.4rem; border-radius: 3px; font-size: 0.85em; max-height: 12em; overflow-y: auto; }
  .decision { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .decide { border: none; padding: 0.25rem 0.9rem; cursor: pointer; border-radius: 3px;
            background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); }
  .decide[data-behavior="allow"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .decide[data-behavior="always"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            box-shadow: inset 0 0 0 1px var(--vscode-button-foreground); }
  .decide:disabled { opacity: 0.5; cursor: default; }
  .decided { font-size: 0.85em; opacity: 0.8; align-self: center; }
  .question { margin: 0.5rem 0; }
  .question.unanswered .q-text { color: var(--vscode-inputValidation-errorForeground, #f48771); }
  .q-text { margin-bottom: 0.35rem; }
  .q-hint { font-size: 0.85em; opacity: 0.7; }
  .options { display: flex; flex-direction: column; gap: 0.3rem; }
  .opt { text-align: left; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px;
         padding: 0.3rem 0.6rem; cursor: pointer; background: transparent; color: var(--vscode-foreground); }
  .opt.selected { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .opt:disabled { opacity: 0.55; cursor: default; }
  .opt-desc { opacity: 0.7; }
  .submit-answers { border: none; padding: 0.25rem 0.9rem; cursor: pointer; border-radius: 3px;
                    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .submit-answers:disabled { opacity: 0.5; cursor: default; }
  .cant-answer-toggle { background: transparent; color: var(--vscode-foreground);
                        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
                        border-radius: 3px; padding: 0.25rem 0.6rem; cursor: pointer; opacity: 0.75; font-size: 0.9em; }
  .cant-answer-toggle:hover { opacity: 1; }
  .cant-answer-toggle:disabled { opacity: 0.4; cursor: default; }
  .cant-answer-section { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .cant-answer-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                       border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 0.3rem;
                       font-family: inherit; font-size: 0.9em; resize: vertical; }
  .cant-answer-input:disabled { opacity: 0.5; }
  .cant-answer-send { align-self: flex-start; border: none; padding: 0.25rem 0.9rem; cursor: pointer;
                      border-radius: 3px;
                      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
                      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); }
  .cant-answer-send:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="session-header"><span class="sh-name">${sessionId}</span> · ${agentLabel} · <span class="sh-model">model: ${model ?? 'default'}</span><span class="sh-usage" id="usage"></span></div>
<div id="content"></div>
<div id="working" hidden>
  <div id="working-header">● ${agentLabel} is working…</div>
</div>
<div id="queued" hidden></div>
<div id="notice" hidden></div>
<div id="composer">
  <textarea id="input" placeholder="Type a message (Markdown + Mermaid). Enter to send, Shift+Enter for a new line."></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * Write a per-session MCP config wiring Claude to the bundled servers an executor
 * needs, and return its path. One config file declares all servers, so a single
 * `--mcp-config` carries them all (Claude merges all servers from the file):
 *
 *  - `perm` (#66) — backs `--permission-prompt-tool mcp__perm__approve`: bridges a
 *    gated tool use to the session channel for the human, and consults the
 *    project's learned "Always" rules to auto-allow (#70), so it's given the
 *    project dir.
 *  - `delegate` (#93) — exposes `mcp__delegate__spawn`/`mcp__delegate__shutdown`:
 *    bridges a delegation request to the in-host delegation manager over the same
 *    session channel.
 *  - `compact` (#165, orchestrator only) — exposes `mcp__compact__request`: bridges
 *    a compaction request to the in-host compaction listener over the session channel.
 *    Wired only when `compactParticipantId` is provided (orchestrator sessions).
 *
 * All servers are launched with the extension host's own Node (Electron run as
 * Node, so no separate Node on PATH is needed) and bridge over the same session
 * log under their own distinct channel ids. Returns the temp path; the caller
 * deletes it on close.
 */
function writeExecutorMcpConfig(
  context: vscode.ExtensionContext,
  sessionLogPath: string,
  permParticipantId: string,
  delegateParticipantId: string,
  projectDir: string,
  worktreePath: string,
  compactParticipantId?: string,
): string {
  const dist = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'dist', name).fsPath;
  type McpServers = Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  const mcpServers: McpServers = {
    perm: {
      command: process.execPath,
      args: [dist('permission-mcp-server.js')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        MJOLNIR_SESSION_LOG: sessionLogPath,
        MJOLNIR_PERM_ID: permParticipantId,
        MJOLNIR_PROJECT_DIR: projectDir,
        MJOLNIR_WORKTREE_DIR: worktreePath,
      },
    },
    delegate: {
      command: process.execPath,
      args: [dist('delegation-mcp-server.js')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        MJOLNIR_SESSION_LOG: sessionLogPath,
        MJOLNIR_DELEGATE_ID: delegateParticipantId,
      },
    },
  };
  if (compactParticipantId) {
    mcpServers['compact'] = {
      command: process.execPath,
      args: [dist('compaction-mcp-server.js')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        MJOLNIR_SESSION_LOG: sessionLogPath,
        MJOLNIR_COMPACT_ID: compactParticipantId,
      },
    };
  }
  const configPath = join(tmpdir(), `mjolnir-mcp-${permParticipantId}-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify({ mcpServers }));
  return configPath;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
