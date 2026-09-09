#!/usr/bin/env node
'use strict';
/**
 * add-prop.js — attach extra properties (PROP record) to a PCB primitive.
 *
 *   add-prop --dir <project> --pcb PCB1 --target <record-id> --color "#FF0000"
 *   add-prop --dir <project> --pcb PCB1 --last --color "#00FF00"
 *
 * The PROP record id IS the target element's id. With --last the target is the
 * last main-doc record carrying a 16-hex id. The body currently carries only
 * color (docs-specified; no real sample exists).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'target', desc: 'record id of the target primitive' },
  { name: 'last', desc: 'target the last main-doc record with an id (flag)', hasValue: false },
  { name: 'color', desc: 'color value, e.g. "#FF0000"', required: true }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-prop.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  const lines = E.readLines(file);
  let target = opts.target;
  if (opts.last) {
    if (target !== undefined) die('use either --target or --last, not both');
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = E.parseRecord(lines[i]);
      if (r && typeof r.id === 'string' && /^[0-9a-f]{16}$/.test(r.id)) { target = r.id; break; }
    }
    if (!target) die('no record with a 16-hex id found in the PCB document');
  }
  if (target === undefined) die('--target <record-id> or --last is required');
  if (!lines.some((l) => { const r = E.parseRecord(l); return r && r.id === target; })) {
    die(`no record with id "${target}" in ${file}`);
  }

  E.appendLines(file, [E.pcbPropLine({
    target,
    color: opts.color,
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`attached PROP (color ${opts.color}) to ${target} on ${opts.pcb}`);
}

main();
