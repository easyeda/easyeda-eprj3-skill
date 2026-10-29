#!/usr/bin/env node
'use strict';
/**
 * make-board.js — the one-shot board workflow (report P0-3).
 *
 *   node scripts/make-board.js --design <design.json> --dir <project> [--report build.json] [--force]
 *
 * Pipeline: build (schematic + placement + 5 gates + netcheck) → netlist audit
 * package (the spec↔built view a fresh reviewer reads) → a brief JSON/one-line
 * digest. The AI writes only the design file and reads back the report — no
 * temp scripts, no verbose build logs on every iteration.
 */
const fs = require('fs');
const path = require('path');
const { spawnCaptured } = require('../test/capture');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'design', desc: 'design.json file (or use --gen)' },
  { name: 'gen', desc: 'generator module (A) => design — see lib/authoring.js' },
  { name: 'dir', desc: 'project directory to create', required: true },
  { name: 'report', desc: 'write the digest JSON here (default: <dir>/build.json)', hasValue: false },
  { name: 'force', desc: 'rebuild an existing project', hasValue: false },
  { name: 'quiet', desc: 'suppress the build stdout (report only)', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('make-board.js [options]', SCHEMA,
      'One-shot board workflow: build → digest report.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const dir = path.resolve(opts.dir);
  const reportFile = path.resolve(opts.report || path.join(dir, 'build.json'));

  // 1. build (all five gates + netcheck run inside)
  const buildArgs = [opts.gen ? '--gen' : '--design', path.resolve(opts.gen || opts.design), '--dir', dir, '--report', reportFile];
  if (opts.force) buildArgs.push('--force');
  const build = spawnCaptured(process.execPath, [path.join(__dirname, 'build.js'), ...buildArgs], { cwd: process.cwd(), encoding: 'utf8' });
  if (!opts.quiet) {
    process.stdout.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
  }

  // 2. netlist audit package — the self-contained spec↔built view a FRESH
  //    reviewer reads (SKILL.md "Netlist audit"). Written after the build's own
  //    .tmp cleanup so it survives until the reviewer has read it.
  let audit = null;
  if (build.status === 0 && (opts.design || opts.gen)) {
    try {
      const D = require('./lib/design');
      const A = require('./lib/audit');
      const design = D.readSource(opts.gen || opts.design, !!opts.gen);
      const pkg = A.buildPackage(dir, design);
      const file = path.join(dir, '.tmp', 'netlist-audit.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      audit = { ok: pkg.mechanical.ok, file };
    } catch (e) {
      audit = { ok: null, file: null, error: e.message };
    }
  }

  // 3. digest: the few things an AI actually needs
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { /* build failed earlier */ }
  const actions = [];
  if (report) {
    const push = (gate, list) => {
      for (const f of list || []) {
        actions.push({ gate, code: f.code || f.id || null, msg: f.msg, fix: f.fix || f.id ? f.fix : undefined });
      }
    };
    push('validate', report.validate && report.validate.errors);
    push('erc', report.erc && report.erc.errors);
    if (report.intent) push('intent', report.intent.errors);
    push('lint', report.lint && report.lint.findings.filter((f) => f.level === 'error'));
    push('drc', report.drc && report.drc.findings.filter((f) => f.level === 'error'));
    if (report.netcheck && !report.netcheck.match) push('netcheck', report.netcheck.issues);
  }
  const digest = {
    ok: build.status === 0 && (!actions.length) && (!audit || audit.ok !== false),
    exit: build.status,
    dir,
    report: reportFile,
    audit,
    scores: report ? {
      lint: report.lint && report.lint.score,
      drc: report.drc && report.drc.score,
      netcheck: report.netcheck ? (report.netcheck.match ? 'OK' : report.netcheck.issues.length) : null
    } : null,
    summary: (build.stdout || '').split('\n').filter((l) => /\.eprj3 at|dry run|plan only/.test(l)).pop() || null,
    rats: report && report.pcb ? report.pcb.rats : null,
    actions
  };
  fs.writeFileSync(reportFile, JSON.stringify(digest, null, 2) + '\n', 'utf8');
  let verdict;
  if (!digest.ok) {
    verdict = audit && audit.ok === false
      ? `make-board: netlist audit FAILED — ${audit.file}`
      : `make-board: ${actions.length} action(s) needed — read ${reportFile}`;
  } else {
    const note = audit ? (audit.ok === null ? ' · audit error (built-only)' : ' · audit OK') : '';
    verdict = `make-board: OK — ${digest.summary || dir}${note}`;
  }
  console.log(verdict);
  process.exit(digest.ok ? 0 : 1);
}

main();
