import * as vscode from 'vscode';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/core/session-store.ts';
import { WorktreeManager, currentRemoteBase, type Worktree } from '../../src/core/worktree.ts';
import { loadLocalEnv } from '../../src/cli/load-local-env.ts';
import { runExecutor } from '../../src/executor/executor-runtime.ts';
import { createClaudeCodeResponder, resolveClaudeBin } from '../../src/executor/claude-code-responder.ts';
import { createReasoningStream, type ReasoningStream } from '../../src/executor/reasoning-stream.ts';
import { createDelegationHost } from '../../src/executor/delegation-host.ts';
import { composeAgentInstructions } from '../../src/core/agent-instructions.ts';
import { recordLearnedRule } from '../../src/core/learned-permissions.ts';
import {
  INTERACTION_DECISION,
  INTERACTION_REQUEST,
  type InteractionRequest,
} from '../../src/core/interaction.ts';
import { DELEGATION_REQUEST, DELEGATION_RESPONSE } from '../../src/core/delegation-protocol.ts';
import { renderMessage, renderInteractionRequest } from './render.ts';

// The MCP server is named `perm` in the generated config, so its `approve` tool
// is addressed as `mcp__perm__approve` to `--permission-prompt-tool`.
const PERMISSION_PROMPT_TOOL = 'mcp__perm__approve';

// Quick-pick sentinel offered above the session list; the input validation for
// session names forbids spaces/'+', so this can never collide with a real id.
const START_NEW_SESSION = '+ Start a new executor session…';

export function activate(context: vscode.ExtensionContext): void {
  const openView = vscode.commands.registerCommand('mjolnirsoft.openSessionView', async () => {
    const folder = requireFolder();
    if (!folder) return;
    const store = storeFor(folder);

    // List-or-create front door: with no sessions, skip the dead-end message and
    // take the newcomer straight into starting an executor.
    const sessions = store.list();
    if (sessions.length === 0) {
      await startExecutorSession(context, folder, store);
      return;
    }
    const pick = await vscode.window.showQuickPick([START_NEW_SESSION, ...sessions], {
      title: 'Open a Mjolnirsoft session',
      placeHolder: 'Pick a session to open, or start a new executor',
    });
    if (!pick) return;
    if (pick === START_NEW_SESSION) {
      await startExecutorSession(context, folder, store);
      return;
    }

    openSessionPanel(context, store, pick, folder.uri.fsPath);
  });

  const startExecutor = vscode.commands.registerCommand('mjolnirsoft.startExecutorSession', async () => {
    const folder = requireFolder();
    if (!folder) return;
    await startExecutorSession(context, folder, storeFor(folder));
  });

  context.subscriptions.push(openView, startExecutor);
}

/**
 * Prompt for a name, spawn an executor in its own git worktree, and open its panel.
 * Shared by the "Start Executor Session" command and the "Open Session View" front
 * door, so the start-an-executor logic lives in exactly one place.
 */
