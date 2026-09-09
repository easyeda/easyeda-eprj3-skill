#!/usr/bin/env node
'use strict';
/**
 * add-netlabel.js — set the net name of an existing wire. There is no
 * standalone net-label record type: a label is the wire's NET attr.
 *
 *   add-netlabel --dir <project> --sch Schematic1 --sheet P1
 *                --net SIG --at 300,-470
 *
 * --at takes any point on the target wire (mil), e.g. one of its corners.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'net', desc: 'net name', required: true },
  { name: 'at', desc: 'point on the wire x,y (mil)', required: true }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-netlabel.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const [x, y] = opts.at.split(',').map(Number);
  if ([x, y].some((v) => Number.isNaN(v))) die(`bad --at "${opts.at}" (want x,y)`);

  const lines = E.readLines(file);
  const headIdx = E.lastDocHeadIndex(lines);
  const records = lines.map(E.parseRecord).filter(Boolean);

  const wires = new Map();
  for (const r of records.slice(headIdx + 1)) {
    if (r.type === 'WIRE') {
      wires.set(r.id, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    } else if (r.type === 'LINE' && r.body && r.body.lineGroup && wires.has(r.body.lineGroup)) {
      const w = wires.get(r.body.lineGroup);
      for (const px of [r.body.startX, r.body.endX]) {
        w.minX = Math.min(w.minX, px); w.maxX = Math.max(w.maxX, px);
      }
      for (const py of [r.body.startY, r.body.endY]) {
        w.minY = Math.min(w.minY, py); w.maxY = Math.max(w.maxY, py);
      }
    }
  }
  const hits = [...wires.entries()]
    .filter(([, w]) => x >= w.minX && x <= w.maxX && y >= w.minY && y <= w.maxY);
  if (!hits.length) die(`no wire covers point ${x},${y}`);
  if (hits.length > 1) die(`point ${x},${y} covers ${hits.length} wires; pick a point unique to one wire`);
  const [wireId] = hits[0];

  const updated = E.updateRecord(file,
    (r) => r.type === 'ATTR' && r.body && r.body.parentId === wireId && r.body.key === 'NET',
    (r) => { r.body.value = opts.net; });
  if (!updated) die(`wire ${wireId} has no NET attr`);
  project.save();
  console.log(`labeled wire ${wireId} as ${opts.net} in ${opts.sch}/${opts.sheet}`);
}

main();
