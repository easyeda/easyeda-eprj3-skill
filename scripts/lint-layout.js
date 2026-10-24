#!/usr/bin/env node
'use strict';
/**
 * lint-layout.js — geometric / readability review.
 *
 *   node scripts/lint-layout.js --dir <project> [--json] [--strict] [--min-score 80]
 *
 * Reports overlapping symbols, wires crossing bodies, parts outside their
 * block frame, text on parts, off-grid coordinates and dangling wire ends, and
 * prints a 0-100 readability score. Exit 1 on any error finding (or when the
 * score is below --min-score).
 */
const { lintProject, RULES } = require('./lib/lint');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'json', desc: 'machine-readable output', hasValue: false },
  { name: 'strict', desc: 'treat warnings as errors', hasValue: false },
  { name: 'min-score', desc: 'fail when the readability score is below this (0-100)' },
  { name: 'rules', desc: 'print the rule table and exit', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('lint-layout.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  if (opts.rules) {
    for (const [code, r] of Object.entries(RULES)) {
      console.log(`${code}  ${r.level.padEnd(5)} -${String(r.weight).padStart(2)}  ${r.text}`);
    }
    return;
  }
  const r = lintProject(opts.dir);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const f of r.findings) {
      const out = f.level === 'error' ? console.error : console.log;
      out(`${f.level === 'error' ? 'error' : 'warn'} ${f.code}: ${f.msg}`);
    }
    for (const s of r.sheets) {
      console.log(`  ${s.sheet}: ${s.counts.parts} parts, ${s.counts.wires} wire segments, score ${s.score}`);
    }
    console.log(`layout score ${r.score}/100 (${r.errors} error(s), ${r.warnings} warning(s))`);
  }
  const min = opts['min-score'] !== undefined ? Number(opts['min-score']) : null;
  if (r.errors || (opts.strict && r.warnings) || (min !== null && r.score < min)) process.exit(1);
}

main();
