#!/usr/bin/env node
'use strict';
/**
 * add-text.js — Free text annotation on schematic or PCB.
 */
const path = require('path');
const { Project, appendRecord } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'kind', alias: 'k', hasValue: true, default: 'schematic', desc: '"schematic" or "pcb"' },
  { name: 'doc', hasValue: true, required: true, desc: 'Schematic/PCB name' },
  { name: 'sheet', alias: 'p', hasValue: true, desc: 'Sheet title (schematic only)' },
  { name: 'text', alias: 't', hasValue: true, required: true, desc: 'Text content' },
  { name: 'x', hasValue: true, default: '0', desc: 'X (mil)' },
  { name: 'y', hasValue: true, default: '0', desc: 'Y (mil)' },
  { name: 'size', hasValue: true, default: '12', desc: 'Font size' },
  { name: 'color', hasValue: true, default: '#000000', desc: 'Color' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('add-text.js add [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'add') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  let file;
  if (opts.kind === 'schematic') {
    const sch = project.ensureSchematic(opts.doc);
    const sheet = project.ensureSheet(sch, opts.sheet || 'P1');
    file = project.sheetFile(sheet);
  } else {
    const pcb = project.ensurePcb(opts.doc);
    file = project.pcbFile(pcb);
  }

  appendRecord(file, 'TEXT', {
    x: parseFloat(opts.x), y: parseFloat(opts.y),
    color: opts.color, fillColor: null,
    fontFamily: 'Arial', fontSize: parseFloat(opts.size),
    rotation: 0, align: 'LEFT_TOP', value: opts.text,
    locked: false, zIndex: 1
  });
  console.log(`Added text "${opts.text}" on ${opts.kind}/${opts.doc}`);
}

main().catch(err => die(err.message, 1));