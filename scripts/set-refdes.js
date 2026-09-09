#!/usr/bin/env node
'use strict';
/**
 * set-refdes.js — Modify a reference designator (Designator ATTR) on a component.
 *
 * Usage:
 *   node scripts/set-refdes.js set --dir <projectDir> --kind schematic --doc <name> --sheet <sheetTitle> --from R1 --to R5A
 *   node scripts/set-refdes.js renumber --dir <projectDir> --kind schematic --doc <name> --sheet <sheetTitle> --prefix R
 *
 * The "renumber" subcommand auto-numbers all components whose designator is
 * exactly <prefix><digits> (R1, R2, R3, ...) based on record order.
 * This is a read/modify command: a wrong --doc/--sheet fails instead of
 * silently creating an empty document.
 */
const path = require('path');
const { Project, readRecords, writeRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'kind', alias: 'k', hasValue: true, default: 'schematic', desc: 'schematic or pcb' },
  { name: 'doc', hasValue: true, required: true, desc: 'Schematic/PCB name' },
  { name: 'sheet', alias: 'p', hasValue: true, desc: 'Sheet title (schematic only, default P1)' },
  { name: 'from', hasValue: true, desc: 'Current refdes (set subcommand)' },
  { name: 'to', hasValue: true, desc: 'New refdes (set subcommand)' },
  { name: 'prefix', hasValue: true, desc: 'Prefix to renumber (renumber subcommand)' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('set-refdes.js <set|renumber> [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'set' && sub !== 'renumber') die(`Unknown command: ${sub}. Use 'set' or 'renumber'.`);

  const project = await Project.load(path.resolve(opts.dir));
  let file;
  if (opts.kind === 'schematic') {
    const { sheet } = project.requireSheet(opts.doc, opts.sheet || 'P1');
    file = project.sheetFile(sheet);
  } else {
    file = project.pcbFile(project.requirePcb(opts.doc));
  }
  const records = readRecords(file);

  if (sub === 'set') {
    const oldRefdes = opts.from;
    const newRefdes = opts.to;
    if (!oldRefdes || !newRefdes) die('--from and --to are required');
    let changed = 0;
    for (const r of records) {
      if (r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === oldRefdes) {
        r.body.value = newRefdes;
        changed++;
      }
    }
    if (!changed) die(`No Designator ATTR with value "${oldRefdes}" found in ${file}`);
    writeRecords(file, records);
    console.log(`Renamed ${changed} refdes from ${oldRefdes} to ${newRefdes}`);
    return;
  }

  // renumber
  const prefix = opts.prefix;
  if (!prefix) die('--prefix is required');
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`);
  let counter = 1;
  for (const r of records) {
    if (r.type === 'ATTR' && r.body.key === 'Designator' && pattern.test(r.body.value)) {
      r.body.value = `${prefix}${counter++}`;
    }
  }
  writeRecords(file, records);
  console.log(`Renumbered ${counter - 1} components with prefix ${prefix}`);
}

main().catch(err => die(err.message, 1));
