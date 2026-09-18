#!/usr/bin/env node
'use strict';
/**
 * add-pcb-text.js — place text (STRING record) on a PCB document.
 * For schematic text (TEXT record) use add-text.js — the two records have
 * different bodies.
 *
 *   add-pcb-text --dir <project> --pcb PCB1 --value "REV A"
 *                --x 2000 --y 2800 [--layer 1] [--size 60] [--angle 0]
 *               [--origin 4] [--mirror 0|1]
 *
 * Coordinates are mil. --origin picks the EAlign anchor: 0 left-bottom,
 * 1 mid-bottom, 2 right-bottom, 3 left-middle, 4 center, 5 right-middle,
 * 6 left-top, 7 mid-top, 8 right-top. Bottom-layer text defaults to mirror 1.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'value', desc: 'text content', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'layer', desc: 'layer id (default 1 = top)' },
  { name: 'size', desc: 'font size (default 60)' },
  { name: 'angle', desc: 'rotation angle (default 0)' },
  { name: 'origin', desc: 'anchor 0-8 (default 4 = center)' },
  { name: 'mirror', desc: 'mirror 0/1 (default: 1 on bottom layer)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-pcb-text.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  const lines = E.readLines(file);
  E.appendLines(file, [E.pcbStringLine({
    text: opts.value,
    x: Number(opts.x), y: Number(opts.y),
    layerId: opts.layer !== undefined ? Number(opts.layer) : 1,
    fontSize: opts.size !== undefined ? Number(opts.size) : undefined,
    origin: opts.origin !== undefined ? Number(opts.origin) : undefined,
    angle: opts.angle !== undefined ? Number(opts.angle) : undefined,
    mirror: opts.mirror !== undefined ? Number(opts.mirror) : undefined,
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`placed text "${opts.value}" at ${opts.x},${opts.y} on ${opts.pcb}`);
}

main();
