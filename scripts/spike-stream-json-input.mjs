/**
 * Spike harness for --input-format stream-json mid-turn push semantics (#172).
 *
 * Empirically answers:
 *   Q1. Does claude accept NDJSON messages pushed to stdin while a turn is running?
 *   Q2. Does a mid-turn push land at the next tool boundary (never interrupt a running tool)?
 *   Q3. How are result/usage lines emitted across multiple messages?
 *   Q4. Does this work with subscription auth (no ANTHROPIC_API_KEY)?
 *   Q5. Does it compose with --resume/--session-id?
 *
 * Usage (Git Bash, MSYS2):
 *   node scripts/spike-stream-json-input.mjs [--debug]
 *
 * CLAUDE_BIN env var overrides the default binary path.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEBUG = process.argv.includes('--debug');

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  'C:\\Users\\Kevin\\.vscode\\extensions\\anthropic.claude-code-2.1.186-win32-x64\\resources\\native-binary\\claude.exe';

// Settings policy: pre-allow Bash so tool calls don't dead-end on a permission prompt.
// --dangerously-skip-permissions would also work but is broader; using --settings is precise.
const SETTINGS = JSON.stringify({
  permissions: {
    allow: ['Bash'],
    deny: [],
  },
  claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md'],
  autoMemoryEnabled: false,
});

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(label, msg) {
  console.log(`[${ts()}] ${label}: ${msg}`);
}

/**
 * Spawn claude with --input-format stream-json and return a controller that lets
 * you push NDJSON lines (user messages) to stdin and observe all output lines
 * with wall-clock timestamps.
 *
 * @param {string[]} extraArgs  additional CLI flags
 * @param {(line: string, t: string) => void} onLine  called for every stdout line
 * @returns {{ write(obj: object): void, end(): void, waitClose(): Promise<number|null> }}
 */
function spawnStreaming(extraArgs, onLine) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', SETTINGS,
    ...extraArgs,
  ];
  if (DEBUG) log('SPAWN', `${CLAUDE_BIN} ${args.join(' ')}`);

  const child = spawn(CLAUDE_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const decoder = new StringDecoder('utf8');
  let buf = '';

  child.stdout.on('data', (chunk) => {
    const text = decoder.write(chunk);
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line, ts());
    }
  });

  child.stderr.on('data', (chunk) => {
    if (DEBUG) process.stderr.write(`[STDERR] ${chunk}`);
  });

  let closeResolve;
  const closePromise = new Promise((res) => { closeResolve = res; });
  child.on('close', (code) => {
    // flush trailing partial line
    const tail = decoder.end() + buf;
    if (tail.trim()) onLine(tail, ts());
    closeResolve(code);
  });

  return {
    write(obj) {
      const line = JSON.stringify(obj) + '\n';
      if (DEBUG) log('STDIN', line.trim());
      child.stdin.write(line);
    },
    end() {
      child.stdin.end();
    },
    waitClose() {
      return closePromise;
    },
  };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// TEST 1 — Q4: Subscription auth + basic connectivity
//   Send a single trivial message (no tool use) and see if claude responds.
//   A non-zero exit or an is_error result means auth is broken.
// ---------------------------------------------------------------------------
async function test1_subscriptionAuth() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1 — Q4: subscription auth (no ANTHROPIC_API_KEY)');
  console.log('='.repeat(70));

  const lines = [];
  const ctrl = spawnStreaming([], (line, t) => {
    log('OUT', line);
    lines.push({ t, line });
  });

  // Push one user message as NDJSON
  ctrl.write({ type: 'user', message: { role: 'user', content: 'Reply with exactly the word: PONG' } });
  ctrl.end();

  const code = await ctrl.waitClose();
  console.log(`\nExit code: ${code}`);

  // Extract result line
  const resultLine = lines.find(l => { try { return JSON.parse(l.line).type === 'result'; } catch { return false; } });
  if (resultLine) {
    const r = JSON.parse(resultLine.line);
    console.log('\n--- result line ---');
    console.log(JSON.stringify(r, null, 2));
    if (r.is_error) {
      console.log('\n[FAIL] is_error=true — auth likely broken or format rejected');
    } else {
      console.log('\n[PASS] got a non-error result — subscription auth works');
    }
  } else {
    console.log('\n[FAIL] no result line found in output');
  }

  return { code, lines, resultLine: resultLine?.line };
}

