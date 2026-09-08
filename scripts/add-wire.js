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
 * The wire is emitted as one WIRE record (group container) plus N LINE records
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
  const sch = project.ensureSchematic(opts.schematic);
  const sheet = project.ensureSheet(sch, opts.sheet);
  const file = project.sheetFile(sheet);

  const pts = opts.points.split(';').map(p => p.split(',').map(parseFloat));
  if (pts.length < 2) die('--points needs at least 2 points');
  const wireId = randId();
  const { readRecords, writeRecords } = require('./lib/eprj3');
  // Insert WIRE with the id we control, then LINEs referencing that id.
  const records = readRecords(file);
  const maxTicket = records.reduce((m, r) => Math.max(m, r.ticket || 0), 0);
  records.push({ head: { type: 'WIRE', ticket: maxTicket + 1, id: wireId }, body: { zIndex: 1 }, ticket: maxTicket + 1, id: wireId, type: 'WIRE' });
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    records.push({
      head: { type: 'LINE', ticket: maxTicket + 2 + i, id: randId() },
      body: {
        fillColor: null, fillStyle: null,
        strokeColor: opts.stroke, strokeStyle: 'SOLID', strokeWidth: parseFloat(opts.width),
        startX: x1, startY: y1, endX: x2, endY: y2, lineGroup: wireId
      },
      ticket: maxTicket + 2 + i, id: randId(), type: 'LINE'
    });
  }
  writeRecords(file, records);

  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    appendRecord(file, 'LINE', {
      fillColor: null, fillStyle: null,
      strokeColor: opts.stroke, strokeStyle: 'SOLID', strokeWidth: parseFloat(opts.width),
      startX: x1, startY: y1, endX: x2, endY: y2, lineGroup: wireId
    });
  }
  console.log(`Added wire ${wireId} with ${pts.length - 1} segments on ${opts.schematic}/${opts.sheet}`);
}

main().catch(err => die(err.message, 1));