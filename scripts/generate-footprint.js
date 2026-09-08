#!/usr/bin/env node
'use strict';
/**
 * generate-footprint.js — Build a simple footprint from a pad list.
 *
 * Usage:
 *   node scripts/generate-footprint.js from-pads \
 *     --dir <projectDir> --name 0603 \
 *     --pads "1,-31.5,0,rect,24,16;2,31.5,0,rect,24,16" \
 *     --silk "rect,-32,-16,32,16"
 *
 * Pad format: number,x,y,shape,width,height   (all units in mil)
 * Silk items: kind,x1,y1,x2,y2   (kind in rect|line|circle)
 */
const path = require('path');
const fs = require('fs');
const { Project, uuid, randId, writeRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'name', alias: 'n', hasValue: true, required: true, desc: 'Footprint name' },
  { name: 'pads', hasValue: true, required: true, desc: 'Semicolon-separated pad specs' },
  { name: 'silk', hasValue: true, desc: 'Optional silkscreen items' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('generate-footprint.js from-pads [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'from-pads') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const pads = opts.pads.split(';').map(s => s.split(',').map(v => v.trim()));
  const partId = 'pid' + randId();
  const records = [];
  let ticket = 1;
  records.push({ head: { type: 'DOCHEAD' }, body: { docType: 'SYMBOL', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } });
  records.push({ head: { type: 'META', ticket: ++ticket, id: 'META' }, body: { title: opts.name, description: '', tags: [], docType: 2, source: '' } });
  records.push({ head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' }, body: { originX: 0, originY: 0 } });
  records.push({ head: { type: 'PART', ticket: ++ticket, id: partId }, body: { BBOX: [-50, -50, 50, 50], title: opts.name } });

  if (opts.silk) {
    for (const item of opts.silk.split(';').map(s => s.split(',').map(v => v.trim()))) {
      const [kind, x1, y1, x2, y2] = item;
      ticket++;
      if (kind === 'rect') {
        records.push({ head: { type: 'RECT', ticket, id: 'e' + randId() }, body: { partId, groupId: '', locked: false, zIndex: ticket, dotX1: +x1, dotY1: +y1, dotX2: +x2, dotY2: +y2, radiusX: 0, radiusY: 0, rotation: 0, strokeColor: '#FFFFFF', strokeStyle: 'SOLID', fillColor: null, strokeWidth: 1, fillStyle: 'NONE' } });
      } else if (kind === 'line') {
        records.push({ head: { type: 'POLY', ticket, id: 'e' + randId() }, body: { partId, groupId: '', locked: false, zIndex: ticket, points: [{ x: +x1, y: +y1 }, { x: +x2, y: +y2 }], closed: false, strokeColor: '#FFFFFF', strokeStyle: 'SOLID', fillColor: null, strokeWidth: 1, fillStyle: 'NONE' } });
      }
    }
  }

  for (const p of pads) {
    const [num, cx, cy, shape, w, h] = p;
    ticket++;
    records.push({ head: { type: 'PAD', ticket, id: 'e' + randId() }, body: {
      groupId: 0, netName: '', layerId: 1, num,
      centerX: +cx, centerY: +cy, padAngle: 0, hole: null,
      defaultPad: { padType: (shape || 'rect').toUpperCase(), width: +w, height: +h, radius: 0 },
      specialPad: [], padOffsetX: 0, padOffsetY: 0, relativeAngle: 90,
      plated: true, padType: 'NORMAL', topSolderExpansion: 2, bottomSolderExpansion: 2,
      topPasteExpansion: 0, bottomPasteExpansion: 0,
      locked: false, zIndex: ticket
    } });
  }

  const dir = path.join(project.rootDir, 'sch', '__footprints__');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opts.name}.esch2`);
  writeRecords(file, records);
  console.log(`Wrote footprint "${opts.name}" -> ${file}`);
}

main().catch(err => die(err.message, 1));