// ---------------------------------------------------------------------------
// TEST 2 — Q1 + Q3: basic multi-message flow + result/usage shape
//   Two messages in quick succession; no tool use.
//   Verifies that multiple NDJSON lines on stdin work and confirms the
//   per-run result/usage envelope structure.
// ---------------------------------------------------------------------------
async function test2_multiMessage() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2 — Q1/Q3: multi-message flow, result/usage envelope');
  console.log('='.repeat(70));

  const events = [];

  const ctrl = spawnStreaming([], (line, t) => {
    log('OUT', line);
    events.push({ t, line });
  });

  log('SEND', 'message 1');
  ctrl.write({ type: 'user', message: { role: 'user', content: 'What is 1 + 1?' } });
  // Small gap so both are genuinely on stdin before processing starts
  await sleep(200);
  log('SEND', 'message 2');
  ctrl.write({ type: 'user', message: { role: 'user', content: 'And what is 3 + 3?' } });
  ctrl.end();

  const code = await ctrl.waitClose();
  console.log(`\nExit code: ${code}`);

  const resultLines = events.filter(e => { try { return JSON.parse(e.line).type === 'result'; } catch { return false; } });
  console.log(`\nResult lines found: ${resultLines.length}`);
  for (const r of resultLines) {
    const obj = JSON.parse(r.line);
    console.log(`  at ${r.t}: is_error=${obj.is_error} num_turns=${obj.num_turns} result="${String(obj.result ?? '').slice(0, 150)}"`);
    if (obj.usage) console.log(`  usage: ${JSON.stringify(obj.usage)}`);
  }

  return { code, events, resultLines: resultLines.map(r => r.line) };
}

// ---------------------------------------------------------------------------
// TEST 2b — Q2: message pushed AFTER task_started (mid-tool-execution)
//   Message 1 triggers a Bash tool with an 8-ping (~7s) window.
//   We watch for the system/task_started line and THEN push message 2,
//   so message 2 genuinely arrives while the tool process is executing.
//   Verifies: tool completes (not interrupted), message 2 answered, no crash.
// ---------------------------------------------------------------------------
async function test2b_midToolExecution() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2b — Q2: push message 2 AFTER task_started (mid-tool-execution)');
  console.log('='.repeat(70));

  const events = [];
  let taskStartedTime = null;
  let taskNotifiedTime = null;
  let secondMsgSentTime = null;
  let secondMsgSentAfterStart = false;

  // We need to push message 2 reactively on task_started; use a Promise to signal.
  let onTaskStarted;
  const taskStartedPromise = new Promise((res) => { onTaskStarted = res; });

  const ctrl = spawnStreaming([], (line, t) => {
    log('OUT', line);
    events.push({ t, line });

    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system' && obj.subtype === 'task_started') {
        taskStartedTime = t;
        log('NOTE', `task_started at ${t} (tool is now executing)`);
        onTaskStarted();
      }
      if (obj.type === 'system' && obj.subtype === 'task_notification' && obj.status === 'completed') {
        taskNotifiedTime = t;
        log('NOTE', `task_notification(completed) at ${t}`);
      }
    } catch { /* ignore */ }
  });

  // Message 1: 8-ping (~7s on Windows) gives a clear mid-execution window.
  // Asking claude to run it immediately ("just run it, don't explain first") minimises
  // the API-call latency before the tool starts, so task_started arrives sooner.
  const msg1Content =
    'Without any preamble, immediately run this exact bash command and report all output: ' +
    '`ping -n 8 127.0.0.1`';
  log('SEND', 'message 1 (8-ping, ~7s tool window)');
  ctrl.write({ type: 'user', message: { role: 'user', content: msg1Content } });

  // Wait for task_started (tool is now running), then push message 2.
  // Timeout guard of 60 s in case the API call takes unusually long.
  const timeoutPromise = sleep(60_000).then(() => {
    log('WARN', 'task_started not received within 60 s — sending message 2 anyway');
  });
  await Promise.race([taskStartedPromise, timeoutPromise]);

  secondMsgSentTime = ts();
  secondMsgSentAfterStart = taskStartedTime !== null;
  log('SEND', `message 2 at ${secondMsgSentTime} (task_started=${taskStartedTime ?? 'not yet'}, secondMsgAfterStart=${secondMsgSentAfterStart})`);
  ctrl.write({ type: 'user', message: { role: 'user', content: 'What is 5 + 5?' } });
  ctrl.end();

  const code = await ctrl.waitClose();
  console.log(`\nExit code: ${code}`);

  console.log('\n--- Timeline summary ---');
  console.log(`task_started time:       ${taskStartedTime ?? '(not received)'}`);
  console.log(`Second message sent at:  ${secondMsgSentTime}`);
  console.log(`task_notification time:  ${taskNotifiedTime ?? '(not received)'}`);
  console.log(`Msg2 sent AFTER start:   ${secondMsgSentAfterStart}`);

  const resultLines = events.filter(e => { try { return JSON.parse(e.line).type === 'result'; } catch { return false; } });
  console.log(`\nResult lines found: ${resultLines.length}`);
  for (const r of resultLines) {
    const obj = JSON.parse(r.line);
    console.log(`  at ${r.t}: is_error=${obj.is_error} num_turns=${obj.num_turns} result="${String(obj.result ?? '').slice(0, 200)}"`);
    if (obj.usage) console.log(`  usage (total): input=${obj.usage.input_tokens} output=${obj.usage.output_tokens}`);
  }

  // Check tool completed (not cut short)
  const toolResult = events.find(e => {
    try {
      const o = JSON.parse(e.line);
      return o.type === 'user' && Array.isArray(o.message?.content) &&
        o.message.content.some(c => c.type === 'tool_result');
    } catch { return false; }
  });
  if (toolResult) {
    const content = JSON.parse(toolResult.line).message.content.find(c => c.type === 'tool_result');
    const pingLines = String(content?.content ?? '').split('\n').filter(Boolean);
    const replyCount = pingLines.filter(l => l.includes('Reply from')).length;
    console.log(`\nPing replies in tool result: ${replyCount} (expected 8 if not interrupted)`);
    if (replyCount === 8) console.log('[PASS] Tool ran to completion — not interrupted by mid-execution push');
    else console.log(`[CHECK] Only ${replyCount}/8 replies — tool may have been cut short`);
  } else {
    console.log('\n[NOTE] No tool_result line found in output');
  }

  return { code, events, taskStartedTime, secondMsgSentTime, secondMsgSentAfterStart, resultLines: resultLines.map(r => r.line) };
}

