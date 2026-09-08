#!/usr/bin/env node
'use strict';
/**
 * add-netlabel.js — Drop a net label on a schematic sheet.
 *
 * Usage:
 *   node scripts/add-netlabel.js add \
 *     --dir <projectDir> --schematic <schName> --sheet <sheetTitle> \
 *     --name VCC --x 100 --y 200
 */
const path = require('path');
const { Project, appendRecord } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'schematic', alias: 's', hasValue: true, required: true, desc: 'Schematic name' },
  { name: 'sheet', alias: 'p', hasValue: true, required: true, desc: 'Sheet title' },
  { name: 'name', alias: 'n', hasValue: true, required: true, desc: 'Net name (e.g. VCC)' },
  { name: 'x', hasValue: true, default: '0', desc: 'X (mil)' },
  { name: 'y', hasValue: true, default: '0', desc: 'Y (mil)' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('add-netlabel.js add [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'add') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const sch = project.ensureSchematic(opts.schematic);
  const sheet = project.ensureSheet(sch, opts.sheet);
  const file = project.sheetFile(sheet);

  appendRecord(file, 'NETLABEL', {
    x: parseFloat(opts.x), y: parseFloat(opts.y),
    color: '#FF0000', fontFamily: 'Arial', fontSize: 12,
    align: 'CENTER_MIDDLE', value: opts.name, locked: false, zIndex: 1
  });
  console.log(`Added net label "${opts.name}" at ${opts.x},${opts.y}`);
}

main().catch(err => die(err.message, 1));