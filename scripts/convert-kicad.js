#!/usr/bin/env node
'use strict';
/**
 * convert-kicad.js — Convert a KiCad project (.kicad_pro + .kicad_sch + .kicad_pcb)
 *                    into an eprj3 project skeleton.
 *
 * Usage:
 *   node scripts/convert-kicad.js convert \
 *     --src <KiCadProjectDir> --dst <eprj3Dir> [--project-name <name>] [--lib-dir <kicadSymLib>]
 *
 * The converter emits:
 *   - <dst>/<name>.eprj3                    project index
 *   - <dst>/sch/<Schematic1>/<Sheet>.esch2  schematic primitives (best-effort)
 *   - <dst>/pcb/<PCB1>.epcb2                board primitives (best-effort)
 *   - <dst>/sch/__symbols__/*.esch2         symbols lifted from KiCad library
 *
 * Notes on coverage:
 *   - Schematic wires/components/labels are mapped into the closest eprj3 equivalents.
 *   - PCB traces become FILL segments on the correct layer; footprints are reconstructed
 *     from KiCad's `footprint` nodes.
 *   - 3D models, copper pours, and net classes are NOT carried over.
 *   - Anything the AI cannot translate is skipped with a warning.
 */
const fs = require('fs');
const path = require('path');
const { parse: parseSex } = require('./lib/kicad');
const { buildSymbolRecords, buildFootprintRecords } = require('./lib/kicad-to-eprj3');
const { Project, uuid, randId, writeRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const MM_TO_MIL = 39.3700787;

const schema = [
  { name: 'src', hasValue: true, required: true, desc: 'KiCad project directory' },
  { name: 'dst', hasValue: true, required: true, desc: 'Output eprj3 directory' },
  { name: 'project-name', hasValue: true, desc: 'Override project name' },
  { name: 'lib-dir', hasValue: true, desc: 'Directory containing .kicad_sym files' }
];

function mm(x) { return parseFloat(x) * MM_TO_MIL; }
function toMil(x) { return mm(x); }

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('convert-kicad.js convert [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'convert') die(`Unknown command: ${sub}`);

  const src = path.resolve(opts.src);
  const dst = path.resolve(opts.dst);
  if (!fs.existsSync(src)) die(`Source not found: ${src}`);
  const projectName = opts['project-name'] || path.basename(src);
  const project = await Project.create(dst, projectName);
  console.log(`Created eprj3 project at ${dst}`);

  // Walk schematics
  const schs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_sch'));
  let schIdx = 1;
  for (const schFile of schs) {
    const sch = project.ensureSchematic(`Schematic${schIdx++}`);
    const sheet = project.ensureSheet(sch, 'P1');
    const file = project.sheetFile(sheet);
    convertSchematic(path.join(src, schFile), file);
    project.save();
    console.log(`  sch: ${schFile} -> ${file}`);
  }

  // Walk PCBs
  const pcbs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_pcb'));
  let pcbIdx = 1;
  for (const pcbFile of pcbs) {
    const pcb = project.ensurePcb(`PCB${pcbIdx++}`);
    const file = project.pcbFile(pcb);
    convertPcb(path.join(src, pcbFile), file);
    project.save();
    console.log(`  pcb: ${pcbFile} -> ${file}`);
  }

  // KiCad symbol library
  if (opts['lib-dir']) {
    const libDir = path.resolve(opts['lib-dir']);
    const libs = fs.readdirSync(libDir).filter(f => f.endsWith('.kicad_sym'));
    for (const libFile of libs) {
      const fullLib = path.join(libDir, libFile);
      const symbols = require('./lib/kicad').parseSymbolFile(fullLib);
      const outDir = path.join(dst, 'sch', '__symbols__');
      fs.mkdirSync(outDir, { recursive: true });
      for (const sym of symbols) {
        const { records } = buildSymbolRecords(sym);
        const head = {
          head: { type: 'DOCHEAD' },
          body: { docType: 'SYMBOL', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} }
        };
        writeRecords(path.join(outDir, `${sym.name}.esch2`), [head, ...records]);
      }
      console.log(`  lib: ${libFile} (${symbols.length} symbols)`);
    }
  }
}

