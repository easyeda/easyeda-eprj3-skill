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
 *   copper   drc score    0-100
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
const { execFileSync } = require('child_process');
const { parseArgs, printHelp } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const SCHEMA = [
  { name: 'all', desc: 'run every case (default)', hasValue: false },
  { name: 'case', desc: 'run one case by file name (without .json)' },
  { name: 'json', desc: 'machine-readable output', hasValue: false },
  { name: 'no-history', desc: 'do not append to eval/history.jsonl', hasValue: false },
  { name: 'timeout', desc: 'per-case build timeout in seconds (default 90)' },
  { name: 'keep', desc: 'keep the built projects under eval/.build', hasValue: false },
  { name: 'min-score', desc: 'override the minimum lint/drc score for all cases' }
];
const DEFAULTS = { minLint: 85, minDrc: 80, maxSeconds: 20 };

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
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function run(cmd, args, timeoutMs) {
  const t0 = Date.now();
  let ok = true;
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, cmd)].concat(args), {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    ok = false;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  return { ok, out, ms: Date.now() - t0 };
}

function scoreOf(text) {
  const m = /score (\d+)\/100/.exec(text);
  return m ? Number(m[1]) : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '-h' || argv[0] === '--help') {
    printHelp('eval.js [options]', SCHEMA,
      'Builds every design under recipe/ and examples/designs/ and scores all four gates. No arguments = run everything.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const cfgFile = path.join(ROOT, 'eval', 'cases.json');
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  let list = cases(cfg);
  if (opts.case) list = list.filter((c) => c.name.endsWith(`/${opts.case}`) || c.name === opts.case);
  if (!list.length) {
    console.error('no cases matched');
    process.exit(2);
  }
  const timeoutSec = opts.timeout !== undefined ? Number(opts.timeout) : 120;
  const buildDir = path.join(ROOT, 'eval', '.build');
  fs.mkdirSync(buildDir, { recursive: true });
  const results = [];

  for (const c of list) {
    const name = path.basename(c.file, '.json');
    const target = path.join(buildDir, name);
    fs.rmSync(target, { recursive: true, force: true });
    const build = run('scripts/build.js', ['--design', c.file, '--dir', target, '--report',
      path.join(buildDir, `${name}.report.json`)], timeoutSec * 1000);
    const validate = build.ok ? run('scripts/validate.js', ['--dir', target], 30000) : { ok: false, out: '' };
    const erc = build.ok ? run('scripts/erc.js', ['--dir', target, '--design', c.file], 60000) : { ok: false, out: '' };
    const lint = build.ok ? run('scripts/lint-layout.js', ['--dir', target, '--json'], 60000) : { ok: false, out: '' };
    const drc = build.ok ? run('scripts/drc.js', ['--dir', target, '--json'], 60000) : { ok: false, out: '' };

    const parse = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
    const lintJ = parse(lint);
    const drcJ = parse(drc);
    const minLint = opts['min-score'] !== undefined ? Number(opts['min-score']) : c.minLint;
    const minDrc = opts['min-score'] !== undefined ? Number(opts['min-score']) : c.minDrc;

    const seconds = Math.round(build.ms / 100) / 10;
    const row = {
      case: c.name,
      ok: build.ok && validate.ok && erc.ok && lint.ok && drc.ok
        && (lintJ ? lintJ.score >= minLint : true)
        && (drcJ ? drcJ.score >= minDrc : true)
        && seconds <= c.maxSeconds,
      build: { ok: build.ok, seconds },
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
        + `lint ${String(row.lint).padStart(3)}  drc ${String(row.drc).padStart(3)}  `
        + `${row.erc ? 'erc ok' : 'erc FAIL'}  ${row.validate ? 'format ok' : 'format FAIL'}`);
    }
  }

  const pass = results.filter((r) => r.ok).length;
  const summary = {
    at: new Date().toISOString(),
    version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    total: results.length,
    passed: pass,
    failed: results.length - pass,
    results
  };
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n${pass}/${results.length} cases pass  (avg lint `
      + `${Math.round(results.reduce((n, r) => n + (r.lint || 0), 0) / results.length)}, avg drc `
      + `${Math.round(results.reduce((n, r) => n + (r.drc || 0), 0) / results.length)})`);
  }
  if (!opts['no-history']) {
    fs.mkdirSync(path.join(ROOT, 'eval'), { recursive: true });
    fs.appendFileSync(path.join(ROOT, 'eval', 'history.jsonl'), JSON.stringify(summary) + '\n');
  }
  if (pass !== results.length) process.exit(1);
}

main();
