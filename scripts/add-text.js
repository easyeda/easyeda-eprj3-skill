#!/usr/bin/env node
'use strict';
/**
 * add-text.js — place free text (TEXT record) on a schematic sheet.
 * For PCB text (STRING record) use add-pcb-text.js — the two records have
 * different bodies.
 *
 *   add-text --dir <project> --sch Schematic1 --sheet P1
 *            --value "5V rail" --x 300 --y -300 [--rotation 0] [--size 10]
 *           [--align CENTER_MIDDLE]
 *
 * Coordinates are mil. The TEXT body shape is quoted from the official
 * example (x/y/rotation/align/value; fontSize null = client default).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'value', desc: 'text content', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'rotation', desc: 'rotation degrees CCW (default 0)' },
  { name: 'size', desc: 'font size (default null = client default)' },
  { name: 'align', desc: 'e.g. CENTER_MIDDLE / LEFT_BOTTOM (default null)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-text.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const lines = E.readLines(file);
  E.appendLines(file, [E.schTextLine({
    x: Number(opts.x), y: Number(opts.y),
    value: opts.value,
    rotation: opts.rotation !== undefined ? Number(opts.rotation) : 0,
    fontSize: opts.size !== undefined ? Number(opts.size) : undefined,
    align: opts.align,
    zIndex: E.nextMainZIndex(lines),
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`placed text "${opts.value}" at ${opts.x},${opts.y} in ${opts.sch}/${opts.sheet}`);
}

main();