// ---------------------------------------------------------------------------
// TEST 3 — Q5: --resume / --session-id compatibility
//   Run one turn with a session-id to create a session, then resume it with
//   --input-format stream-json.
// ---------------------------------------------------------------------------
async function test3_resumeCompatibility() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3 — Q5: --resume compatibility with stream-json input');
  console.log('='.repeat(70));

  const sessionId = '11111111-2222-3333-4444-555555555555';

  // Step A: create the session with a regular -p turn
  console.log('\n[Step A] Creating session with --session-id (non-streaming turn)...');
  const createLines = [];
  const createCtrl = spawnStreaming(['--session-id', sessionId], (line, t) => {
    log('A-OUT', line);
    createLines.push({ t, line });
  });
  createCtrl.write({ type: 'user', message: { role: 'user', content: 'Remember: the magic word is XYZZY.' } });
  createCtrl.end();
  const createCode = await createCtrl.waitClose();
  console.log(`\nCreate exit code: ${createCode}`);

  const createResult = createLines.find(l => { try { return JSON.parse(l.line).type === 'result'; } catch { return false; } });
  if (createResult) {
    const obj = JSON.parse(createResult.line);
    console.log(`Create result: is_error=${obj.is_error} "${String(obj.result ?? '').slice(0, 80)}"`);
  }

  if (createCode !== 0) {
    console.log('[SKIP] Session create failed; skipping resume test');
    return { skipped: true };
  }

  await sleep(1000); // brief pause before resuming

  // Step B: resume with --resume and stream-json input
  console.log('\n[Step B] Resuming session with --resume + --input-format stream-json...');
  const resumeLines = [];
  const resumeCtrl = spawnStreaming(['--resume', sessionId], (line, t) => {
    log('B-OUT', line);
    resumeLines.push({ t, line });
  });
  resumeCtrl.write({ type: 'user', message: { role: 'user', content: 'What was the magic word I asked you to remember?' } });
  resumeCtrl.end();
  const resumeCode = await resumeCtrl.waitClose();
  console.log(`\nResume exit code: ${resumeCode}`);

  const resumeResult = resumeLines.find(l => { try { return JSON.parse(l.line).type === 'result'; } catch { return false; } });
  if (resumeResult) {
    const obj = JSON.parse(resumeResult.line);
    console.log(`Resume result: is_error=${obj.is_error} "${String(obj.result ?? '').slice(0, 120)}"`);
    const recalled = String(obj.result ?? '').toLowerCase().includes('xyzzy');
    console.log(recalled
      ? '[PASS] Session context carried over — magic word recalled'
      : '[FAIL/CHECK] Magic word not found in result (may be a different phrasing — check full output)');
  } else {
    console.log('[FAIL] No result line in resume output');
  }

  return { createCode, resumeCode, createLines, resumeLines, resumeResult: resumeResult?.line };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('spike-stream-json-input.mjs — empirical test for #172');
  console.log(`CLAUDE_BIN: ${CLAUDE_BIN}`);
  console.log(`ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);

  try {
    const t1 = await test1_subscriptionAuth();

    // Only proceed if auth works
    const t1ResultObj = t1.resultLine ? JSON.parse(t1.resultLine) : null;
    if (t1.code !== 0 || t1ResultObj?.is_error) {
      console.log('\n[ABORT] Auth failed in test 1 — stopping spike. Check login / CLAUDE_BIN.');
      process.exit(1);
    }

    const t2 = await test2_multiMessage();
    const t2b = await test2b_midToolExecution();
    const t3 = await test3_resumeCompatibility();

    console.log('\n' + '='.repeat(70));
    console.log('SPIKE COMPLETE — see output above for raw evidence');
    console.log('='.repeat(70));
  } catch (err) {
    console.error('Unhandled error:', err);
    process.exit(1);
  }
})();