async function startExecutorSession(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  store: SessionStore,
): Promise<void> {
  // The in-process executor shells out to `claude`; load machine-specific config
  // (CLAUDE_BIN) so it's found even when the extension host's PATH lacks it.
  loadLocalEnv(join(folder.uri.fsPath, '.local.env'));

  const sessionId = await vscode.window.showInputBox({
    title: 'Start an executor session',
    prompt: 'Name this session',
    placeHolder: 'e.g. add-feature-x',
    validateInput: (value) =>
      /^[A-Za-z0-9_-]+$/.test(value) ? undefined : "use letters, digits, '_' or '-'",
  });
  if (!sessionId) return;

  if (store.list().includes(sessionId)) {
    void vscode.window.showErrorMessage(`Session "${sessionId}" already exists — open it instead.`);
    return;
  }

  // Give the executor an isolated git worktree on its own branch, so it edits
  // the real repo without ever touching the developer's working tree. Base it on
  // the freshest origin/main (not local HEAD), so a new session starts from the
  // latest merged code even if this checkout hasn't been pulled (#83).
  let worktree: Worktree;
  try {
    const repoDir = folder.uri.fsPath;
    worktree = new WorktreeManager({ repoDir, base: currentRemoteBase(repoDir) }).create(sessionId);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not create a worktree for "${sessionId}": ${String(error)}`);
    return;
  }

  // Give the executor its MCP-backed capabilities: one per-session config wiring
  // Claude to both bundled servers — the permission server for escalation (#66/#70)
  // and the delegation server for spawning delegates (#93) — each bridging over
  // this session's channel. The human allows/denies gated tool uses in the panel;
  // a delegation request is answered by the in-host delegation manager wired below.
  const permParticipantId = `${sessionId}-perms`;
  const delegateParticipantId = `${sessionId}-delegate`;
  const mcpConfigPath = writeExecutorMcpConfig(
    context,
    store.logPath(sessionId),
    permParticipantId,
    delegateParticipantId,
    folder.uri.fsPath,
    worktree.path,
  );

  // The live, ephemeral path for the executor's reasoning (#109): the responder
  // pushes intermediate thinking/text/tool events here as it streams, and the
  // panel (opened below) subscribes to forward them token-level to the webview.
  // It is deliberately *off* the channel — these events never hit the JSONL log
  // or replay; only the final `result` persists on the channel, exactly as before.
  const reasoning = createReasoningStream();

  // Spawn the executor in-process: it joins the session and answers each message
  // by running a headless Claude Code agent with the worktree as its workspace.
  const executorChannel = store.open(sessionId);
  const executorId = `${sessionId}-executor`;
  const executor = runExecutor(
    executorChannel,
    executorId,
    createClaudeCodeResponder({
      workdir: worktree.path,
      permissionPromptTool: PERMISSION_PROMPT_TOOL,
      mcpConfigPath,
      onEvent: reasoning.emit,
    }),
  );

  // Host the live side of delegation (#93): answer the executor's spawn/shutdown
  // requests by running the delegation manager in-process. A spawned delegate
  // (e.g. an evaluator) runs a headless Claude Code agent with **the executor's
  // own worktree** as its workspace — so it reviews "what is" — on its own
  // sub-channel session log, composing that role's instructions; its finding
  // bridges back up onto this session, attributed as an agent (#86).
  const delegationHost = createDelegationHost({
    spawnerChannel: executorChannel,
    spawnerId: executorId,
    hostId: `${sessionId}-delegation-host`,
    openSubChannel: (id) => store.open(id),
    createResponder: (role) =>
      createClaudeCodeResponder({
        workdir: worktree.path,
        appendSystemPrompt: composeAgentInstructions(role),
        // claudeSessionId defaults to a fresh UUID — the delegate's *channel* id
        // is not a valid `--session-id`, and a delegate is short-lived anyway.
      }),
  });

  openSessionPanel(context, store, sessionId, folder.uri.fsPath, {
    executorAttached: true,
    executorId,
    reasoning,
    onDispose: () => {
      delegationHost.close();
      executor.close();
      executorChannel.close();
      rmSync(mcpConfigPath, { force: true });
      // System capture: commit whatever the executor changed onto its branch,
      // then drop the worktree (the branch survives for review).
      const captured = worktree.commit(`Mjolnir executor session ${sessionId}`);
      worktree.remove();
      void vscode.window.showInformationMessage(
        captured
          ? `Executor session "${sessionId}" ended — review its work on branch ${worktree.branch}.`
          : `Executor session "${sessionId}" ended — it made no changes (branch ${worktree.branch}).`,
      );
    },
  });
  void vscode.window.showInformationMessage(
    `Executor session "${sessionId}" started on branch ${worktree.branch} — type a task in the panel.`,
  );
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
  options: {
    onDispose?: () => void;
    executorAttached?: boolean;
    executorId?: string;
    reasoning?: ReasoningStream;
  } = {},
): void {
  const executorAttached = options.executorAttached ?? false;
  // The executor whose replies settle a sent turn. Only this participant's
  // messages advance the queue/indicator — a bridged delegate report (#93) is
  // someone else's id, so it renders but never counts as a turn completion (#100).
  const executorId = options.executorId;
  const panel = vscode.window.createWebviewPanel(
    'mjolnirsoftSessionView',
    `Session: ${sessionId}`,
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
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  // Forward the executor's live reasoning (#109) to the webview ephemerally: each
  // thinking/text/tool event becomes a `reasoning` post the webview renders into
  // its in-progress block. This bypasses the channel entirely, so nothing here is
  // logged or replayed. No-op for a viewer-only panel (no executor, no stream).
  const unsubscribeReasoning = options.reasoning?.subscribe((event) => {
    void panel.webview.postMessage({ kind: 'reasoning', event });
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
  const participant = channel.join('vscode-view', 'planner', (message) => {
    // Delegation control messages (#93) are plumbing between the executor's MCP
    // server and the in-host delegation manager — not conversation. Skip them so
    // they don't render as noisy turns or toggle the working indicator; the
    // delegate's *report* arrives as an ordinary message and renders normally.
    if (message.type === DELEGATION_REQUEST || message.type === DELEGATION_RESPONSE) return;
    // An interaction request means the executor is blocked waiting on us — render
    // its card and keep the "working" indicator on (it hasn't replied yet).
    if (message.type === INTERACTION_REQUEST) {
      const request = message.payload as InteractionRequest;
      pendingRequests.set(request.requestId, request);
      void panel.webview.postMessage({ kind: 'message', html: renderInteractionRequest(request) });
      return;
    }
    void panel.webview.postMessage({ kind: 'message', html: renderMessage(message) });
    // Only the executor's own reply settles a sent turn. A bridged delegate
    // report (#93) — e.g. an evaluator's finding — renders above, but the executor
    // is still mid-turn (about to react to it), so it must not advance the queue or
    // flip the indicator off (#100). Anything that isn't the executor's reply
    // renders and stops here.
    if (message.from !== executorId) return;
    // The turn's durable result has now rendered above, so its ephemeral live
    // stream is superseded — clear the in-progress reasoning block (#109) so it
    // never double-shows alongside the final turn. The next turn (if any) starts
    // a fresh stream.
    void panel.webview.postMessage({ kind: 'reasoning-clear' });
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
          if (event.behavior === 'always' && request) {
            recordLearnedRule(projectDir, request.toolName, request.input);
          }
          const behavior = event.behavior === 'deny' ? 'deny' : 'allow';
          participant.send({ type: INTERACTION_DECISION, payload: { requestId: event.requestId, behavior } });
        }
        // The executor resumes once it has our answer, so show "working" again.
        // (Interaction requests only come from a live executor, but stay honest.)
        if (executorAttached) {
          void panel.webview.postMessage({ kind: 'working', on: true });
        }
      }
    },
  );

  panel.onDidDispose(() => {
    unsubscribeReasoning?.();
    participant.close();
    channel.close();
    options.onDispose?.();
  });
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
  /* The in-progress "working" block (#109): the #76 elapsed-timer header, with the
     live answer text streaming below it; cleared when the turn's durable result lands. */
  #working { padding: 0.4rem 1rem; font-size: 0.85em; }
  #working[hidden] { display: none; }
  #working-header { opacity: 0.75; }
  /* Per-turn reasoning trail (#109): everything the executor emits live — thinking,
     response text, tool uses — streams into a collapsible <details> in the
     conversation, open while it works, then auto-collapsed when the result lands, so
     it's preserved for review while the clean result renders below. */
  .reasoning-trail { margin: 0.35rem 0; border-inline-start: 2px solid var(--vscode-panel-border);
                     padding-inline-start: 0.5rem; font-size: 0.9em; }
  .reasoning-trail > summary { cursor: pointer; opacity: 0.75; font-style: italic; user-select: none; }
  .trail-body { margin-top: 0.25rem; white-space: pre-wrap; word-break: break-word; }
  .trail-thinking { opacity: 0.6; font-style: italic; }
  /* Each tool use as a compact inline chip (e.g. ⚙ Bash) as the agent calls it. */
  .tool-chip { display: inline-block; background: var(--vscode-badge-background, #4d4d4d);
               color: var(--vscode-badge-foreground, #fff); border-radius: 3px; padding: 0 0.4rem;
               margin: 0.1rem 0.2rem; font-size: 0.92em; font-style: normal; }
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
</style>
</head>
<body>
<div id="content"></div>
<div id="working" hidden>
  <div id="working-header">● executor is working…</div>
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
 * Write a per-session MCP config wiring Claude to *both* bundled servers an
 * executor needs, and return its path. One config file declares two servers, so
 * a single `--mcp-config` carries both (Claude merges all servers from the file):
 *
 *  - `perm` (#66) — backs `--permission-prompt-tool mcp__perm__approve`: bridges a
 *    gated tool use to the session channel for the human, and consults the
 *    project's learned "Always" rules to auto-allow (#70), so it's given the
 *    project dir.
 *  - `delegate` (#93) — exposes `mcp__delegate__spawn`/`mcp__delegate__shutdown`:
 *    bridges a delegation request to the in-host delegation manager over the same
 *    session channel.
 *
 * Both servers are launched with the extension host's own Node (Electron run as
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
): string {
  const dist = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'dist', name).fsPath;
  const config = {
    mcpServers: {
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
    },
  };
  const configPath = join(tmpdir(), `mjolnir-mcp-${permParticipantId}-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
