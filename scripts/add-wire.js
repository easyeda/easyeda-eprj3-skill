#!/usr/bin/env node
'use strict';
/**
 * add-wire.js — draw a wire (one WIRE record + its LINE segments) on a
 * schematic sheet, with an optional net label carried by the wire's NET attr.
 *
 *   add-wire --dir <project> --sch Schematic1 --sheet P1
 *            --segs "300,-470,300,-470;..." [--net SIG]
 *
 * Segments are ';'-separated "x1,y1,x2,y2" in mil. Orthogonal segments only —
 * the client's wires are drawn on the 100 mil grid.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'segs', desc: 'segments x1,y1,x2,y2;... (mil)', required: true },
  { name: 'net', desc: 'net name to label the wire with' }
];

function parseSegs(spec) {
  return spec.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = s.split(',').map(Number);
    if (p.length !== 4 || p.some((v) => Number.isNaN(v))) die(`bad segment "${s}" (want x1,y1,x2,y2)`);
    return { startX: p[0], startY: p[1], endX: p[2], endY: p[3] };
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-wire.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const lines = E.readLines(file);
  const segs = parseSegs(opts.segs);
  const block = E.wireBlock({
    segs,
    net: opts.net,
    zIndex: E.nextMainZIndex(lines),
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`drew wire (${segs.length} segment${segs.length === 1 ? '' : 's'}${opts.net ? `, net ${opts.net}` : ''}) in ${opts.sch}/${opts.sheet}`);
  console.log(`  wire id: ${block.wireId}`);
}

main();
