#!/usr/bin/env node
'use strict';
/**
 * netcheck.js — schematic ↔ PCB netlist comparison.
 *
 *   node scripts/netcheck.js --dir <project> [--json] [--quiet]
 *
 * Builds both netlists independently and diffs them pin by pin: every
 * schematic pin must have a PCB pad on the same net (and vice versa), no net
 * on one side only, no floating pins/pads. Exit 0 = match, 1 = mismatches.
 *
 * `build.js` runs this comparison as part of every build (verdict line +
 * report.netcheck); the standalone CLI re-runs it after hand edits in the
 * client too.
 */
const N = require('./lib/netlist');
const { compare } = require('./lib/netcheck');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'json', desc: 'machine-readable report', hasValue: false },
  { name: 'quiet', desc: 'only the final verdict line', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('netcheck.js [options]', SCHEMA,
      'Compare the schematic and PCB netlists pin by pin (exit 1 on any mismatch).');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const all = N.projectNetlist(opts.dir);
  const report = compare(all);
  const padTotal = report.summary.pcb.reduce((n, p) => n + p.pads, 0);
  const verdict = report.match
    ? `netcheck: OK — schematic and PCB netlists match (${report.summary.schematic.pins} pins ↔ ${padTotal} pads)`
    : `netcheck: ${report.issues.length} mismatch(es) between schematic and PCB`;
  if (opts.json) {
    // machine-readable: JSON only, the exit code carries the verdict
    console.log(JSON.stringify(report, null, 2));
  } else if (!opts.quiet) {
    console.log(`schematic: ${report.summary.schematic.pins} pins / ${report.summary.schematic.nets} nets / ${report.summary.schematic.parts} parts`);
    for (const p of report.summary.pcb) console.log(`pcb ${p.pcb}: ${p.pads} pads`);
    for (const i of report.issues) {
      console.log(`✗ ${i.code}: ${i.msg}`);
      if (i.fix) console.log(`    fix: ${i.fix}`);
    }
    console.log(verdict);
  } else {
    console.log(verdict);
  }
  process.exit(report.match ? 0 : 1);
}

main();
