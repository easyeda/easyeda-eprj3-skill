#!/usr/bin/env node
'use strict';
/**
 * add-via.js — place a via (VIA record) on a PCB document.
 *
 *   add-via --dir <project> --pcb PCB1 --x 700 --y 316.54 [--net SIG]
 *          [--via-diameter 24.0158] [--hole-diameter 12.0078] [--rule viaSize]
 *
 * Coordinates are mil. Defaults follow the example project's PREFERENCE
 * (via 24.0158 mil / hole 12.0078 mil ≈ 0.6 mm / 0.3 mm). A --net names the
 * net (a NET record is inserted after the empty NET if missing).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'net', desc: 'net name' },
  { name: 'via-diameter', desc: 'outer diameter mil (default 24.0158)' },
  { name: 'hole-diameter', desc: 'drill diameter mil (default 12.0078)' },
  { name: 'rule', desc: 'via rule name (default viaSize)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-via.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  if (opts.net) E.ensurePcbNets(file, [opts.net]);
  const lines = E.readLines(file);
  E.appendLines(file, [E.pcbViaLine({
    netName: opts.net,
    x: Number(opts.x), y: Number(opts.y),
    viaDiameter: opts['via-diameter'] !== undefined ? Number(opts['via-diameter']) : undefined,
    holeDiameter: opts['hole-diameter'] !== undefined ? Number(opts['hole-diameter']) : undefined,
    ruleName: opts.rule,
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`placed via at ${opts.x},${opts.y} on ${opts.pcb}${opts.net ? ` (net ${opts.net})` : ''}`);
}

main();
