#!/usr/bin/env node
'use strict';
/**
 * load-library.js — Pull a component from a local EasyEDA library (.elibz2)
 *                   and inject it into the project as a SYMBOL or FOOTPRINT document.
 *
 * Usage:
 *   node scripts/load-library.js import \
 *     --dir <projectDir> \
 *     --format elibz2 \
 *     --library <fileOrDir> \
 *     --component <nameOrId> \
 *     [--kind symbol|footprint]
 *
 * When --kind is omitted we try symbol first, then footprint.
 * (KiCad library import lives in the separate kicad-to-easyeda-eprj3 project.)
 */
const fs = require('fs');
const path = require('path');
const { Project, uuid, randId, writeRecords } = require('./lib/eprj3');
const { openArchive, readManifest, loadSymbol, loadFootprint } = require('./lib/elibz2');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'format', hasValue: true, required: true, desc: 'elibz2' },
  { name: 'library', hasValue: true, required: true, desc: 'Path to library file or directory' },
  { name: 'component', hasValue: true, required: true, desc: 'Component name or id' },
  { name: 'kind', hasValue: true, desc: 'symbol | footprint (auto if omitted)' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('load-library.js import [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'import') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const lib = path.resolve(opts.library);
  if (!fs.existsSync(lib)) die(`Library not found: ${lib}`);

  if (opts.format === 'elibz2') {
    const arch = openArchive(lib);
    const manifest = await readManifest(arch);
    const comp = (manifest.components || []).find(c => c.name === opts.component || c.uuid === opts.component);
    if (!comp) die(`Component "${opts.component}" not found in manifest`);
    if (opts.kind === 'footprint' || (!opts.kind && comp.package)) {
      const fp = await loadFootprint(arch, comp.package?.uuid);
      if (!fp) die(`Footprint "${comp.package?.uuid}" missing in library`);
      writeFootprintFile(project, comp.name || comp.uuid, fp);
    } else {
      const sym = await loadSymbol(arch, comp.uuid);
      if (!sym) die(`Symbol "${comp.uuid}" missing in library`);
      writeSymbolFile(project, comp.name || comp.uuid, sym);
    }
  } else {
    die(`Unknown --format: ${opts.format}`);
  }
}

function writeSymbolFile(project, name, symDoc) {
  const outDir = path.join(project.rootDir, 'sch', '__symbols__');
  fs.mkdirSync(outDir, { recursive: true });
  const records = [];
  const head = {
    head: { type: 'DOCHEAD' },
    body: { docType: 'SYMBOL', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} }
  };
  records.push(head);
  // Convert shapes/pins from elibz2 JSON into eprj3 records (best-effort).
  let ticket = 1;
  records.push({ head: { type: 'META', ticket: ++ticket, id: 'META' }, body: { title: name, description: '', tags: [], docType: 2, source: '' } });
  const partId = 'pid' + randId();
  records.push({ head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' }, body: { originX: 0, originY: 0 } });
  records.push({ head: { type: 'PART', ticket: ++ticket, id: partId }, body: { BBOX: [-50, -50, 50, 50], title: name } });

  for (const sh of (symDoc.shapes || [])) {
    ticket++;
    if (sh._type === 'R' || sh.type === 'rect') {
      records.push({ head: { type: 'RECT', ticket, id: randId() }, body: { partId, groupId: '', locked: false, zIndex: ticket, dotX1: sh.x1 ?? sh.X1 ?? 0, dotY1: sh.y1 ?? sh.Y1 ?? 0, dotX2: sh.x2 ?? sh.X2 ?? 0, dotY2: sh.y2 ?? sh.Y2 ?? 0, radiusX: 0, radiusY: 0, rotation: 0, strokeColor: '#000000', strokeStyle: 'SOLID', fillColor: null, strokeWidth: 1, fillStyle: 'NONE' } });
    } else if (sh._type === 'P' || sh.type === 'poly') {
      records.push({ head: { type: 'POLY', ticket, id: randId() }, body: { partId, groupId: '', locked: false, zIndex: ticket, points: (sh.points || []).map(p => ({ x: p.x, y: p.y })), closed: !!sh.closed, strokeColor: '#000000', strokeStyle: 'SOLID', fillColor: null, strokeWidth: 1, fillStyle: 'NONE' } });
    }
  }
  for (const pin of (symDoc.pins || [])) {
    ticket++;
    records.push({ head: { type: 'PIN', ticket, id: randId() }, body: { partId, groupId: '', locked: false, zIndex: ticket, display: true, x: pin.x || 0, y: pin.y || 0, length: pin.length || 10, rotation: pin.rotation || 0, color: null, pinShape: pin.shape || 'NONE' } });
  }

  const file = path.join(outDir, `${name}.esch2`);
  writeRecords(file, records);
  console.log(`Imported symbol "${name}" -> ${file}`);
}

function writeFootprintFile(project, name, fpDoc) {
  const outDir = path.join(project.rootDir, 'sch', '__footprints__');
  fs.mkdirSync(outDir, { recursive: true });
  const partId = 'pid' + randId();
  const records = [];
  let ticket = 1;
  records.push({ head: { type: 'DOCHEAD' }, body: { docType: 'SYMBOL', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } });
  records.push({ head: { type: 'META', ticket: ++ticket, id: 'META' }, body: { title: name, description: '', tags: [], docType: 2, source: '' } });
  records.push({ head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' }, body: { originX: 0, originY: 0 } });
  records.push({ head: { type: 'PART', ticket: ++ticket, id: partId }, body: { BBOX: [-100, -100, 100, 100], title: name } });
  for (const p of (fpDoc.pads || [])) {
    ticket++;
    records.push({ head: { type: 'PAD', ticket, id: randId() }, body: {
      groupId: 0, netName: '', layerId: 1, num: p.number || p.num,
      centerX: p.centerX ?? p.x ?? 0, centerY: p.centerY ?? p.y ?? 0,
      padAngle: 0, hole: p.hole || null,
      defaultPad: { padType: (p.shape || 'RECT').toUpperCase(), width: p.width || 10, height: p.height || 10, radius: 0 },
      specialPad: [], padOffsetX: 0, padOffsetY: 0, relativeAngle: 90,
      plated: true, padType: 'NORMAL', topSolderExpansion: 2, bottomSolderExpansion: 2,
      topPasteExpansion: 0, bottomPasteExpansion: 0, locked: false, zIndex: ticket
    } });
  }
  const file = path.join(outDir, `${name}.esch2`);
  writeRecords(file, records);
  console.log(`Imported footprint "${name}" -> ${file}`);
}

main().catch(err => die(err.message, 1));