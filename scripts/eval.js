#!/usr/bin/env node
'use strict';
/**
 * eval.js — the regression + quality benchmark.
 *
 * Every design under `recipe/` and `examples/designs/` is built from scratch
 * into a temp directory and scored on the gates this skill promises:
 *
 *   format   validate.js  (0 errors)
 *   electric erc.js       (0 errors; warnings counted)
 *   layout   lint score   0-100
 *   drc      placement score 0-100
 *
 * Results are appended to `eval/history.jsonl`, so "is this iteration better?"
 * is a diff, not an opinion. A case fails when any gate has an error, when the
 * score drops below the threshold in `eval/cases.json`, or when the build takes
 * longer than its budget.
 *
 *   node scripts/eval.js [--all] [--case <name>] [--json] [--no-history]
 *                        [--timeout 60] [--keep]
 *
 * Exit 1 when any case fails.
 */
const fs = require('fs');
const path = require('path');
const { spawnCaptured } = require('../test/capture');
const { parseArgs, printHelp, readJson } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const SCHEMA = [
  { name: 'all', desc: 'run every case (default)', hasValue: false },
  { name: 'case', desc: 'run one case by file name (without .json)' },
  { name: 'design', desc: 'eval a single design file (e.g. one you just generated)' },
  { name: 'baseline', desc: 'with --design: compare scores against this case (default: none)' },
  { name: 'diff', desc: 'after the run (or standalone with --no-history? no: use --diff alone to compare the last two history entries)', hasValue: false },
  { name: 'since', desc: 'with --diff: compare against the n-th previous run (default 1)' },
  { name: 'json', desc: 'machine-readable output', hasValue: false },
  { name: 'no-history', desc: 'do not append to eval/history.jsonl', hasValue: false },
  { name: 'timeout', desc: 'per-case build timeout in seconds (default 90)' },
  { name: 'keep', desc: 'keep the built projects under eval/.build', hasValue: false },
  { name: 'min-score', desc: 'override the minimum lint/drc score for all cases' }
];
const DEFAULTS = { minLint: 85, minDrc: 80, maxSeconds: 20 };

/**
 * Build cases from the design corpus, plus one derived case per intake
 * requirement: the requirement is resolved through the real intake path into a
 * throwaway design.json, then measured with the same yardstick. That is what
 * makes "省 Token" a regression number instead of a claim — the token proxy of
 * the AI-authored file now includes the requirement + generated design.
 */
