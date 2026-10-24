#!/usr/bin/env node
'use strict';
/**
 * pins.js — list the exact connection points of a sheet.
 *
 * The point of this command is to stop an agent from deriving coordinates by
 * hand: every pin is printed with its absolute tip (mil), the direction the
 * stub leaves the body, and the net it is on. Feed those numbers straight into
 * add-wire --from/--to, or use the references and let the script do the math.
 *
 *   node scripts/pins.js --dir <project> [--sch Schematic1] [--sheet P1]
 *                        [--ref R1] [--json]
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const P = require('./lib/pins');
const N = require('./lib/netlist');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name (default: all)' },
  { name: 'sheet', desc: 'sheet title (default: all)' },
  { name: 'ref', desc: 'only this reference designator' },
  { name: 'json', desc: 'machine-readable output', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('pins.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const rows = [];
  for (const sheet of Object.values(project.profile.sheets)) {
    const sch = project.profile.schematics[sheet.schematic_uuid];
    if (!sch) continue;
    if (opts.sch && sch.name !== opts.sch) continue;
    if (opts.sheet && sheet.title !== opts.sheet) continue;
    const file = project.sheetFile(sheet);
    if (!fs.existsSync(file)) continue;
    const netlist = N.sheetNetlist(file);
    const netByPin = new Map();
    for (const n of netlist.nets) {
      for (const p of n.pins) netByPin.set(`${p.ref}.${p.num}`, n.name);
    }
    for (const c of P.sheetPins(file)) {
      if (opts.ref && c.ref !== opts.ref) continue;
      for (const pin of c.pins) {
        rows.push({
          sheet: `${sch.name}/${sheet.title}`,
          ref: c.ref,
          pin: pin.num,
          name: pin.name,
          x: pin.x,
          y: pin.y,
          dir: pin.dir.x > 0 ? 'right' : pin.dir.x < 0 ? 'left' : pin.dir.y > 0 ? 'up' : 'down',
          net: netByPin.get(`${c.ref}.${pin.num}`) || ''
        });
      }
    }
  }
  if (!rows.length) die('no pins matched (check --sch/--sheet/--ref)');
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  rows.forEach((r) => {
    console.log(`${r.ref}.${r.pin}`.padEnd(12)
      + `${r.name}`.padEnd(12)
      + `${String(r.x).padStart(8)},${String(r.y).padStart(8)}`.padEnd(20)
      + `${r.dir}`.padEnd(7)
      + (r.net || '-'));
  });
}

main();
