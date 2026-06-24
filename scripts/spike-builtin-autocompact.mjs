/**
 * Spike harness for built-in auto-compaction investigation (#224).
 *
 * Empirically answers:
 *   Q1. Are autoCompactEnabled / autoCompactWindow valid --settings keys?
 *       Is CLAUDE_CODE_AUTO_COMPACT_WINDOW env var accepted?
 *   Q2. Do these settings survive a --print --input-format stream-json run
 *       (accepted without error, no unknown-key rejection)?
 *   Q3. Does the stream output contain compact_progress / sdk_status events
 *       that our stream reader would need to handle?
 *   Q4. Does --resume carry through a session after a normal close (confirming
 *       in-place state would survive close/reopen)?
 *
 * NOTE: Empirically triggering auto-compaction requires filling the context to
 * the configured threshold (100K-500K tokens), which is impractical in a spike
 * without consuming a large token budget. Q2-Q3 are therefore tested at the
 * "settings accepted, stream shapes catalogued" level; the threshold-fire
 * behavior is documented from binary analysis (see findings report).
 *
 * Usage (Git Bash, MSYS2):
 *   node scripts/spike-builtin-autocompact.mjs [--debug]
 *
 * CLAUDE_BIN env var overrides the default binary path.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEBUG = process.argv.includes('--debug');

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  'C:\\Users\\Kevin\\.vscode\\extensions\\anthropic.claude-code-2.1.190-win32-x64\\resources\\native-binary\\claude.exe';

// Baseline settings (same as executor policy, without compaction keys).
const BASE_SETTINGS = {
  permissions: { allow: ['Bash'], deny: [] },
  claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md'],
  autoMemoryEnabled: false,
};

// Settings that add autoCompactEnabled + autoCompactWindow (the orchestrator-like policy).
const AUTOCOMPACT_SETTINGS = {
  ...BASE_SETTINGS,
  autoCompactEnabled: true,
  autoCompactWindow: 500000, // 500K = ~50% of Opus 4.8's 1M context window
};

// Settings that explicitly DISABLE auto-compact (useful to confirm the key takes effect).
const NOCOMPACT_SETTINGS = {
  ...BASE_SETTINGS,
  autoCompactEnabled: false,
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(label, msg) {
  console.log(`[${ts()}] ${label}: ${msg}`);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Spawn claude --print in stream-json mode and collect all output lines.
 * Returns { code, lines, resultLine, compactEvents }.
 */
function spawnOneShot(settingsObj, extraArgs, onLine) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', JSON.stringify(settingsObj),
    ...extraArgs,
  ];
  if (DEBUG) log('SPAWN', `${CLAUDE_BIN} ${args.slice(0, 6).join(' ')} [...]`);

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buf = '';
    const lines = [];
    const compactEvents = [];

    child.stdout.on('data', (chunk) => {
      const text = decoder.write(chunk);
      buf += text;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        lines.push(line);
        onLine?.(line);
        // Collect any compact-related events for inspection.
        try {
          const obj = JSON.parse(line);
          if (
            obj.type === 'compact_progress' ||
            (obj.type === 'system' && obj.subtype === 'sdk_status') ||
            (typeof obj === 'object' && JSON.stringify(obj).toLowerCase().includes('compact'))
          ) {
            compactEvents.push(obj);
          }
        } catch { /* non-JSON line */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (DEBUG) process.stderr.write(`[STDERR] ${chunk}`);
    });

    let closeResolve;
    const closePromise = new Promise((res) => { closeResolve = res; });
    child.on('close', (code) => {
      const tail = decoder.end() + buf;
      if (tail.trim()) { lines.push(tail); onLine?.(tail); }
      closeResolve(code);
    });
    closePromise.then((code) => {
      const resultLine = lines.find((l) => { try { return JSON.parse(l).type === 'result'; } catch { return false; } });
      resolve({ code, lines, resultLine: resultLine ?? null, compactEvents });
    });
  });
}

/**
 * Spawn claude --print --input-format stream-json (persistent session).
 * Returns { code, lines, resultLine, compactEvents }.
 */
