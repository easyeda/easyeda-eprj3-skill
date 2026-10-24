#!/usr/bin/env node
'use strict';
/**
 * validate.js — check an eprj3 folder project against the format invariants
 * derived from the official easyeda-pro-eprj3-format example:
 *
 *   - index JSON shape (folder format, 32-hex owner uuids, profile maps)
 *   - per-schematic container: 4-record .ecfg, .evar, sheet .esch2 files whose
 *     main doc (SCH_PAGE) uuid matches the index
 *   - sheet docs: every placed component's Device/Symbol attr must reference
 *     DEVICE/SYMBOL docs embedded in the same file
 *   - PCB docs: preamble with layers + empty NET + board outline; components'
 *     Device/Footprint links; PAD_NET ↔ NET/COMPONENT references
 *   - panel present; per-doc ticket uniqueness; doc uuid uniqueness
 *
 * This is the FORMAT gate. Electrical and geometric gates live in
 * scripts/erc.js, scripts/lint-layout.js and scripts/drc.js.
 *
 *   node scripts/validate.js --dir <project> [--json]
 *
 * Exit code 0 = clean, 1 = errors found (printed).
 */
const { runValidate } = require('./lib/checks');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'json', desc: 'print the result as JSON', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('validate.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const { errors, warnings } = runValidate(opts.dir);

  if (opts.json) {
    console.log(JSON.stringify({ errors, warnings }, null, 2));
  } else {
    for (const w of warnings) console.log(`warn: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);
    if (errors.length) console.error(`FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
    else console.log(`OK (0 errors, ${warnings.length} warning(s))`);
  }
  if (errors.length) process.exit(1);
}

main();
