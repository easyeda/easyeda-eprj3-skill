#!/usr/bin/env node
'use strict';
/**
 * add-wire.js — Draw a polyline wire on a schematic sheet.
 *
 * Usage:
 *   node scripts/add-wire.js add \
 *     --dir <projectDir> --schematic <schName> --sheet <sheetTitle> \
 *     --points "x1,y1;x2,y2;x3,y3"
 *
 * The wire is emitted as one WIRE record (group container) plus N-1 LINE records
 * sharing its `lineGroup` id. Coordinates are in mil.
 */
const path = require('path');
const { Project, randId, appendRecord } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root directory' },
  { name: 'schematic', alias: 's', hasValue: true, required: true, desc: 'Schematic name' },
  { name: 'sheet', alias: 'p', hasValue: true, required: true, desc: 'Sheet title' },
  { name: 'points', hasValue: true, required: true, desc: 'Semicolon-separated "x,y" pairs in mil' },
  { name: 'stroke', hasValue: true, default: '#000000', desc: 'Stroke color' },
  { name: 'width', hasValue: true, default: '1', desc: 'Stroke width (mil)' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('add-wire.js add [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'add') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const file = project.ensureSheetDocument(opts.schematic, opts.sheet);

  const pts = opts.points.split(';').map(p => p.split(',').map(Number));
  if (pts.length < 2) die('--points needs at least 2 points');
  if (pts.some(p => p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    die(`Invalid --points: "${opts.points}" (expected "x1,y1;x2,y2;..." with numeric mil coordinates)`);
  }

  const wireId = randId();
  appendRecord(file, 'WIRE', { zIndex: 1 }, undefined, wireId);
  for (let i = 0; i < pts.length - 1; i++) {
    appendRecord(file, 'LINE', {
      fillColor: null, fillStyle: null,
      strokeColor: opts.stroke, strokeStyle: 'SOLID', strokeWidth: parseFloat(opts.width),
      startX: pts[i][0], startY: pts[i][1], endX: pts[i + 1][0], endY: pts[i + 1][1], lineGroup: wireId
    });
  }
  console.log(`Added wire ${wireId} with ${pts.length - 1} segments on ${opts.schematic}/${opts.sheet}`);
}

main().catch(err => die(err.message, 1));
