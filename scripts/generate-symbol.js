#!/usr/bin/env node
'use strict';
/**
 * generate-symbol.js — Build a basic SYMBOL from a pin list and emit it into the project.
 *
 * Usage:
 *   node scripts/generate-symbol.js from-pins \
 *     --dir <projectDir> --name <symbolName> \
 *     --pins "1,IN-,2,IN+,3,VCC,4,OUT" --bbox 50,50
 *
 * Each pin takes "number,name" pair; default pins sit on the right edge
 * pointing left. Bounding box defaults to 50x50 mil.
 */
const path = require('path');
const fs = require('fs');
const { Project, uuid, randId, writeRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'name', alias: 'n', hasValue: true, required: true, desc: 'Symbol name (file basename)' },
  { name: 'pins', hasValue: true, required: true, desc: 'Comma-flattened "number,name;number,name..."' },
  { name: 'bbox-w', hasValue: true, default: '60', desc: 'Body width' },
  { name: 'bbox-h', hasValue: true, default: '40', desc: 'Body height' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('generate-symbol.js from-pins [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'from-pins') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const tokens = opts.pins.split(',').map(s => s.trim());
  if (tokens.length % 2 !== 0) die('--pins must have an even number of comma-separated tokens');
  const pins = [];
  for (let i = 0; i < tokens.length; i += 2) pins.push({ number: tokens[i], name: tokens[i + 1] });

  const W = parseFloat(opts['bbox-w']);
  const H = parseFloat(opts['bbox-h']);
  const partId = 'pid' + randId();
  const records = [];
  let ticket = 1;
  records.push({ head: { type: 'DOCHEAD' }, body: { docType: 'SYMBOL', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } });
  records.push({ head: { type: 'META', ticket: ++ticket, id: 'META' }, body: { title: opts.name, description: '', tags: [], docType: 2, source: '' } });
  records.push({ head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' }, body: { originX: 0, originY: 0 } });
  records.push({ head: { type: 'PART', ticket: ++ticket, id: partId }, body: { BBOX: [-W, -H, W, H], title: opts.name } });
  records.push({ head: { type: 'RECT', ticket: ++ticket, id: 'e' + randId() }, body: { partId, groupId: '', locked: false, zIndex: ticket, dotX1: -W, dotY1: -H, dotX2: W, dotY2: H, radiusX: 0, radiusY: 0, rotation: 0, strokeColor: '#000000', strokeStyle: 'SOLID', fillColor: null, strokeWidth: 1, fillStyle: 'NONE' } });

  const N = pins.length;
  const spacing = (2 * H) / Math.max(N, 1);
  pins.forEach((p, i) => {
    const y = -H + spacing * (i + 0.5);
    const pinId = 'e' + randId();
    records.push({ head: { type: 'PIN', ticket: ++ticket, id: pinId }, body: { partId, groupId: '', locked: false, zIndex: ticket, display: true, x: W, y, length: 10, rotation: 180, color: null, pinShape: 'NONE' } });
    records.push({ head: { type: 'ATTR', ticket: ++ticket, id: 'e' + randId() }, body: { partId, parentId: pinId, key: 'Pin Name', value: p.name, keyVisible: false, valueVisible: true, align: 'RIGHT_BOTTOM', fontSize: 9.72, locked: false, zIndex: ticket } });
    records.push({ head: { type: 'ATTR', ticket: ++ticket, id: 'e' + randId() }, body: { partId, parentId: pinId, key: 'Pin Number', value: p.number, keyVisible: false, valueVisible: true, align: 'LEFT_BOTTOM', fontSize: 9.72, locked: false, zIndex: ticket } });
  });

  const dir = path.join(project.rootDir, 'sch', '__symbols__');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opts.name}.esch2`);
  writeRecords(file, records);
  console.log(`Wrote symbol "${opts.name}" -> ${file}`);
}

main().catch(err => die(err.message, 1));