#!/usr/bin/env node
'use strict';
/**
 * intent.js — design-intent gate (the fifth gate), from the command line.
 *
 *   node scripts/intent.js --design design.json [--json] [--strict]
 *
 * Checks what the other gates cannot: mistakes that live in design.json
 * itself. Polarity marks, decoupling, declared differential pairs, value
 * ranges and divider ratios — see scripts/lib/intent.js for the rule table.
 *
 * Exit 1 on an error (or a warning with --strict).
 */
const fs = require('fs');
const D = require('./lib/design');
const { runIntent, I_RULES } = require('./lib/intent');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'design', desc: 'design.json to check', required: true },
  { name: 'json', desc: 'machine-readable output', hasValue: false },
  { name: 'strict', desc: 'treat warnings as errors', hasValue: false },
  { name: 'rules', desc: 'print the rule table and exit', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('intent.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  if (opts.rules) {
    for (const [code, r] of Object.entries(I_RULES)) {
      console.log(`${code}  ${r.level.padEnd(5)} -${String(r.weight).padStart(2)}  ${r.text}`);
    }
    return;
  }
  const d = D.readDesign(opts.design);
  const r = runIntent(d);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const w of r.warnings) console.log(`warn ${w.id}: ${w.msg}${w.fix ? `\n  fix: ${w.fix}` : ''}`);
    for (const e of r.errors) console.error(`error ${e.id}: ${e.msg}${e.fix ? `\n  fix: ${e.fix}` : ''}`);
    if (r.errors.length) console.error(`INTENT FAILED: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
    else console.log(`INTENT OK (0 errors, ${r.warnings.length} warning(s), ${r.checks.length} rule(s) applied)`);
  }
  if (r.errors.length || (opts.strict && r.warnings.length)) process.exit(1);
}

main();
void fs;