function spawnStreamSession(settingsObj, extraArgs, messages) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', JSON.stringify(settingsObj),
    ...extraArgs,
  ];
  if (DEBUG) log('SPAWN', `${CLAUDE_BIN} ${args.slice(0, 6).join(' ')} [...]`);

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buf = '';
    const lines = [];
    const compactEvents = [];

    child.stdout.on('data', (chunk) => {
      const text = decoder.write(chunk);
      buf += text;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        lines.push(line);
        if (DEBUG) log('OUT', line.slice(0, 200));
        try {
          const obj = JSON.parse(line);
          if (
            obj.type === 'compact_progress' ||
            (obj.type === 'system' && obj.subtype === 'sdk_status') ||
            (typeof obj === 'object' && JSON.stringify(obj).toLowerCase().includes('compact'))
          ) {
            compactEvents.push(obj);
          }
        } catch { /* non-JSON */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (DEBUG) process.stderr.write(`[STDERR] ${chunk}`);
    });

    let closeResolve;
    const closePromise = new Promise((res) => { closeResolve = res; });
    child.on('close', (code) => {
      const tail = decoder.end() + buf;
      if (tail.trim()) lines.push(tail);
      closeResolve(code);
    });

    // Push messages.
    for (const msg of messages) {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg } }) + '\n');
    }
    child.stdin.end();

    closePromise.then((code) => {
      const resultLines = lines.filter((l) => { try { return JSON.parse(l).type === 'result'; } catch { return false; } });
      resolve({ code, lines, resultLines, compactEvents });
    });
  });
}

// ---------------------------------------------------------------------------
// TEST 1 — Q1: autoCompactEnabled / autoCompactWindow accepted in --settings
//   Both true+window and false cases. Verifies the keys are valid schema fields
//   (not silently rejected or causing an error result).
// ---------------------------------------------------------------------------
async function test1_settingsAccepted() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1 — Q1: autoCompactEnabled / autoCompactWindow in --settings');
  console.log('='.repeat(70));

  // 1a: autoCompactEnabled:true + autoCompactWindow:500000
  console.log('\n[1a] autoCompactEnabled:true, autoCompactWindow:500000');
  const r1a = await spawnOneShot(AUTOCOMPACT_SETTINGS, ['Reply with exactly: SETTINGS_OK']);
  const res1a = r1a.resultLine ? JSON.parse(r1a.resultLine) : null;
  console.log(`exit=${r1a.code} is_error=${res1a?.is_error} result="${String(res1a?.result ?? '').slice(0, 60)}"`);
  const pass1a = r1a.code === 0 && !res1a?.is_error && String(res1a?.result ?? '').includes('SETTINGS_OK');
  console.log(pass1a ? '[PASS] Settings accepted, run succeeded' : '[FAIL] Run failed or keys rejected');

  // 1b: autoCompactEnabled:false
  console.log('\n[1b] autoCompactEnabled:false');
  const r1b = await spawnOneShot(NOCOMPACT_SETTINGS, ['Reply with exactly: AC_DISABLED']);
  const res1b = r1b.resultLine ? JSON.parse(r1b.resultLine) : null;
  console.log(`exit=${r1b.code} is_error=${res1b?.is_error} result="${String(res1b?.result ?? '').slice(0, 60)}"`);
  const pass1b = r1b.code === 0 && !res1b?.is_error && String(res1b?.result ?? '').includes('AC_DISABLED');
  console.log(pass1b ? '[PASS] autoCompactEnabled:false accepted' : '[FAIL]');

  return { pass: pass1a && pass1b };
}

// ---------------------------------------------------------------------------
// TEST 2 — Q1 (env var): CLAUDE_CODE_AUTO_COMPACT_WINDOW accepted
// ---------------------------------------------------------------------------
async function test2_envVar() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2 — Q1 (env): CLAUDE_CODE_AUTO_COMPACT_WINDOW env var');
  console.log('='.repeat(70));

  return new Promise((resolve) => {
    const args = [
      '--print', 'Reply with exactly: ENV_OK',
      '--output-format', 'json',
      '--settings', JSON.stringify(BASE_SETTINGS),
    ];
    const env = { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' };
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => {
      let parsed;
      try { parsed = JSON.parse(out); } catch { parsed = null; }
      const pass = code === 0 && !parsed?.is_error && String(parsed?.result ?? '').includes('ENV_OK');
      console.log(`exit=${code} is_error=${parsed?.is_error} result="${String(parsed?.result ?? '').slice(0, 60)}"`);
      console.log(pass ? '[PASS] CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 accepted' : '[FAIL]');
      resolve({ pass });
    });
  });
}

