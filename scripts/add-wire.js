#!/usr/bin/env node
'use strict';
/** Write explicitly authored schematic wire segments without calculating a route. */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'segs', desc: 'segments x1,y1,x2,y2;... (mil)', required: true },
  { name: 'net', desc: 'net name to label the wire with' },
  { name: 'hide-net', desc: 'assign the net but hide its printed label (use next to a power flag to avoid duplicate text)', hasValue: false }
];

function parseSegs(spec) {
  const segments = spec.split(';').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) die('provide at least one explicit wire segment');
  return segments.map((s) => {
    const p = s.split(',').map((value) => value.trim() === '' ? NaN : Number(value));
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) die(`bad segment "${s}" (want x1,y1,x2,y2)`);
    return { startX: p[0], startY: p[1], endX: p[2], endY: p[3] };
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-wire.js [options]', SCHEMA,
      'Draw explicit segments (--segs). Use pins.js to inspect exact connection points.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const segs = parseSegs(opts.segs);
  const lines = E.readLines(file);
  const block = E.wireBlock({
    segs,
    net: opts.net,
    netVisible: opts['hide-net'] ? false : undefined,
    zIndex: E.nextMainZIndex(lines),
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`drew wire (${segs.length} segment${segs.length === 1 ? '' : 's'}${opts.net ? `, net ${opts.net}` : ''}) in ${opts.sch}/${opts.sheet}`);
  console.log(`  wire id: ${block.wireId}`);
}

main();
