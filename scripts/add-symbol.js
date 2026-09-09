#!/usr/bin/env node
'use strict';
/**
 * add-symbol.js — place a staged device (kind "device") on a schematic sheet.
 *
 * Embeds the symbol/footprint/device docs into the sheet file (once) and
 * appends the component block (COMPONENT + linked ATTRs) at EOF.
 *
 *   add-symbol --dir <project> --sch Schematic1 --sheet P1 --lib <entry>
 *              --x 300 --y -400 [--refdes R1] [--rotation 0]
 *
 * Coordinates are mil. The designator defaults to the entry's placeholder
 * (e.g. "R?"); renumber later with set-refdes.js.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'lib', desc: 'staged library entry (kind device)', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'refdes', desc: 'reference designator' },
  { name: 'rotation', desc: '0 | 90 | 180 | 270 (default 0)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-symbol.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sch, sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const entry = project.loadLibrary(opts.lib);
  if (entry.kind !== 'device') die(`library entry "${opts.lib}" is kind "${entry.kind}", want "device"`);
  if (entry.footprintDoc) {
    E.insertDocsBeforeMain(file, [entry.symbolDoc, entry.footprintDoc, entry.deviceDoc]);
  } else {
    E.insertDocsBeforeMain(file, [entry.symbolDoc, entry.deviceDoc]);
  }

  const lines = E.readLines(file);
  const compId = E.randId();
  const block = E.schComponentBlock({
    compId,
    x: Number(opts.x), y: Number(opts.y),
    rotation: Number(opts.rotation || 0),
    zIndex: E.nextMainZIndex(lines),
    symbolUuid: entry.symbolUuid,
    deviceUuid: entry.deviceUuid,
    deviceName: entry.deviceTitle,
    footprintUuid: entry.footprintUuid || null,
    refdes: opts.refdes || entry.designator,
    uniqueId: E.nextUniqueId(lines),
    nameZ: entry.placement.nameZ,
    designatorZ: entry.placement.designatorZ,
    symbolZ: entry.placement.symbolZ,
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`placed ${opts.refdes || entry.designator} (${entry.deviceTitle}) at ${opts.x},${opts.y} in ${opts.sch}/${opts.sheet}`);
  console.log(`  component id: ${compId}`);
}

main();
