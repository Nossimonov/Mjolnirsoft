import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseTurns, sumTurns, weightedByKind, type TurnUsage } from '../executor/usage-report.ts';
import { weightedUsage, type Usage } from '../executor/claude-code-responder.ts';

/**
 * Weighted token-usage report over `.mjolnir/sessions` logs (#233): the committed,
 * tested counterpart to the throwaway parsers used during cost analysis. Pure
 * analysis lives in `../executor/usage-report.ts` (reusing the canonical
 * {@link weightedUsage} so this and the in-product figure never drift); this file
 * is just the I/O + formatting shell.
 *
 *   npm run usage -- <session>                       whole session
 *   npm run usage -- orchestrator --from "merged"    only turns at/after a message
 *   npm run usage -- orchestrator --mermaid          + xychart & pie
 *   npm run usage -- <delegate-id-prefix> --tree     a task + all its sub-sessions
 *   npm run usage -- "executor-*"                    a simple glob
 */

const SESSIONS = join('.mjolnir', 'sessions');
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

interface Options {
  readonly target: string;
  readonly anchor?: string;
  readonly tree: boolean;
  readonly mermaid: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let target: string | undefined;
  let anchor: string | undefined;
  let tree = false;
  let mermaid = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') anchor = argv[++i];
    else if (a === '--tree') tree = true;
    else if (a === '--mermaid') mermaid = true;
    else if (!a.startsWith('--') && target === undefined) target = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (anchor === undefined && argv.includes('--from')) throw new Error('--from needs a value');
  if (target === undefined) throw new Error('a session name, path, glob, or --tree prefix is required');
  return { target, anchor, tree, mermaid };
}