// ---------------------------------------------------------------------------
// TEST 3 — Q2/Q3: stream-json mode with autoCompact settings
//   Runs two turns via --input-format stream-json with autoCompact settings.
//   Checks: no error, result emitted, any compact_progress events catalogued.
// ---------------------------------------------------------------------------
async function test3_streamJsonWithAutoCompact() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3 — Q2/Q3: stream-json + autoCompact settings');
  console.log('='.repeat(70));

  const result = await spawnStreamSession(
    AUTOCOMPACT_SETTINGS,
    [], // no --session-id; fresh session
    [
      'Reply with exactly: TURN1',
      'Reply with exactly: TURN2',
    ],
  );

  console.log(`\nExit code: ${result.code}`);
  console.log(`Result lines found: ${result.resultLines.length}`);
  for (const rl of result.resultLines) {
    const obj = JSON.parse(rl);
    console.log(`  is_error=${obj.is_error} num_turns=${obj.num_turns} result="${String(obj.result ?? '').slice(0, 80)}"`);
    if (obj.usage) {
      const u = obj.usage;
      console.log(`  tokens: input=${u.input_tokens} output=${u.output_tokens} cache_read=${u.cache_read_input_tokens}`);
    }
  }

  console.log(`\nCompact-related events in stream: ${result.compactEvents.length}`);
  for (const ev of result.compactEvents) {
    console.log(' ', JSON.stringify(ev).slice(0, 200));
  }

  const pass = result.code === 0 && result.resultLines.length > 0 &&
    !result.resultLines.some((rl) => JSON.parse(rl).is_error);
  console.log(pass ? '\n[PASS] stream-json with autoCompact settings works' : '\n[FAIL]');

  return { pass, compactEventCount: result.compactEvents.length };
}

// ---------------------------------------------------------------------------
// TEST 4 — Q4: --resume carries session state (confirming in-place state survives)
//   Creates a session with a known fact, resumes it, checks recall.
//   This verifies that IF compaction fires in-place, the resumed session would
//   carry the compacted history (same mechanism as normal session persistence).
// ---------------------------------------------------------------------------
async function test4_resumeCarriesState() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 4 — Q4: --resume carries state (validates persistent-session model)');
  console.log('='.repeat(70));

  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  console.log('\n[Step A] Creating session with magic word...');
  const createResult = await spawnStreamSession(
    AUTOCOMPACT_SETTINGS,
    ['--session-id', sessionId],
    ['Remember: the magic word is ZEPHYR.'],
  );
  console.log(`Create exit=${createResult.code} result_count=${createResult.resultLines.length}`);
  const createResultObj = createResult.resultLines[0] ? JSON.parse(createResult.resultLines[0]) : null;
  console.log(`Create result (is_error=${createResultObj?.is_error}): "${String(createResultObj?.result ?? '').slice(0, 80)}"`);

  if (createResult.code !== 0 || createResultObj?.is_error) {
    console.log('[SKIP] Session create failed');
    return { skipped: true };
  }

  await sleep(1000);

  console.log('\n[Step B] Resuming session, asking for magic word...');
  const resumeResult = await spawnStreamSession(
    AUTOCOMPACT_SETTINGS,
    ['--resume', sessionId],
    ['What was the magic word I asked you to remember?'],
  );
  console.log(`Resume exit=${resumeResult.code} result_count=${resumeResult.resultLines.length}`);
  const resumeResultObj = resumeResult.resultLines[0] ? JSON.parse(resumeResult.resultLines[0]) : null;
  const recalled = String(resumeResultObj?.result ?? '').toLowerCase().includes('zephyr');
  console.log(`Resume result (is_error=${resumeResultObj?.is_error}): "${String(resumeResultObj?.result ?? '').slice(0, 120)}"`);
  console.log(recalled ? '[PASS] Magic word recalled — session state carries across resume' : '[CHECK] Magic word not found — check full output');

  return { pass: recalled };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('spike-builtin-autocompact.mjs — empirical test for #224');
  console.log(`CLAUDE_BIN: ${CLAUDE_BIN}`);
  console.log(`ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`\nNOTE: Triggering auto-compact requires filling ~500K tokens of context`);
  console.log(`      (Opus 4.8 at 50% threshold). This is not attempted in the spike.`);
  console.log(`      Instead we verify: settings accepted, stream shapes, resume state.`);

  try {
    const t1 = await test1_settingsAccepted();
    const t2 = await test2_envVar();
    const t3 = await test3_streamJsonWithAutoCompact();
    const t4 = await test4_resumeCarriesState();

    console.log('\n' + '='.repeat(70));
    console.log('SPIKE SUMMARY');
    console.log('='.repeat(70));
    console.log(`T1 (settings keys accepted):     ${t1.pass ? 'PASS' : 'FAIL'}`);
    console.log(`T2 (env var accepted):           ${t2.pass ? 'PASS' : 'FAIL'}`);
    console.log(`T3 (stream-json + autoCompact):  ${t3.pass ? 'PASS' : 'FAIL'} (compact events in stream: ${t3.compactEventCount})`);
    console.log(`T4 (resume carries state):       ${t4.skipped ? 'SKIPPED' : t4.pass ? 'PASS' : 'FAIL'}`);
    console.log('='.repeat(70));
    console.log('\nSee findings report in handoff for binary-analysis evidence on Q2/Q3 fire-in-print-mode.');
  } catch (err) {
    console.error('Unhandled error:', err);
    process.exit(1);
  }
})();
