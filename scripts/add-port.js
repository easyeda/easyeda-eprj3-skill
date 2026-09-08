#!/usr/bin/env node
'use strict';
/**
 * add-port.js — Add a port (sheet connector) on a schematic.
 */
const path = require('path');
const { Project, appendRecord } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'schematic', alias: 's', hasValue: true, required: true, desc: 'Schematic name' },
  { name: 'sheet', alias: 'p', hasValue: true, required: true, desc: 'Sheet title' },
  { name: 'name', alias: 'n', hasValue: true, required: true, desc: 'Port name' },
  { name: 'type', alias: 't', hasValue: true, default: 'INPUT', desc: 'Port type (INPUT, OUTPUT, BIDIR, ...)' },
  { name: 'x', hasValue: true, default: '0', desc: 'X (mil)' },
  { name: 'y', hasValue: true, default: '0', desc: 'Y (mil)' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('add-port.js add [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'add') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const sch = project.ensureSchematic(opts.schematic);
  const sheet = project.ensureSheet(sch, opts.sheet);
  const file = project.sheetFile(sheet);

  appendRecord(file, 'PORT', {
    x: parseFloat(opts.x), y: parseFloat(opts.y),
    rotation: 0, color: '#000000', fillColor: null, fontFamily: 'Arial', fontSize: 10,
    align: 'CENTER_MIDDLE', value: opts.name, portType: opts.type,
    locked: false, zIndex: 1
  });
  console.log(`Added ${opts.type} port "${opts.name}"`);
}

main().catch(err => die(err.message, 1));