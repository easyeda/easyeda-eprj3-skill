#!/usr/bin/env node
'use strict';
/**
 * add-power.js — place a staged power symbol (kind "power") on a schematic
 * sheet: VCC/GND rails and other global net flags.
 *
 *   add-power --dir <project> --sch Schematic1 --sheet P1 --lib VCC
 *             --x 280 --y -480
 *
 * Coordinates are mil. The global net name comes from the staged entry.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'lib', desc: 'staged library entry (kind power)', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-power.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const entry = project.loadLibrary(opts.lib);
  if (entry.kind !== 'power') die(`library entry "${opts.lib}" is kind "${entry.kind}", want "power"`);
  E.insertDocsBeforeMain(file, [entry.powerSymbolDoc, entry.powerDeviceDoc]);

  const lines = E.readLines(file);
  const block = E.powerComponentBlock({
    compId: E.randId(),
    x: Number(opts.x), y: Number(opts.y),
    zIndex: E.nextMainZIndex(lines),
    symbolUuid: entry.symbolUuid,
    deviceUuid: entry.deviceUuid,
    net: entry.net,
    style: entry.style,
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`placed power symbol ${entry.net} (${entry.style}) at ${opts.x},${opts.y} in ${opts.sch}/${opts.sheet}`);
}

main();