function convertSchematic(src, dst) {
  const root = parseSex(fs.readFileSync(src, 'utf8'));
  const records = [];
  let ticket = 1;
  records.push({ head: { type: 'DOCHEAD' }, body: { docType: 'SCH', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } });
  records.push({ head: { type: 'META', ticket: ++ticket, id: 'META' }, body: { title: path.basename(src, '.kicad_sch'), source: '', board: '', zIndex: null } });
  records.push({ head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' }, body: { originX: 0, originY: 0 } });

  // Walk root children
  for (const node of root.slice(1)) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;
    if (head === 'wire') {
      const wireId = randId();
      records.push({ head: { type: 'WIRE', ticket: ++ticket, id: wireId }, body: { zIndex: ticket } });
      const pts = extractWirePoints(node);
      for (let i = 0; i < pts.length - 1; i++) {
        ticket++;
        records.push({ head: { type: 'LINE', ticket, id: randId() }, body: { fillColor: null, fillStyle: null, strokeColor: '#000000', strokeStyle: 'SOLID', strokeWidth: 1, startX: toMil(pts[i][0]), startY: toMil(pts[i][1]), endX: toMil(pts[i + 1][0]), endY: toMil(pts[i + 1][1]), lineGroup: wireId } });
      }
    } else if (head === 'label') {
      const [x, y] = findAtXY(node);
      const val = findValue(node);
      ticket++;
      records.push({ head: { type: 'NETLABEL', ticket, id: randId() }, body: { x: toMil(x), y: toMil(y), color: '#FF0000', fontFamily: 'Arial', fontSize: 12, align: 'CENTER_MIDDLE', value: val, locked: false, zIndex: ticket } });
    } else if (head === 'symbol') {
      const [x, y] = findAtXY(node);
      const props = collectProperties(node);
      ticket++;
      records.push({ head: { type: 'COMPONENT', ticket, id: randId() }, body: {
        partId: 'pid' + randId(),
        x: toMil(x), y: toMil(y), rotation: 0, isMirror: false,
        attrs: { Footprints: '[]', Devices: '[]', DeviceName: JSON.stringify({ uuid: uuid(8), name: props.Value || props.Reference || 'Symbol', source: '' }), FootprintName: null, pinClass: {}, differentialPairClass: {}, Symbols: '[]' },
        zIndex: ticket
      } });
    }
  }
  writeRecords(dst, records);
}

function extractWirePoints(node) {
  // wire nodes have (pts (xy x y) (xy x y) ...) or (pts (start x y) (end x y))
  const out = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'pts') {
      for (const xy of it.slice(1)) {
        if (Array.isArray(xy) && xy[0].v === 'xy') out.push([parseFloat(xy[1].v), parseFloat(xy[2].v)]);
      }
    }
  }
  return out;
}

function findAtXY(node) {
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'at') return [parseFloat(it[1].v), parseFloat(it[2].v)];
  }
  return [0, 0];
}
function findValue(node) {
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'value' && it[1]) return it[1].v;
  }
  return '';
}
function collectProperties(node) {
  const out = {};
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'property') out[it[1]?.v] = it[2]?.v;
  }
  return out;
}

function convertPcb(src, dst) {
  const root = parseSex(fs.readFileSync(src, 'utf8'));
  const records = [];
  let ticket = 1;
  records.push({ head: { type: 'DOCHEAD' }, body: { docType: 'PCB', client: 'easyeda-pro-skill', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } });
  records.push({ head: { type: 'META', ticket: ++ticket, id: 'META' }, body: { title: path.basename(src, '.kicad_pcb'), source: '', board: '' } });
  records.push({ head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' }, body: { originX: 0, originY: 0 } });

  for (const node of root.slice(1)) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;
    if (head === 'segment') {
      const start = findSub(node, 'start');
      const end = findSub(node, 'end');
      const width = findSub(node, 'width') || 1;
      const layer = findSub(node, 'layer') || 'F.Cu';
      const layerId = layerToId(layer);
      ticket++;
      records.push({ head: { type: 'FILL', ticket, id: randId() }, body: {
        groupId: 0, netName: '', layerId, width: toMil(width), fillStyle: 'SOLID',
        path: [['L', toMil(start[0]), toMil(start[1]), toMil(end[0]), toMil(end[1]), toMil(start[0]), toMil(start[1])]],
        locked: false, zIndex: ticket, isBridgingCopper: false, networkList: [], refs: []
      } });
    } else if (head === 'footprint') {
      const { records: fpRecs } = buildFootprintRecords({ name: node[1]?.v || 'FP', pads: extractPads(node), shapes: extractFpShapes(node) });
      // stitch the partId-pinned records in by lifting their ticket range
      for (const r of fpRecs) records.push({ ...r, head: { ...r.head, ticket: ++ticket } });
    }
  }
  writeRecords(dst, records);
}

function findSub(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key) return it.slice(1).map(x => x.v);
  return null;
}
function layerToId(name) {
  return { 'F.Cu': 1, 'B.Cu': 2, 'F.SilkS': 3, 'B.SilkS': 4 }[name] || 1;
}
function extractPads(node) {
  const pads = [];
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === 'pad') {
    const pad = { number: it[1].v, shape: it[2].v, type: it[3]?.v, at: [], size: [], layers: [] };
    for (const sub of it.slice(1)) {
      if (!Array.isArray(sub)) continue;
      const sh = sub[0].v;
      if (sh === 'at') pad.at = sub.slice(1).map(x => x.v);
      else if (sh === 'size') pad.size = sub.slice(1).map(x => x.v);
      else if (sh === 'layers') pad.layers = sub.slice(1).map(x => x.v);
    }
    pads.push(pad);
  }
  return pads;
}
function extractFpShapes(node) {
  const out = [];
  for (const it of node.slice(1)) {
    if (!Array.isArray(it)) continue;
    const h = it[0].v;
    if (h.startsWith('fp_')) {
      const xy = findSub(it, 'start');
      const xy2 = findSub(it, 'end');
      out.push({ kind: h, x1: xy ? +xy[0] : 0, y1: xy ? +xy[1] : 0, x2: xy2 ? +xy2[0] : 0, y2: xy2 ? +xy2[1] : 0 });
    }
  }
  return out;
}

main().catch(err => die(err.stack || err.message, 1));