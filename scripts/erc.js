#!/usr/bin/env node
'use strict';
/**
 * erc.js — electrical rule check, from the command line.
 *
 *   node scripts/erc.js --dir <project> [--design design.json] [--json] [--strict]
 *
 * Without --design it checks what it can prove from the project alone
 * (unconnected pins, dead-end nets, duplicates, PCB↔schematic agreement). With
 * --design it also diffs the built netlist against the intended one, which is
 * the check that catches "the wires went somewhere else".
 *
 * Exit 1 when there is an error (or a warning with --strict).
 */
const D = require('./lib/design');
const { runErc } = require('./lib/erc');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'design', desc: 'design.json to diff the netlist against' },
  { name: 'json', desc: 'machine-readable output', hasValue: false },
  { name: 'strict', desc: 'treat warnings as errors', hasValue: false },
  { name: 'no-pcb', desc: 'skip the schematic↔PCB comparison', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('erc.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  let design;
  if (opts.design) {
    try {
      design = D.readDesign(opts.design);
    } catch (e) {
      die(e.message);
    }
  }
  const r = runErc(opts.dir, { design, pcb: !opts['no-pcb'] });

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const w of r.warnings) console.log(`warn ${w.id}: ${w.msg}`);
    for (const e of r.errors) console.error(`error ${e.id}: ${e.msg}`);
    if (r.errors.length) console.error(`ERC FAILED: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
    else console.log(`ERC OK (0 errors, ${r.warnings.length} warning(s))`);
  }
  if (r.errors.length || (opts.strict && r.warnings.length)) process.exit(1);
}

main();
