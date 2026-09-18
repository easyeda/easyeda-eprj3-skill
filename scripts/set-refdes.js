#!/usr/bin/env node
'use strict';
/**
 * set-refdes.js — rename or renumber reference designators on a schematic
 * sheet and/or PCB document.
 *
 *   set      --dir <project> (--sch S1 --sheet P1 | --pcb PCB1)
 *            --designator R1 --value R5
 *   renumber --dir <project> (--sch S1 --sheet P1 | --pcb PCB1)
 *            --prefix R [--start 1]
 *
 * "renumber" reassigns sequential designators (R1, R2, ...) in placement
 * order to every component whose current designator matches the prefix
 * ("R1", "R12" or the "R?" placeholder).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name (with --sheet)' },
  { name: 'sheet', desc: 'sheet title (with --sch)' },
  { name: 'pcb', desc: 'PCB title (schematic OR pcb required)' },
  { name: 'designator', desc: 'current designator (set)' },
  { name: 'value', desc: 'new designator (set)' },
  { name: 'prefix', desc: 'designator prefix (renumber)' },
  { name: 'start', desc: 'first number (renumber, default 1)' }
];

function targetFile(project, opts) {
  if (opts.sch && opts.sheet) {
    const { sheet } = project.requireSheet(opts.sch, opts.sheet);
    const file = project.sheetFile(sheet);
    if (!fs.existsSync(file)) die(`sheet document missing: ${file}`);
    return file;
  }
  if (opts.pcb) {
    const pcb = project.requirePcb(opts.pcb);
    const file = project.pcbFile(pcb);
    if (!fs.existsSync(file)) die(`PCB document missing: ${file}`);
    return file;
  }
  die('specify a target: --sch <name> --sheet <title>, or --pcb <title>');
  return null;
}

// Only the main document (everything after the last DOCHEAD) is renamed —
// embedded SYMBOL docs in the same file carry placeholder Designator attrs
// ("R?") that must stay untouched.
function mainRecordBounds(file) {
  const records = E.readRecords(file);
  let from = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'DOCHEAD') { from = i + 1; break; }
  }
  return { records, from };
}

function cmdSet(file, opts) {
  if (!opts.designator || !opts.value) die('set needs --designator <old> --value <new>');
  const { records, from } = mainRecordBounds(file);
  let n = 0;
  for (let i = from; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'ATTR' && r.body && r.body.key === 'Designator'
      && r.body.parentId && r.body.value === opts.designator) { r.body.value = opts.value; n++; }
  }
  if (!n) die(`no component with designator "${opts.designator}" found`);
  E.writeRecords(file, records);
  console.log(`renamed ${opts.designator} -> ${opts.value} (${n} record${n === 1 ? '' : 's'})`);
}

function cmdRenumber(file, opts) {
  if (!opts.prefix) die('renumber needs --prefix <letter(s)>');
  const start = Number(opts.start || 1);
  const pat = new RegExp(`^${opts.prefix}(\\?|\\d*)$`);
  const lines = E.readLines(file);
  const headIdx = E.lastDocHeadIndex(lines);
  const records = lines.map(E.parseRecord).filter(Boolean);

  const targets = [];
  for (const r of records.slice(headIdx + 1)) {
    if (r.type === 'ATTR' && r.body && r.body.key === 'Designator'
      && r.body.parentId && pat.test(String(r.body.value))) {
      targets.push(r);
    }
  }
  if (!targets.length) die(`no designators matching prefix "${opts.prefix}"`);
  targets.forEach((r, i) => { r.body.value = `${opts.prefix}${start + i}`; });
  E.writeRecords(file, records);
  console.log(`renumbered ${targets.length} component(s): ${opts.prefix}${start} .. ${opts.prefix}${start + targets.length - 1}`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('set-refdes.js <set|renumber> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  const project = E.Project.load(opts.dir);
  const file = targetFile(project, opts);
  if (cmd === 'set') cmdSet(file, opts);
  else if (cmd === 'renumber') cmdRenumber(file, opts);
  else die(`unknown command "${cmd}" (want: set | renumber)`);
  project.save();
}

main();
