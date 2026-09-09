#!/usr/bin/env node
'use strict';
/**
 * add-track.js — draw a copper track (LINE record) on a PCB document.
 *
 *   add-track --dir <project> --pcb PCB1 --net SIG
 *             --x1 300 --y1 300 --x2 600 --y2 300 [--width 10] [--layer 1]
 *
 * Coordinates are mil; default width 10 mil, top layer (1). A --net names the
 * net (a NET record is inserted after the empty NET if it does not exist yet).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'x1', desc: 'start x (mil)', required: true },
  { name: 'y1', desc: 'start y (mil)', required: true },
  { name: 'x2', desc: 'end x (mil)', required: true },
  { name: 'y2', desc: 'end y (mil)', required: true },
  { name: 'net', desc: 'net name' },
  { name: 'width', desc: 'track width (default 10)' },
  { name: 'layer', desc: 'layer id (default 1 = top)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-track.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  if (opts.net) E.ensurePcbNets(file, [opts.net]);
  const lines = E.readLines(file);
  const line = E.pcbTrackLine({
    netName: opts.net,
    layerId: opts.layer !== undefined ? Number(opts.layer) : 1,
    startX: Number(opts.x1), startY: Number(opts.y1),
    endX: Number(opts.x2), endY: Number(opts.y2),
    width: opts.width !== undefined ? Number(opts.width) : 10,
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, [line]);
  project.save();
  console.log(`drew track ${opts.x1},${opts.y1} -> ${opts.x2},${opts.y2} on ${opts.pcb}${opts.net ? ` (net ${opts.net})` : ''}`);
}

main();