/** Resolve a target to concrete log paths: a file, a bare name, a `*` glob, or (with --tree) a prefix. */
function resolveTargets(target: string, tree: boolean): string[] {
  const inDir = (pred: (f: string) => boolean): string[] =>
    existsSync(SESSIONS)
      ? readdirSync(SESSIONS).filter((f) => f.endsWith('.jsonl') && pred(f)).sort().map((f) => join(SESSIONS, f))
      : [];
  if (tree) return inDir((f) => f.startsWith(target));
  if (existsSync(target) && statSync(target).isFile()) return [target];
  const named = join(SESSIONS, target.endsWith('.jsonl') ? target : `${target}.jsonl`);
  if (existsSync(named)) return [named];
  if (target.includes('*')) {
    const re = new RegExp(`^${target.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return inDir((f) => re.test(f) || re.test(f.replace(/\.jsonl$/, '')));
  }
  return [];
}

function printTurns(turns: readonly TurnUsage[], showContext: boolean): void {
  const head = `${'#'.padStart(3)} ${'input'.padStart(7)} ${'output'.padStart(7)} ${'cacheRd'.padStart(10)} ${'cacheCr'.padStart(9)} ${'WEIGHTED'.padStart(11)}`;
  process.stdout.write(`${head}${showContext ? '  context' : ''}\n`);
  turns.forEach((t, i) => {
    const u = t.usage;
    const ctx = showContext && t.context ? `  [${t.context.role}] ${JSON.stringify(t.context.text.slice(0, 72))}` : '';
    process.stdout.write(
      `${String(i + 1).padStart(3)} ${fmt(u.inputTokens).padStart(7)} ${fmt(u.outputTokens).padStart(7)} ` +
        `${fmt(u.cacheReadTokens).padStart(10)} ${fmt(u.cacheCreationTokens).padStart(9)} ${fmt(t.weighted).padStart(11)}${ctx}\n`,
    );
  });
}

function printComposition(total: Usage, label: string): void {
  const w = weightedUsage(total);
  if (w === 0) return;
  const by = weightedByKind(total);
  process.stdout.write(`\n${label} (weighted ${fmt(w)}):\n`);
  const row = (name: string, val: number) =>
    process.stdout.write(`  ${name.padEnd(13)} ${fmt(val).padStart(13)}  ${(((val / w) * 100).toFixed(1)).padStart(5)}%\n`);
  row('input', by.input);
  row('output', by.output);
  row('cache-read', by.cacheRead);
  row('cache-create', by.cacheCreation);
}

function printMermaid(turns: readonly TurnUsage[], total: Usage, title: string): void {
  if (turns.length === 0) return;
  const bars = turns.map((t) => Math.round(t.weighted / 1000));
  const line = turns.map((t) => Math.round(weightedUsage({ ...t.usage, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) / 1000));
  const xs = turns.map((_, i) => `T${i + 1}`).join(', ');
  const ymax = Math.round(Math.max(1, ...bars) * 1.1);
  const by = weightedByKind(total);
  process.stdout.write(
    `\n\`\`\`mermaid\nxychart-beta\n    title "${title} - weighted/turn (k): bar=total, line=cache-create"\n` +
      `    x-axis [${xs}]\n    y-axis "Weighted (thousands)" 0 --> ${ymax}\n` +
      `    bar [${bars.join(', ')}]\n    line [${line.join(', ')}]\n\`\`\`\n`,
  );
  process.stdout.write(
    `\n\`\`\`mermaid\npie showData\n    title Weighted composition - ${fmt(weightedUsage(total))} total\n` +
      `    "cache-read" : ${Math.round(by.cacheRead)}\n    "cache-create" : ${Math.round(by.cacheCreation)}\n` +
      `    "output" : ${Math.round(by.output)}\n    "input" : ${Math.round(by.input)}\n\`\`\`\n`,
  );
}

function main(argv: readonly string[]): void {
  let opts: Options;
  try {
    opts = parseOptions(argv);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\nusage: npm run usage -- <session|path|glob|prefix> [--from TEXT] [--tree] [--mermaid]\n`);
    process.exitCode = 1;
    return;
  }

  const targets = resolveTargets(opts.target, opts.tree);
  if (targets.length === 0) {
    process.stderr.write(`error: no session logs matched "${opts.target}" under ${SESSIONS}\n`);
    process.exitCode = 1;
    return;
  }

  const multi = targets.length > 1;
  let grand: TurnUsage[] = [];
  let empties = 0;
  for (const path of targets) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const turns = parseTurns(lines, opts.anchor);
    if (turns === null) {
      process.stdout.write(`\n=== ${basename(path)} === (anchor not found; skipped)\n`);
      continue;
    }
    process.stdout.write(`\n=== ${basename(path)} - ${turns.length} turn(s) ===\n`);
    if (turns.length === 0) {
      process.stdout.write('  (no usage turns logged)\n');
      empties++;
    } else {
      printTurns(turns, !multi);
      const t = sumTurns(turns);
      process.stdout.write(`${'TOT'.padStart(3)} ${fmt(t.inputTokens).padStart(7)} ${fmt(t.outputTokens).padStart(7)} ${fmt(t.cacheReadTokens).padStart(10)} ${fmt(t.cacheCreationTokens).padStart(9)} ${fmt(weightedUsage(t)).padStart(11)}\n`);
    }
    grand = grand.concat(turns);
  }

  const gt = sumTurns(grand);
  if (multi) {
    process.stdout.write(`\n========== COMBINED (${targets.length} sessions, ${grand.length} turns) ==========\n`);
    process.stdout.write(`  WEIGHTED TOTAL = ${fmt(weightedUsage(gt))}   avg/turn ${fmt(grand.length ? weightedUsage(gt) / grand.length : 0)}\n`);
    if (empties > 0) {
      process.stdout.write(`  NOTE: ${empties} session(s) logged no usage (e.g. evaluators) -> true tree cost is HIGHER (see #232)\n`);
    }
  }
  printComposition(gt, multi ? 'COMBINED composition' : 'composition');
  if (!multi && grand.length > 0) {
    const sorted = [...grand].map((t) => t.weighted).sort((a, b) => a - b);
    process.stdout.write(`  avg/turn ${fmt(weightedUsage(gt) / grand.length)}   median ${fmt(sorted[Math.floor(sorted.length / 2)])}\n`);
  }

  if (opts.mermaid) printMermaid(grand, gt, multi ? `${opts.target} (combined)` : opts.target);
}

main(process.argv.slice(2));