function cases(cfg) {
  const out = [];
  for (const dir of ['recipe', 'examples/designs']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const name = `${dir.split('/')[0]}/${f.replace(/\.json$/, '')}`;
      const over = (cfg && cfg[name]) || {};
      out.push({
        name,
        file: path.join(d, f),
        minLint: over.minLint !== undefined ? over.minLint : DEFAULTS.minLint,
        minDrc: over.minDrc !== undefined ? over.minDrc : DEFAULTS.minDrc,
        maxSeconds: over.maxSeconds !== undefined ? over.maxSeconds : DEFAULTS.maxSeconds
      });
    }
  }
  const reqDir = path.join(ROOT, 'examples', 'intake');
  if (fs.existsSync(reqDir)) {
    const I = require('./lib/intake');
    const tmpDir = path.join(ROOT, 'eval', '.intake');
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of fs.readdirSync(reqDir).filter((x) => x.endsWith('.req.json')).sort()) {
      const name = `intake/${f.replace(/\.req\.json$/, '')}`;
      const over = (cfg && cfg[name]) || {};
      const req = JSON.parse(stripBom(fs.readFileSync(path.join(reqDir, f), 'utf8')));
      let resolved;
      try {
        resolved = I.resolve(JSON.parse(JSON.stringify(req)), {});
      } catch (e) {
        // An incomplete requirement is a valid corpus entry: the gate that must
        // answer is intake itself, and `check` is what the run then exercises.
        out.push({ name, file: path.join(reqDir, f), requirement: true, error: e.message,
          intake: e.intake || null,
          minLint: over.minLint !== undefined ? over.minLint : DEFAULTS.minLint,
          minDrc: over.minDrc !== undefined ? over.minDrc : DEFAULTS.minDrc,
          maxSeconds: over.maxSeconds !== undefined ? over.maxSeconds : DEFAULTS.maxSeconds });
        continue;
      }
      const gen = path.join(tmpDir, `${f.replace(/\.req\.json$/, '')}.design.json`);
      fs.writeFileSync(gen, JSON.stringify(resolved.design, null, 2), 'utf8');
      out.push({
        name,
        file: gen,
        requirement: path.join(reqDir, f),
        minLint: over.minLint !== undefined ? over.minLint : DEFAULTS.minLint,
        minDrc: over.minDrc !== undefined ? over.minDrc : DEFAULTS.minDrc,
        maxSeconds: over.maxSeconds !== undefined ? over.maxSeconds : DEFAULTS.maxSeconds
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function stripBom(t) { return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; }

function run(cmd, args, timeoutMs) {
  const t0 = Date.now();
  const r = spawnCaptured(process.execPath, [path.join(ROOT, cmd)].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const ok = r.status === 0;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok, out, ms: Date.now() - t0 };
}

function scoreOf(text) {
  const m = /score (\d+)\/100/.exec(text);
  return m ? Number(m[1]) : null;
}

function historyEntries() {
  const f = path.join(ROOT, 'eval', 'history.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Print a per-case comparison of two runs; returns the regression count. */
function printDiff(prev, cur, opts) {
  const prevBy = new Map((prev.results || []).map((r) => [r.case, r]));
  let regressions = 0;
  const lines = [];
  for (const r of cur.results || []) {
    const p = prevBy.get(r.case);
    if (!p) { lines.push(`  +  ${r.case.padEnd(34)} new case — ${r.ok ? 'pass' : 'FAIL'}`); continue; }
    const dLint = (r.lint ?? 0) - (p.lint ?? 0);
    const dDrc = (r.drc ?? 0) - (p.drc ?? 0);
    const worse = (!r.ok && p.ok) || dLint < 0 || dDrc < 0;
    const better = (r.ok && !p.ok) || dLint > 0 || dDrc > 0;
    if (worse) regressions += 1;
    const flag = worse ? '  -' : better ? '  +' : '   ';
    lines.push(`${flag}  ${r.case.padEnd(34)} ok ${String(p.ok).padEnd(5)}→${String(r.ok).padEnd(5)}  `
      + `lint ${String(p.lint).padStart(3)}→${String(r.lint).padStart(3)} (${dLint >= 0 ? '+' : ''}${dLint})  `
      + `drc ${String(p.drc).padStart(3)}→${String(r.drc).padStart(3)} (${dDrc >= 0 ? '+' : ''}${dDrc})  `
      + `${(p.build.seconds ?? 0).toFixed(1)}s→${(r.build.seconds ?? 0).toFixed(1)}s`);
  }
  for (const r of (prev.results || [])) {
    if (!(cur.results || []).some((x) => x.case === r.case)) lines.push(`  -  ${r.case.padEnd(34)} removed from the suite`);
  }
  if (!opts.json) {
    console.log(`\ndiff vs ${prev.at} (${prev.passed}/${prev.total} passed):`);
    for (const l of lines) console.log(l);
    console.log(regressions ? `DIFF: ${regressions} case(s) regressed` : 'DIFF: no regressions');
  }
  return regressions;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '-h' || argv[0] === '--help') {
    printHelp('eval.js [options]', SCHEMA,
      'Builds every design under recipe/ and examples/designs/ and scores all four gates. No arguments = run everything. --diff alone compares the last two history entries.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);

  // Standalone --diff: compare two history entries, run nothing.
  // (--all --diff runs every case and diffs against the previous full run.)
  if (opts.diff && !opts.case && !opts.design && !opts.all) {
    const h = historyEntries();
    if (h.length < 2) {
      console.log(h.length ? 'diff: only one run in history — nothing to compare' : 'diff: history is empty');
      return;
    }
    const n = Math.max(1, Number(opts.since || 1));
    const prev = h[h.length - 1 - n];
    if (!prev) { console.log(`diff: no run ${n} runs back`); return; }
    const regressions = printDiff(prev, h[h.length - 1], opts);
    if (regressions) process.exit(1);
    return;
  }

  const cfgFile = path.join(ROOT, 'eval', 'cases.json');
  const cfg = fs.existsSync(cfgFile) ? readJson(cfgFile) : {};
  let list = cases(cfg);
  if (opts.design) {
    const f = path.resolve(opts.design);
    if (!fs.existsSync(f)) {
      console.error(`design file not found: ${f}`);
      process.exit(2);
    }
    const over = (cfg[`design/${path.basename(f, '.json')}`]) || {};
    list = [{
      name: `design/${path.basename(f, '.json')}`,
      file: f,
      minLint: over.minLint !== undefined ? over.minLint : DEFAULTS.minLint,
      minDrc: over.minDrc !== undefined ? over.minDrc : DEFAULTS.minDrc,
      maxSeconds: over.maxSeconds !== undefined ? over.maxSeconds : DEFAULTS.maxSeconds
    }];
  } else if (opts.case) list = list.filter((c) => c.name.endsWith(`/${opts.case}`) || c.name === opts.case);
  if (!list.length) {
    console.error('no cases matched');
    process.exit(2);
  }
  const timeoutSec = opts.timeout !== undefined ? Number(opts.timeout) : 120;
  const buildDir = path.join(ROOT, 'eval', '.build');
  fs.mkdirSync(buildDir, { recursive: true });
  const results = [];

  for (const c of list) {
    // Requirement-gate case: the requirement does not resolve, and the gate
    // under test is `intake check` — success means the missing *required*
    // fields are named (that is the 追问 protocol working, end to end).
    if (c.requirement && c.error) {
      const missing = c.intake ? c.intake.missing.map((m) => m.key) : [];
      const row = {
        case: c.name,
        ok: missing.length > 0,
        gate: 'intake',
        missingRequired: missing,
        tokens: Math.ceil(fs.statSync(c.file).size / 4),
        build: { ok: null, seconds: 0 },
        validate: null, erc: null, lint: null, drc: null,
        limits: null
      };
      results.push(row);
      if (!opts.json) {
        console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.case.padEnd(34)} intake gate  `
          + `missing: ${missing.join(', ') || 'none — protocol broken'}`);
      }
      continue;
    }
    const name = path.basename(c.file, '.json');
    const target = path.join(buildDir, name);
    fs.rmSync(target, { recursive: true, force: true });
    // The skill never lays copper: every case builds the same placement-only
    // deliverable and is scored on placement/format/electric quality.
    const build = run('scripts/build.js', ['--design', c.file, '--dir', target, '--report',
      path.join(buildDir, `${name}.report.json`)], timeoutSec * 1000);
    const validate = build.ok ? run('scripts/validate.js', ['--dir', target], 30000) : { ok: false, out: '' };
    const erc = build.ok ? run('scripts/erc.js', ['--dir', target, '--design', c.file], 60000) : { ok: false, out: '' };
    const lint = build.ok ? run('scripts/lint-layout.js', ['--dir', target, '--json'], 60000) : { ok: false, out: '' };
    const drc = build.ok ? run('scripts/drc.js', ['--dir', target, '--design', c.file, '--json'], 60000) : { ok: false, out: '' };

    const parse = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
    const lintJ = parse(lint);
    const drcJ = parse(drc);
    const minLint = opts['min-score'] !== undefined ? Number(opts['min-score']) : c.minLint;
    const minDrc = opts['min-score'] !== undefined ? Number(opts['min-score']) : c.minDrc;

    const seconds = Math.round(build.ms / 100) / 10;
    // The token proxy for "省 Token": what the AI must author is the design
    // file (a template+params fill), not the generated project; an intake case
    // adds the small requirement file too — that is the whole point of the
    // requirement→recipe path. bytes/4 is the standard rough estimate for
    // mixed JSON text. A case whose proxy grows between runs means the
    // workflow got wordier — visible, then fixed.
    let tokens = Math.ceil(fs.statSync(c.file).size / 4);
    if (c.requirement) tokens += Math.ceil(fs.statSync(c.requirement).size / 4);
    const row = {
      case: c.name,
      ok: build.ok && validate.ok && erc.ok && lint.ok && drc.ok
        && (lintJ ? lintJ.score >= minLint : true)
        && (drcJ ? drcJ.score >= minDrc : true)
        && seconds <= c.maxSeconds,
      build: { ok: build.ok, seconds },
      tokens,
      validate: validate.ok,
      erc: erc.ok,
      lint: lintJ ? lintJ.score : null,
      drc: drcJ ? drcJ.score : null,
      limits: { minLint, minDrc, maxSeconds: c.maxSeconds }
    };
    results.push(row);
    if (!opts.keep) fs.rmSync(target, { recursive: true, force: true });
    if (!opts.json) {
      const flag = row.ok ? 'PASS' : 'FAIL';
      console.log(`${flag}  ${row.case.padEnd(34)} ${String(seconds).padStart(6)}s  `
        + `~${String(tokens).padStart(4)}tok  `
        + `lint ${String(row.lint).padStart(3)}  drc ${String(row.drc).padStart(3)}  `
        + `${row.erc ? 'erc ok' : 'erc FAIL'}  ${row.validate ? 'format ok' : 'format FAIL'}`);
    }
  }

  const pass = results.filter((r) => r.ok).length;
  const totalSeconds = Math.round(results.reduce((n, r) => n + (r.build.seconds || 0), 0) * 10) / 10;
  const totalTokens = results.reduce((n, r) => n + (r.tokens || 0), 0);
  // Gate averages cover the cases that actually build and score;
  // the intake-gate case has none and must not drag the average to 0.
  const scored = results.filter((r) => r.lint !== null && r.lint !== undefined);
  const avg = (k) => (scored.length ? Math.round(scored.reduce((n, r) => n + (r[k] || 0), 0) / scored.length) : 0);
  const summary = {
    at: new Date().toISOString(),
    version: readJson(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed: pass,
    failed: results.length - pass,
    seconds: totalSeconds,
    tokens: totalTokens,
    results
  };
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n${pass}/${results.length} cases pass  (avg lint ${avg('lint')}, avg drc ${avg('drc')}, `
      + `${scored.length}/${results.length} scored)  `
      + `total ${totalSeconds}s, ~${totalTokens}tok authored`);
  }
  if (!opts['no-history']) {
    fs.mkdirSync(path.join(ROOT, 'eval'), { recursive: true });
    fs.appendFileSync(path.join(ROOT, 'eval', 'history.jsonl'), JSON.stringify(summary) + '\n');
  }
  if (opts.diff) {
    const h = historyEntries().filter((e) => e !== summary);
    const n = Math.max(1, Number(opts.since || 1));
    const prev = h[h.length - n];
    const regressions = prev ? printDiff(prev, summary, opts) : 0;
    if (pass === results.length && !regressions) return;
  }
  if (pass !== results.length) process.exit(1);
}

main();
