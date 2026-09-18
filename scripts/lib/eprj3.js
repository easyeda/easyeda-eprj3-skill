'use strict';
/**
 * eprj3.js — record/document model for EasyEDA Pro (.eprj3) folder projects.
 *
 * Ground truth: the official easyeda-pro-eprj3-format example project. Every
 * record body emitted here mirrors the example byte-for-byte in key order and
 * value shape. Coordinates in document records are always mil.
 *
 * Record grammar:  {"type":"T","ticket":N,"id":"..."}||{body}|   (empty body:  ...}|||)
 * DOCHEAD has no ticket/id: {"type":"DOCHEAD"}||{docType,...}|
 *
 * File layout: a container file (.esch2/.epcb2) is a list of library docs
 * (SYMBOL/FOOTPRINT/DEVICE) followed by the MAIN doc (SCH_PAGE or PCB) whose
 * records run to EOF. Library docs are inserted BEFORE the last DOCHEAD line;
 * new content appends at EOF.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildFrameDocs, FRAME_TITLE } = require('./frame-a4');
const { buildPcbPreamble } = require('./pcb-preamble');

const PART_ID = 'pid8a0e77bacb214e';
const EDIT_VERSION = '2.3.0';
const FRAME_DEVICE_NAME = FRAME_TITLE; // "Drawing-Symbol_A4"

// Two-tier library model:
// - preset templates ship with the skill in templates/library/{symbol,footprint}/
//   and are resolved FIRST when placing;
// - per-project staging (custom entries generated during authoring) goes to
//   <project>/.tmp/library/{symbol,footprint}/ and is removed by cleanup.js.
const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const LIBRARY_DIR = path.join(SKILL_ROOT, 'templates', 'library');

// ---------------------------------------------------------------- ids
function uuid(len = 16) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}
function uuid16() { return uuid(16); }
function uuid32() { return uuid(32); }
function randId() { return crypto.randomBytes(8).toString('hex'); }
// The client derives its client id from the owner uuid (md5 hex, first 16).
function clientIdFrom(ownerUuid) {
  return crypto.createHash('md5').update(ownerUuid).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- records
function parseRecord(line) {
  const parts = line.split('||');
  if (parts.length < 2) return null;
  let head;
  try { head = JSON.parse(parts[0]); } catch { return null; }
  if (!head || typeof head !== 'object' || !head.type) return null;
  let bodySrc;
  if (parts.length === 2) {
    bodySrc = parts[1];
  } else {
    // stray '||' inside a JSON string: rejoin unless the middle part is a
    // ticket/id fragment (never produced by the client, kept for tolerance)
    bodySrc = parts.slice(1).join('||');
  }
  bodySrc = bodySrc.replace(/\|+\s*$/, '');
  let body;
  if (!bodySrc.trim()) {
    body = {};
  } else {
    try { body = JSON.parse(bodySrc); } catch { body = {}; }
  }
  return { head, body, ticket: head.ticket, id: head.id, type: head.type };
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
}

function readRecords(filePath) {
  return readLines(filePath).map(parseRecord).filter(Boolean);
}

function formatRecord(head, body) {
  const b = body && Object.keys(body).length ? JSON.stringify(body) : '';
  return JSON.stringify(head) + '||' + b + '|';
}

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function writeRecords(filePath, records) {
  writeLines(filePath, records.map((r) => formatRecord(r.head, r.body)));
}

function maxTicketOfLines(lines) {
  let max = 0;
  for (const l of lines) {
    const r = parseRecord(l);
    if (r && typeof r.ticket === 'number') max = Math.max(max, r.ticket);
  }
  return max;
}

// Append pre-formatted lines at EOF (main-doc area).
function appendLines(filePath, lines) {
  const existing = fs.existsSync(filePath) ? readLines(filePath) : [];
  writeLines(filePath, existing.concat(lines));
}

// Insert library docs (arrays of lines) before the LAST DOCHEAD line of the
// container file. Docs whose DOCHEAD uuid is already present are skipped.
function insertDocsBeforeMain(filePath, docs) {
  const lines = readLines(filePath);
  let lastHead = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{"type":"DOCHEAD"}')) { lastHead = i; break; }
  }
  if (lastHead < 0) throw new Error(`no DOCHEAD in ${filePath}`);
  const present = new Set();
  for (const l of lines) {
    if (l.startsWith('{"type":"DOCHEAD"}')) {
      const r = parseRecord(l);
      if (r && r.body && r.body.uuid) present.add(r.body.uuid);
    }
  }
  const toInsert = [];
  for (const doc of docs) {
    const head = parseRecord(doc[0]);
    const u = head && head.body && head.body.uuid;
    if (!u || !present.has(u)) toInsert.push(...doc);
  }
  if (toInsert.length) {
    lines.splice(lastHead, 0, ...toInsert);
    writeLines(filePath, lines);
  }
  return toInsert.length;
}

// ------------------------------------------------------------ staged library
// Staged entries live in <dir>/{symbol,footprint}/<name>.json. The kind decides
// the subfolder on write; lookups scan both.
function libraryFileIn(dir, name) {
  for (const sub of ['symbol', 'footprint']) {
    const f = path.join(dir, sub, `${name}.json`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function listLibraryDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const sub of ['symbol', 'footprint']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.json')) out.push(f.slice(0, -5));
    }
  }
  return out.sort();
}

// Staged/template docs may originate from a different owner (e.g. elibu
// exports); their DOCHEAD client id (carried in the DOCHEAD body) must match
// the target project before embedding.
function rewriteDocHeads(lines, client) {
  return lines.map((line) => {
    const i = line.indexOf('||');
    if (i < 0) return line;
    let head;
    try { head = JSON.parse(line.slice(0, i)); } catch { return line; }
    if (!head || head.type !== 'DOCHEAD') return line;
    let body;
    try { body = JSON.parse(line.slice(i + 2, line.length - 1)); } catch { return line; }
    body.client = client;
    return JSON.stringify(head) + '||' + JSON.stringify(body) + '|';
  });
}

function appendRecord(filePath, type, body, ticket, id) {
  const records = fs.existsSync(filePath) ? readRecords(filePath) : [];
  const maxTicket = records.reduce((m, r) => Math.max(m, r.ticket || 0), 0);
  const t = ticket || maxTicket + 1;
  const recId = id || body.id || randId();
  const head = { type, ticket: t, id: recId };
  appendLines(filePath, [formatRecord(head, body)]);
  return { head, body, ticket: t, id: recId, type };
}

function updateRecord(filePath, predicate, mutator) {
  const records = readRecords(filePath);
  let updated = 0;
  for (const r of records) if (predicate(r)) { mutator(r); updated++; }
  writeRecords(filePath, records);
  return updated;
}

function removeRecord(filePath, predicate) {
  const records = readRecords(filePath);
  const kept = records.filter((r) => !predicate(r));
  writeRecords(filePath, kept);
  return records.length - kept.length;
}

function readDocHeadUuid(filePath) {
  try {
    const rec = readRecords(filePath).find((r) => r.type === 'DOCHEAD');
    return (rec && rec.body && rec.body.uuid) || null;
  } catch { return null; }
}

// ---------------------------------------------------------------- builder
// Sequential ticket + e0,e1,... element ids, one builder per generated doc.
class DocBuilder {
  constructor() { this.lines = []; this.ticket = 0; this.elem = 0; }
  nextTicket() { return ++this.ticket; }
  nextElem() { return 'e' + this.elem++; }
  // id: explicit record id (e.g. META / ["LAYER",1] / e-number). Default 16-hex.
  add(type, body, id) {
    const t = ++this.ticket;
    const recId = id !== undefined ? id : randId();
    this.lines.push(formatRecord({ type, ticket: t, id: recId }, body));
    return recId;
  }
  addElem(type, body) { return this.add(type, body, this.nextElem()); }
}

function docHeadLine(docType, client, docUuid, ms) {
  const body = {
    docType,
    client,
    uuid: docUuid,
    updateTime: ms,
    version: String(ms),
    editVersion: EDIT_VERSION,
    user: {}
  };
  return '{"type":"DOCHEAD"}||' + JSON.stringify(body) + '|';
}

function makeSource(sourceUuid, ownerUuid) { return `${sourceUuid}|${ownerUuid}`; }

// ------------------------------------------------- symbol doc (docType 2)
// spec: {uuid,title,description,tags,source,ms,bbox,graphics,pins,name,designator}
// graphics: [{type:'RECT'|'POLY'|'CIRCLE'|'ARC', body:{...}}]  (part-level shape
// bodies; partId/groupId/locked/zIndex are filled here). Coordinates mil.
// pins: [{num,name,x,y,rotation,length}]
function buildSymbolDoc(spec) {
  const b = new DocBuilder();
  b.lines.push(docHeadLine('SYMBOL', spec.client, spec.uuid, spec.ms));
  b.add('META', {
    title: spec.title,
    description: spec.description || '',
    tags: spec.tags || [],
    docType: 2,
    source: spec.source
  }, 'META');
  b.add('CANVAS', { originX: 0, originY: 0 }, 'CANVAS');
  b.add('PART', { BBOX: spec.bbox, title: '' }, PART_ID);

  let z = 0;
  const zIndex = () => ++z;
  const ctx = { partId: PART_ID, groupId: '', locked: false };

  for (const g of spec.graphics || []) {
    const body = Object.assign({}, ctx, { zIndex: zIndex() }, g.body);
    b.addElem(g.type, body);
  }
  for (const p of spec.pins || []) {
    const pinId = b.addElem('PIN', Object.assign({}, ctx, {
      zIndex: zIndex(),
      display: true,
      x: p.x, y: p.y,
      length: p.length !== undefined ? p.length : 10,
      rotation: p.rotation || 0,
      color: null,
      pinShape: 'NONE'
    }));
    const nameAlign = p.rotation === 180 ? 'RIGHT_BOTTOM' : 'LEFT_BOTTOM';
    const numAlign = p.rotation === 180 ? 'LEFT_BOTTOM' : 'RIGHT_BOTTOM';
    for (const [key, value, align] of [
      ['Pin Name', p.name || p.num, nameAlign],
      ['Pin Number', p.num, numAlign],
      ['Pin Type', 'Undefined', 'LEFT_BOTTOM']
    ]) {
      b.add('ATTR', {
        partId: PART_ID, groupId: '', locked: false,
        zIndex: zIndex(), parentId: pinId,
        key, value,
        keyVisible: false, valueVisible: false,
        x: null, y: null, rotation: 0, color: null, fillColor: null,
        fontFamily: null,
        fontSize: key === 'Pin Type' ? 6.75 : 9.72222,
        strikeout: false, underline: false, italic: false, fontWeight: false,
        align, version: '2.0'
      });
    }
  }
  for (const [key, value] of [['Name', spec.name || spec.title], ['Designator', spec.designator || 'U?']]) {
    b.add('ATTR', {
      partId: PART_ID, groupId: '', locked: false,
      zIndex: zIndex(), parentId: '',
      key, value,
      keyVisible: false, valueVisible: false,
      x: null, y: null, rotation: 0, color: null, fillColor: null,
      fontFamily: null, fontSize: 6.75,
      strikeout: false, underline: false, italic: false, fontWeight: false,
      align: 'LEFT_BOTTOM', version: '2.0'
    });
  }
  return b.lines;
}

// ------------------------------------------------- power symbol doc (docType 18)
// style 'up' (VCC-like, bar above origin) or 'down' (GND-like, bars below).
function buildPowerSymbolDoc(spec) {
  const down = spec.style === 'down';
  const b = new DocBuilder();
  b.lines.push(docHeadLine('SYMBOL', spec.client, spec.uuid, spec.ms));
  b.add('META', {
    title: spec.title,
    description: '',
    tags: [],
    docType: 18,
    source: spec.source
  }, 'META');

  const nameAlign = down ? 'CENTER_MIDDLE' : 'CENTER_BOTTOM';
  const nameY = down ? 25 : -10;
  const nameZ = down ? 3 : 9;
  const gnnZ = down ? 17 : 11;
  const nulls = {
    rotation: 0, color: null, fontFamily: null, fontSize: null,
    fontWeight: null, italic: null, underline: null, align: nameAlign,
    fillColor: null, parentId: PART_ID, partId: PART_ID
  };
  b.add('ATTR', Object.assign({}, nulls, {
    x: 0, y: nameY,
    value: spec.net, keyVisible: null, valueVisible: false,
    key: 'Global Net Name', zIndex: gnnZ
  }));
  b.add('ATTR', Object.assign({}, nulls, {
    x: 0, y: nameY,
    value: spec.net, keyVisible: null, valueVisible: down ? false : true,
    key: 'Name', zIndex: nameZ
  }));

  b.add('CANVAS', { originX: 0, originY: 0 }, 'CANVAS');
  b.add('PART', {
    BBOX: down ? [-10, 0, 10, -19] : [-5, 10, 5, 0],
    title: ''
  }, PART_ID);

  b.add('ATTR', {
    partId: PART_ID, groupId: '', locked: false, zIndex: 1, parentId: '',
    key: 'Symbol', value: spec.title,
    keyVisible: false, valueVisible: false,
    x: 0, y: 30, rotation: 360, color: null, fillColor: null,
    fontFamily: null, fontSize: down ? 10 : null,
    strikeout: null, underline: null, italic: null, fontWeight: null, align: null
  });

  const pinId = b.addElem('PIN', {
    partId: PART_ID, groupId: '', locked: false, zIndex: down ? 4 : 3,
    display: true, x: 0, y: 0,
    length: down ? 10 : 5,
    rotation: down ? 270 : 90,
    color: null, pinShape: 'NONE'
  });
  const pinNulls = {
    color: null, fillColor: null, fontFamily: null, fontSize: null,
    strikeout: null, underline: null, italic: null, fontWeight: null, rotation: 90
  };
  const pinAttrs = down
    ? [['Pin Name', 'Pin1', { x: 0, y: 10, align: 'RIGHT_MIDDLE' }],
       ['Pin Number', '1', { x: -1, y: 10, align: 'LEFT_BOTTOM', fontFamily: '宋体', strikeout: null, underline: false, italic: false, fontWeight: false }],
       ['Pin Type', 'IN', { x: 0, y: 0, align: 'RIGHT_TOP' }]]
    : [['Pin Name', 'Pin1', { x: 0, y: -5, align: 'LEFT_MIDDLE' }],
       ['Pin Number', '1', { x: 0, y: -4.5, align: null }],
       ['Pin Type', 'IN', { x: -14, y: 2, align: null }]];
  pinAttrs.forEach(([key, value, pos], i) => {
    b.add('ATTR', Object.assign({
      partId: PART_ID, groupId: '', locked: false, zIndex: (down ? 5 : 4) + i,
      parentId: pinId, key, value,
      keyVisible: false, valueVisible: false
    }, pinNulls, pos));
  });

  const bars = down
    ? [[[-10, 10], [10, 10]], [[-1, 19], [1, 19]], [[-4, 16], [4, 16]], [[-7, 13], [7, 13]]]
    : [[[-5, -10], [5, -10]], [[0, -10], [0, -5]]];
  bars.forEach((points, i) => {
    b.addElem('POLY', {
      partId: PART_ID, groupId: '', locked: false,
      zIndex: (down ? 8 : 7) + i,
      points: points.map(([x, y]) => ({ x, y })),
      closed: false,
      strokeColor: null, strokeStyle: null, fillColor: null,
      strokeWidth: down ? 1 : null, fillStyle: null
    });
  });
  return b.lines;
}

// ------------------------------------------------- footprint doc
// spec: {uuid,title,description,tags,source,ms,outline,silks,pads,designator}
// outline: mil path array (layer 48 component body) — polyline corners, e.g.
// [x0,y0,'L',x1,y0,x1,y1,x0,y1,x0,y0] (real footprint docs never use rect paths)
// silks:   [{path:[x1,y1,'L',x2,y2,...], width?}]  (layer 3)
// pads:    [{num,x,y,width,height,hole?,offsetX?,offsetY?}]  (mil)
//          hole = drill diameter (mil): null → SMD RECT pad on layer 1;
//          number → ROUND hole, ELLIPSE pad on layer 12 (MULTI)
function buildFootprintDoc(spec) {
  const b = new DocBuilder();
  b.lines.push(docHeadLine('FOOTPRINT', spec.client, spec.uuid, spec.ms));
  b.add('META', {
    title: spec.title,
    description: spec.description || '',
    tags: spec.tags || [],
    source: spec.source
  }, 'META');

  // 19 layer records, verbatim from the example footprint docs.
  const LAYERS = [
    [1, 'TOP', 'Top Layer', '#FF0000', '#7F0000'],
    [2, 'BOTTOM', 'Bottom Layer', '#0000FF', '#00007F'],
    [3, 'TOP_SILK', 'Top Silkscreen Layer', '#FFCC00', '#7F6600'],
    [4, 'BOT_SILK', 'Bottom Silkscreen Layer', '#66CC33', '#336619'],
    [7, 'TOP_PASTE_MASK', 'Top Paste Mask Layer', '#808080', '#404040'],
    [8, 'BOT_PASTE_MASK', 'Bottom Paste Mask Layer', '#800000', '#400000'],
    [5, 'TOP_SOLDER_MASK', 'Top Solder Mask Layer', '#800080', '#400040'],
    [6, 'BOT_SOLDER_MASK', 'Bottom Solder Mask Layer', '#AA00FF', '#55007F'],
    [13, 'DOCUMENT', 'Document Layer', '#FFFFFF', '#7F7F7F'],
    [11, 'OUTLINE', 'Board Outline Layer', '#FF00FF', '#7F007F'],
    [12, 'MULTI', 'Multi-Layer', '#C0C0C0', '#606060'],
    [9, 'TOP_ASSEMBLY', 'Top Assembly Layer', '#33CC99', '#19664C'],
    [10, 'BOT_ASSEMBLY', 'Bottom Assembly Layer', '#5555FF', '#2A2A7F'],
    [14, 'MECHANICAL', 'Mechanical Layer', '#F022F0', '#781178'],
    [52, 'COMPONENT_MODEL', 'Component Model Layer', '#FFFFFF', '#7F7F7F'],
    [48, 'COMPONENT_SHAPE', 'Component Shape Layer', '#00CCCC', '#006666'],
    [51, 'PIN_FLOATING', 'Pin Floating Layer', '#FF99FF', '#7F4C7F'],
    [49, 'COMPONENT_MARKING', 'Component Marking Layer', '#66FFCC', '#337F66'],
    [50, 'PIN_SOLDERING', 'Pin Soldering Layer', '#CC9999', '#664C4C']
  ];
  let t = 0;
  for (const [id, type, name, active, inactive] of LAYERS) {
    b.add('LAYER', {
      layerType: type, layerName: name, use: true, show: true, locked: false,
      activeColor: active, activateTransparency: 1,
      inactiveColor: inactive, inactiveTransparency: 1
    }, `["LAYER",${id}]`);
    t++;
  }
  b.add('ACTIVE_LAYER', { layerId: 1 }, 'ACTIVE_LAYER');
  b.add('CANVAS', {
    originX: 0, originY: 0, unit: 'mm',
    gridXSize: 10, gridYSize: 10, snapXSize: 0.5, snapYSize: 0.5,
    gridType: 'NONE', multiGridType: 'NONE',
    highlightValue: 0.5, layerBrightness: 'NORMAL'
  }, 'CANVAS');

  let z = 0;
  const zIndex = () => ++z;

  if (spec.outline) {
    b.addElem('POLY', {
      groupId: 0, netName: '', layerId: 48, width: 2,
      path: spec.outline, locked: false, zIndex: zIndex(), polyType: 'NORMAL'
    });
  }
  for (const s of spec.silks || []) {
    b.addElem('POLY', {
      groupId: 0, netName: '', layerId: 3,
      width: s.width !== undefined ? s.width : 6,
      path: s.path, locked: false, zIndex: zIndex(), polyType: 'NORMAL'
    });
  }
  const pads = [];
  for (const p of spec.pads || []) {
    // Through-hole pads follow the official example: MULTI layer (12), round
    // drill hole, ellipse pad. SMD pads stay on TOP_COPPER with a RECT pad.
    const hole = p.hole ? { holeType: 'ROUND', width: p.hole, height: p.hole } : null;
    const elemId = b.addElem('PAD', {
      groupId: 0, netName: '', layerId: hole ? 12 : 1,
      num: p.num, centerX: p.x, centerY: p.y, padAngle: 0,
      hole,
      defaultPad: hole
        ? { padType: 'ELLIPSE', width: p.width, height: p.height }
        : { padType: 'RECT', width: p.width, height: p.height, radius: 0 },
      specialPad: [],
      padOffsetX: p.offsetX || 0, padOffsetY: p.offsetY || 0,
      relativeAngle: 90, plated: true, padType: 'NORMAL',
      topSolderExpansion: null, bottomSolderExpansion: null,
      topPasteExpansion: null, bottomPasteExpansion: null,
      locked: false, zIndex: zIndex(),
      connectMode: null, spokeSpace: null, spokeWidth: null, spokeAngle: null,
      padLen: 0
    });
    pads.push({ num: p.num, elemId });
  }

  const attrs = {};
  for (const [key, value] of [['Footprint', spec.title], ['Designator', spec.designator || 'U?']]) {
    const id = b.add('ATTR', {
      groupId: 0, parentId: '', layerId: 3,
      x: null, y: null, key, value,
      keyVisible: false, valueVisible: false,
      fontFamily: 'default', fontSize: 67.5, strokeWidth: 6,
      bold: false, italic: false, origin: 'LEFT_BOTTOM', angle: 0,
      reverse: false, expansion: 0, mirror: false, locked: false,
      zIndex: zIndex()
    });
    attrs[key] = id;
  }
  b.add('NET', {
    netType: null, specialColor: null, retLine: true,
    differentialName: null, isPositiveNet: false, equalLengthGroupName: null
  }, '["NET",""]');

  return { lines: b.lines, pads, attrs };
}

// ------------------------------------------------- device doc (2 lines)
function buildDeviceDoc(spec) {
  const b = new DocBuilder();
  b.lines.push(docHeadLine('DEVICE', spec.client, spec.uuid, spec.ms));
  const attributes = Object.assign({
    Symbol: spec.symbolUuid,
    Designator: spec.designator === undefined ? 'U?' : spec.designator,
    Name: spec.title,
    Description: ''
  }, spec.attributes || {});
  if (spec.designator === null) delete attributes.Designator;
  if (spec.footprintUuid) {
    attributes.Footprint = spec.footprintUuid;
    attributes.FootprintName = JSON.stringify({
      name: spec.footprintName || '', uuid: spec.footprintUuid, source: ''
    });
  }
  attributes.SymbolName = JSON.stringify({
    name: spec.symbolName || spec.title, uuid: spec.symbolUuid, source: ''
  });
  b.add('META', {
    title: spec.title,
    tags: spec.tags || [],
    source: spec.source,
    images: [],
    attributes
  }, 'META');
  return b.lines;
}

// ------------------------------------------------- SCH container (.ecfg)
function buildEcfgDoc(sch, client, ms) {
  const b = new DocBuilder();
  b.lines.push(docHeadLine('SCH', client, sch.uuid, ms));
  b.add('META', { title: sch.name, source: '', board: sch.board, zIndex: null }, 'META');
  const rule = (name, state, stroMin) => b.add('RULE', {
    ruleState: state,
    ruleContext: {
      unit: 'mm',
      track: { isOpen: true, content: [{ layerId: 1, stroDef: 0.254, stroMax: 2.54, stroMin }] }
    }
  }, `["RULE","TRACK","${name}"]`);
  rule('copperThickness1oz', 'DEFAULT', 0.127);
  rule('copperThickness2oz', 'NORMAL', 0.203);
  return b.lines;
}

// ------------------------------------------------- panel doc
function buildPanelDoc(panelUuid, client, ms, title = 'Panel1') {
  return [
    docHeadLine('PANEL', client, panelUuid, ms),
    formatRecord({ type: 'META', ticket: 1, id: 'META' }, { title, zIndex: null }),
    formatRecord({ type: 'CANVAS', ticket: 2, id: 'CANVAS' }, {
      material: 'acrylic', thickness: '0.8mm', print: 'Bottom Side',
      craft: 'Transparent', desc: '', coverColor: 'white',
      width: '393mm', height: '579mm', originX: 0, originY: 0,
      orderWidth: '232.1mm', orderHeight: '207.5mm'
    })
  ];
}

// ------------------------------------------------- SCH_PAGE doc (main, sheet)
// All-null ATTR helper (group-B shape: no `locked` field). `over` patches
// individual fields (e.g. align on power Name/Global Net Name attrs).
function attrNull(key, value, parentZ, parentId, over) {
  return Object.assign({
    x: null, y: null, rotation: null, color: null, fontFamily: null,
    fontSize: null, fontWeight: null, italic: null, underline: null, align: null,
    value, keyVisible: null, valueVisible: null, key,
    fillColor: null, parentId, zIndex: parentZ
  }, over);
}
// Styled ATTR helper (group-A / component Name/Designator shape).
function attrStyled(over) {
  return Object.assign({
    x: null, y: null, rotation: 0, color: null, fontFamily: null,
    fontSize: null, fontWeight: null, italic: null, underline: null,
    align: null, value: null, keyVisible: null, valueVisible: null,
    key: null, fillColor: null, parentId: null, zIndex: null, locked: false
  }, over);
}

function buildSheetPageDoc(v) {
  // v: {sheetUuid, sheetTitle, schematicUuid, schematicName, boardTitle,
  //     projectName, dateStr, timeStr, frameSymbolUuid, frameDeviceUuid,
  //     client, ms}
  const b = new DocBuilder();
  b.lines.push(docHeadLine('SCH_PAGE', v.client, v.sheetUuid, v.ms));
  b.add('META', {
    title: v.sheetTitle, schematic: v.schematicUuid, source: '', zIndex: 1
  }, 'META');

  const frameCompId = randId();
  const A = (z, x, y, fontSize, align, value, key) =>
    b.add('ATTR', attrStyled({
      x, y, fontSize, align, value, key, parentId: frameCompId, zIndex: z
    }));
  A(1, 2547, 159, 20, 'CENTER_MIDDLE', v.frameSymbolUuid, 'Symbol');
  A(2, 1039, 13, 20, 'CENTER_MIDDLE', '嘉立创EDA', 'Company');
  A(3, 599, -77, 15, 'LEFT_MIDDLE', '', 'Drawed');
  A(4, 599, -57, 15, 'LEFT_MIDDLE', '', 'Reviewed');
  A(5, 1051, -97, 15, 'LEFT_MIDDLE', '', 'Part Number');
  A(6, 759, 13, 15, 'CENTER_MIDDLE', 'V1.0', 'Version');
  A(7, 841, 13, 15, 'CENTER_MIDDLE', 'A4', 'Page Size');
  A(8, 961, -57, 20, 'CENTER_MIDDLE', v.projectName, '@Project Name');
  A(10, 1051, -137, 15, 'LEFT_MIDDLE', v.dateStr, '@Update Date');
  A(11, 1051, -117, 15, 'LEFT_MIDDLE', v.dateStr, '@Create Date');

  const B = (z, key, value) => b.add('ATTR', attrNull(key, value, z, frameCompId));
  B(73, 'Device', v.frameDeviceUuid);
  B(74, '@Board Name', v.boardTitle);
  B(75, '@Page Name', v.sheetTitle);
  B(76, '@Create Time', v.timeStr);
  B(77, '@Page Count', '1');
  B(78, '@Page No', '1');
  B(79, '@Schematic Name', v.schematicName);
  B(80, '@Update Time', v.timeStr);
  B(81, '@Assembly Variant', 'Basic');
  B(82, 'Border', '1');
  B(83, 'Title Block Position', '3');
  B(84, 'Size', 'A4');
  B(85, 'Width', '1170');
  B(86, 'Height', '825');
  B(87, 'Region Start', '1');
  B(88, 'X Region Count', '6');
  B(89, 'Y Region Count', '4');
  B(90, 'Blade Width', '10');
  B(91, 'Color', '');
  B(92, 'Title Block', '1');
  B(93, 'Name', '');
  B(94, 'Description', '');

  b.add('COMPONENT', {
    partId: PART_ID,
    x: 0, y: 0, rotation: 0, isMirror: false,
    attrs: {
      Footprints: '[]',
      Devices: '[]',
      DeviceName: JSON.stringify({ uuid: v.frameDeviceUuid, name: FRAME_DEVICE_NAME, source: '' })
    },
    zIndex: null
  }, frameCompId);
  return b.lines;
}

// ------------------------------------------------- SCH component block
// lib: staged library entry (kind 'device'). symbolAttrZ mirrors the symbol
// doc's Name/Designator zIndexes when known; defaults match the example.
function schComponentBlock(v) {
  // v: {compId, partId?, x, y, rotation, zIndex, symbolUuid, deviceUuid,
  //     deviceName, footprintUuid?, refdes, uniqueId, nameZ, designatorZ, symbolZ}
  const nameZ = v.nameZ !== undefined ? v.nameZ : 10;
  const designatorZ = v.designatorZ !== undefined ? v.designatorZ : 11;
  const symbolZ = v.symbolZ !== undefined ? v.symbolZ : 12;
  const lines = [];
  let t = v.ticketBase;
  const line = (type, body, id) => lines.push(formatRecord({ type, ticket: ++t, id }, body));

  line('COMPONENT', {
    partId: PART_ID,
    x: v.x, y: v.y, rotation: v.rotation || 0, isMirror: false,
    attrs: {
      Footprints: '[]',
      Devices: '[]',
      DeviceName: JSON.stringify({ uuid: v.deviceUuid, name: v.deviceName, source: '' }),
      FootprintName: null,
      pinClass: {},
      differentialPairClass: {},
      Symbols: '[]'
    },
    zIndex: v.zIndex
  }, v.compId);

  // Every ATTR head carries an id; the client links attrs to their owner
  // through the COMPONENT/WIRE head id recorded in parentId.
  line('ATTR', attrNull('Symbol', v.symbolUuid, symbolZ, v.compId), randId());
  line('ATTR', attrNull('Device', v.deviceUuid, -2, v.compId), randId());
  line('ATTR', attrNull('Unique ID', v.uniqueId, -5, v.compId), randId());
  line('ATTR', attrNull('Footprint', v.footprintUuid || null, -1, v.compId), randId());
  line('ATTR', attrStyled({
    x: v.x + 10, y: v.y + 10, fontSize: 6.75, fontWeight: false,
    italic: false, underline: false, value: null, valueVisible: true,
    key: 'Name', parentId: v.compId, zIndex: nameZ
  }), randId());
  line('ATTR', attrStyled({
    x: v.x + 10, y: v.y, fontSize: 6.75, fontWeight: false,
    italic: false, underline: false, value: v.refdes, valueVisible: true,
    key: 'Designator', parentId: v.compId, zIndex: designatorZ
  }), randId());
  line('ATTR', attrNull('Reuse Block', null, 32, v.compId), randId());
  line('ATTR', attrNull('Group ID', null, 33, v.compId), randId());
  line('ATTR', attrNull('Channel ID', null, 34, v.compId), randId());
  return { lines, nextTicket: t };
}

// ------------------------------------------------- SCH power component block
function powerComponentBlock(v) {
  // v: {compId, x, y, zIndex, symbolUuid, deviceUuid, net, style, ticketBase}
  const down = v.style === 'down';
  const lines = [];
  let t = v.ticketBase;
  const line = (type, body, id) => lines.push(formatRecord({ type, ticket: ++t, id }, body));

  line('COMPONENT', {
    partId: PART_ID,
    x: v.x, y: v.y, rotation: 0, isMirror: false,
    attrs: { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null },
    zIndex: v.zIndex
  }, v.compId);
  line('ATTR', attrStyled({
    x: v.x, y: v.y + 30, fontSize: down ? 10 : null,
    value: v.symbolUuid, key: 'Symbol', parentId: v.compId, zIndex: 1
  }), randId());
  line('ATTR', attrNull('Device', v.deviceUuid, down ? 18 : 12, v.compId), randId());
  line('ATTR', attrNull('Relevance', '[]', 0, v.compId), randId());
  const nameAlign = down ? 'CENTER_MIDDLE' : 'CENTER_BOTTOM';
  line('ATTR', attrNull('Name', v.net, down ? 3 : 9, v.compId, {
    x: v.x, y: down ? v.y + 25 : v.y - 10, align: nameAlign
  }), randId());
  line('ATTR', attrNull('Global Net Name', v.net, down ? 17 : 11, v.compId, {
    x: v.x, y: down ? v.y + 25 : v.y - 10, align: nameAlign
  }), randId());
  return { lines, nextTicket: t };
}

// ------------------------------------------------- port symbol doc (docType 19)
// NetPort symbol: pin stub pointing right into a labelled rectangle. Mirrors
// the power symbol doc layout (docType 18) with a RECT body instead of bars.
function buildPortSymbolDoc(spec) {
  const b = new DocBuilder();
  b.lines.push(docHeadLine('SYMBOL', spec.client, spec.uuid, spec.ms));
  b.add('META', {
    title: spec.title,
    description: '',
    tags: ['特殊器件', '网络标识'],
    docType: 19,
    source: spec.source
  }, 'META');

  const nulls = {
    rotation: 0, color: null, fontFamily: null, fontSize: null,
    fontWeight: null, italic: null, underline: null, align: 'CENTER_MIDDLE',
    fillColor: null, parentId: PART_ID, partId: PART_ID
  };
  b.add('ATTR', Object.assign({}, nulls, {
    x: 0, y: 25,
    value: spec.net, keyVisible: null, valueVisible: false,
    key: 'Global Net Name', zIndex: 11
  }));
  b.add('ATTR', Object.assign({}, nulls, {
    x: 0, y: 25,
    value: spec.net, keyVisible: null, valueVisible: true,
    key: 'Name', zIndex: 9
  }));

  b.add('CANVAS', { originX: 0, originY: 0 }, 'CANVAS');
  b.add('PART', { BBOX: [0, -7, 25, 7], title: '' }, PART_ID);

  b.add('ATTR', {
    partId: PART_ID, groupId: '', locked: false, zIndex: 1, parentId: '',
    key: 'Symbol', value: spec.title,
    keyVisible: false, valueVisible: false,
    x: 0, y: 30, rotation: 360, color: null, fillColor: null,
    fontFamily: null, fontSize: null,
    strikeout: null, underline: null, italic: null, fontWeight: null, align: null
  });

  const pinId = b.addElem('PIN', {
    partId: PART_ID, groupId: '', locked: false, zIndex: 3,
    display: true, x: 0, y: 0,
    length: 5, rotation: 0,
    color: null, pinShape: 'NONE'
  });
  const pinNulls = {
    color: null, fillColor: null, fontFamily: null, fontSize: null,
    strikeout: null, underline: null, italic: null, fontWeight: null, rotation: 0
  };
  const pinAttrs = [
    ['Pin Name', 'Pin1', { x: 2.5, y: -2, align: 'CENTER_BOTTOM' }],
    ['Pin Number', '1', { x: 2.5, y: 2, align: 'CENTER_TOP' }],
    ['Pin Type', 'IN', { x: 0, y: 0, align: 'CENTER_MIDDLE' }]
  ];
  pinAttrs.forEach(([key, value, pos], i) => {
    b.add('ATTR', Object.assign({
      partId: PART_ID, groupId: '', locked: false, zIndex: 4 + i,
      parentId: pinId, key, value,
      keyVisible: false, valueVisible: false
    }, pinNulls, pos));
  });

  b.addElem('RECT', {
    partId: PART_ID, groupId: '', locked: false, zIndex: 7,
    dotX1: 5, dotY1: -7, dotX2: 25, dotY2: 7,
    radiusX: 0, radiusY: 0, rotation: 0,
    strokeColor: null, strokeStyle: 'SOLID', fillColor: null,
    strokeWidth: 1, fillStyle: 'NONE'
  });
  return b.lines;
}

// ------------------------------------------------- SCH port component block
function portComponentBlock(v) {
  // v: {compId, x, y, zIndex, symbolUuid, deviceUuid, net, ticketBase}
  const lines = [];
  let t = v.ticketBase;
  const line = (type, body, id) => lines.push(formatRecord({ type, ticket: ++t, id }, body));

  line('COMPONENT', {
    partId: PART_ID,
    x: v.x, y: v.y, rotation: 0, isMirror: false,
    attrs: { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null },
    zIndex: v.zIndex
  }, v.compId);
  line('ATTR', attrStyled({
    x: v.x, y: v.y + 30, fontSize: null,
    value: v.symbolUuid, key: 'Symbol', parentId: v.compId, zIndex: 1
  }), randId());
  line('ATTR', attrNull('Device', v.deviceUuid, 12, v.compId), randId());
  line('ATTR', attrNull('Relevance', '[]', 0, v.compId), randId());
  line('ATTR', attrNull('Name', v.net, 9, v.compId, {
    x: v.x + 15, y: v.y, align: 'CENTER_MIDDLE'
  }), randId());
  line('ATTR', attrNull('Global Net Name', v.net, 11, v.compId, {
    x: v.x + 15, y: v.y, align: 'CENTER_MIDDLE'
  }), randId());
  return { lines, nextTicket: t };
}

// ------------------------------------------------- SCH special component block
// Power-family block for special symbols (differential-pair flag, short
// marker): no Global Net Name attr, page Name shows the entry title. Placement
// behavior of these entries in the real client is unverified.
function specialComponentBlock(v) {
  // v: {compId, x, y, zIndex, symbolUuid, deviceUuid, name, ticketBase}
  const lines = [];
  let t = v.ticketBase;
  const line = (type, body, id) => lines.push(formatRecord({ type, ticket: ++t, id }, body));

  line('COMPONENT', {
    partId: PART_ID,
    x: v.x, y: v.y, rotation: 0, isMirror: false,
    attrs: { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null },
    zIndex: v.zIndex
  }, v.compId);
  line('ATTR', attrStyled({
    x: v.x, y: v.y + 30, fontSize: null,
    value: v.symbolUuid, key: 'Symbol', parentId: v.compId, zIndex: 1
  }), randId());
  line('ATTR', attrNull('Device', v.deviceUuid, 12, v.compId), randId());
  line('ATTR', attrNull('Relevance', '[]', 0, v.compId), randId());
  line('ATTR', attrNull('Name', v.name, 9, v.compId, {
    x: v.x, y: v.y + 25, align: 'CENTER_MIDDLE'
  }), randId());
  return { lines, nextTicket: t };
}

// ------------------------------------------------- SCH wire block
function wireBlock(v) {
  // v: {segs:[{startX,startY,endX,endY}], net?, zIndex, ticketBase}
  const wireId = randId();
  const xs = [], ys = [];
  for (const s of v.segs) { xs.push(s.startX, s.endX); ys.push(s.startY, s.endY); }
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const vertical = v.segs.length === 1 && v.segs[0].startX === v.segs[0].endX;
  const lines = [];
  let t = v.ticketBase;
  const line = (type, body, id) => lines.push(formatRecord({ type, ticket: ++t, id }, body));

  line('WIRE', { zIndex: v.zIndex }, wireId);
  for (const s of v.segs) {
    line('LINE', {
      fillColor: null, fillStyle: null, strokeColor: null, strokeStyle: null,
      strokeWidth: null,
      startX: s.startX, startY: s.startY, endX: s.endX, endY: s.endY,
      lineGroup: wireId
    }, randId());
  }
  line('ATTR', {}, randId()); // empty ATTR stub: id in the head, `|||` body
  line('ATTR', attrNull('Relevance', '[]', 6, wireId), randId());
  // A named wire carries a NET attr; client-generated unnamed wires omit it.
  if (v.net) {
    line('ATTR', Object.assign(attrNull('NET', v.net, 7, wireId), {
      x: midX, y: midY, rotation: vertical ? 90 : 0,
      keyVisible: false, valueVisible: true
    }), randId());
  }
  return { lines, nextTicket: t, wireId };
}

// ------------------------------------------------- SCH page graphics
// Free TEXT / shape primitives on a sheet. The official example only carries
// these inside SYMBOL docs (with partId); page-level copies drop partId and
// use positive display-order zIndexes like wires/components.

// Real TEXT record shape (sim page symbol doc): x,y,rotation,color,
// fontFamily,fontSize,fontWeight,italic,underline,align,value,fillColor,zIndex
function schTextLine(v) {
  // v: {x, y, value, rotation?, fontSize?, align?, zIndex, ticketBase}
  // groupId/locked follow the format-skill TSchText page sample.
  return formatRecord({ type: 'TEXT', ticket: v.ticketBase, id: randId() }, {
    x: v.x, y: v.y,
    rotation: v.rotation !== undefined ? v.rotation : 0,
    color: null, fontFamily: null,
    fontSize: v.fontSize !== undefined ? v.fontSize : null,
    fontWeight: null, italic: null, underline: null,
    align: v.align !== undefined ? v.align : null,
    value: v.value,
    fillColor: null,
    zIndex: v.zIndex,
    groupId: '', locked: false
  });
}

const SCH_STROKE = {
  strokeColor: null, strokeStyle: 'SOLID', fillColor: null,
  strokeWidth: 1, fillStyle: 'NONE'
};

function schRectLine(v) {
  // v: {x1,y1,x2,y2, rotation?, radiusX?, radiusY?, zIndex, ticketBase}
  return formatRecord({ type: 'RECT', ticket: v.ticketBase, id: randId() }, {
    groupId: '', locked: false, zIndex: v.zIndex,
    dotX1: v.x1, dotY1: v.y1, dotX2: v.x2, dotY2: v.y2,
    radiusX: v.radiusX !== undefined ? v.radiusX : 0,
    radiusY: v.radiusY !== undefined ? v.radiusY : 0,
    rotation: v.rotation !== undefined ? v.rotation : 0,
    ...SCH_STROKE
  });
}

function schPolyLine(v) {
  // v: {points:[{x,y}...], closed?, zIndex, ticketBase}
  return formatRecord({ type: 'POLY', ticket: v.ticketBase, id: randId() }, {
    groupId: '', locked: false, zIndex: v.zIndex,
    points: v.points,
    closed: !!v.closed,
    ...SCH_STROKE
  });
}

// 3-point arc: start / end + a third point the arc passes through.
function schArcLine(v) {
  // v: {startX,startY,referX,referY,endX,endY, zIndex, ticketBase}
  return formatRecord({ type: 'ARC', ticket: v.ticketBase, id: randId() }, {
    groupId: '', locked: false, zIndex: v.zIndex,
    startX: v.startX, startY: v.startY,
    referX: v.referX, referY: v.referY,
    endX: v.endX, endY: v.endY,
    ...SCH_STROKE
  });
}

function schCircleLine(v) {
  // v: {cx, cy, r, zIndex, ticketBase}
  return formatRecord({ type: 'CIRCLE', ticket: v.ticketBase, id: randId() }, {
    groupId: '', locked: false, zIndex: v.zIndex,
    centerX: v.cx, centerY: v.cy, radius: v.r,
    ...SCH_STROKE
  });
}

// controls: flat [x1,y1,x2,y2,x3,y3,x4,y4] cubic control points (4 points).
function schBezierLine(v) {
  return formatRecord({ type: 'BEZIER', ticket: v.ticketBase, id: randId() }, {
    groupId: '', locked: false, zIndex: v.zIndex,
    controls: v.controls,
    ...SCH_STROKE
  });
}

function schEllipseLine(v) {
  // v: {cx, cy, rx, ry, rotation?, zIndex, ticketBase}
  return formatRecord({ type: 'ELLIPSE', ticket: v.ticketBase, id: randId() }, {
    groupId: '', locked: false, zIndex: v.zIndex,
    centerX: v.cx, centerY: v.cy,
    radiusX: v.rx, radiusY: v.ry,
    rotation: v.rotation !== undefined ? v.rotation : 0,
    ...SCH_STROKE
  });
}

// ------------------------------------------------- PCB component block
function pcbComponentBlock(v) {
  // v: {compId, x, y, angle, deviceUuid, deviceName, footprintUuid, refdes,
  //     uniqueId, pads:[{num,elemId}], attrFootprint, attrDesignator,
  //     zIndexFootprint, zIndexDesignator, ticketBase}
  const lines = [];
  let t = v.ticketBase;
  const line = (type, body, id) => lines.push(formatRecord({ type, ticket: ++t, id }, body));

  const pinSwapInfo = {};
  for (const p of v.pads) {
    line('PAD_NET', {
      partitionId: '', padNet: p.net || '', padLen: null,
      propagationDelay: null, attrsMap: {}
    }, `["PAD_NET","${v.compId}","${p.num}","${p.elemId}"]`);
    pinSwapInfo[v.compId + p.elemId] = { pinClass: '', differentialPairClass: '' };
  }
  line('COMPONENT', {
    partitionId: '', groupId: 0, layerId: 1,
    x: v.x, y: v.y, angle: v.angle !== undefined ? v.angle : 0,
    attrs: {
      'Reuse Block': '',
      'Group ID': '',
      'Channel ID': '',
      'Unique ID': v.uniqueId,
      DeviceName: JSON.stringify({ name: v.deviceName, source: '', uuid: v.deviceUuid })
    },
    locked: false, zIndex: -1,
    pinSwap: false, pinSwapInfo, footprintPrimitives: true
  }, v.compId);

  const pcbAttr = (over) => Object.assign({
    partitionId: '', groupID: 0, parentId: v.compId, layerId: 3,
    x: null, y: null, key: null, value: null,
    keyVisible: false, valueVisible: false,
    fontFamily: 'default', fontSize: 45, strokeWidth: 6,
    bold: 0, italic: 0, origin: 'LEFT_BOTTOM', angle: 90,
    reverse: false, expansion: 0, mirror: false, locked: false,
    zIndex: -1, specialColor: null
  }, over);

  line('ATTR', pcbAttr({
    key: 'Footprint', value: v.footprintUuid,
    zIndex: v.zIndexFootprint
  }), v.compId + v.attrFootprint);
  line('ATTR', pcbAttr({
    x: v.x, y: v.y, key: 'Designator', value: v.refdes,
    valueVisible: true, zIndex: v.zIndexDesignator
  }), v.compId + v.attrDesignator);
  line('ATTR', pcbAttr({
    key: 'Device', value: v.deviceUuid, zIndex: -1
  }), v.compId + 'e0');
  return { lines, nextTicket: t };
}

// ------------------------------------------------- PCB track / net
function pcbTrackLine(v) {
  // v: {netName, layerId?, startX, startY, endX, endY, width?, ticketBase}
  return formatRecord({ type: 'LINE', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0, netName: v.netName || '',
    layerId: v.layerId || 1,
    startX: v.startX, startY: v.startY, endX: v.endX, endY: v.endY,
    width: v.width !== undefined ? v.width : 10,
    locked: false, zIndex: -1
  });
}

function pcbNetLine(netName, ticket) {
  return formatRecord({ type: 'NET', ticket, id: `["NET","${netName}"]` }, {
    netType: null, specialColor: null, retLine: true,
    differentialName: null, isPositiveNet: false, equalLengthGroupName: null
  });
}

// ------------------------------------------------- PCB graphics / via / pour
// PCB primitives: partitionId "" + groupId 0 + locked false + zIndex -1, as in
// every real PCB record. path is a mil path array ([x0,y0,'L',...] polygon or
// ['R',x,y,w,h,rot,isCCW,round] rect or ['CIRCLE',cx,cy,r,isCCW]).

// Rect path encoding: ["R", x, y0, w, h] covers x∈[x, x+w], y∈[y0-h, y0] —
// the anchor is the MIN-x / MAX-y corner and h extends toward -y. Verified
// against the official example (board ["R",0,940,1475,940,0,0] covering
// [0,1475]×[0,940]) and a real-client project (["R",-80,-200,670,550,0,0]
// containing all of its routed geometry). Callers pass the bottom-left corner
// + size in the same space as component placements; y0 = y + h.
function rectPath(x, y, w, h) {
  return ['R', x, y + h, w, h, 0, 0];
}
function pcbPolyLine(v) {
  // v: {netName?, layerId?, width?, path, ticketBase}
  return formatRecord({ type: 'POLY', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0, netName: v.netName || '',
    layerId: v.layerId !== undefined ? v.layerId : 1,
    width: v.width !== undefined ? v.width : 2,
    path: v.path, locked: false, zIndex: -1, polyType: 'NORMAL'
  });
}

// Two-point arc: start + end + signed sweep angle (CCW positive).
// arcType DOT = two-point arc, CENT = center arc; field order follows the
// format-skill example.
function pcbArcLine(v) {
  // v: {netName?, layerId?, startX, startY, endX, endY, angle, width?, arcType?, ticketBase}
  return formatRecord({ type: 'ARC', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0, layerId: v.layerId !== undefined ? v.layerId : 1,
    netName: v.netName || '',
    startX: v.startX, startY: v.startY, endX: v.endX, endY: v.endY,
    angle: v.angle,
    width: v.width !== undefined ? v.width : 10,
    arcType: v.arcType !== undefined ? v.arcType : 'DOT',
    locked: false, zIndex: -1
  });
}

// PCB text. Body follows the format-skill TPcbString example: x/y (not
// positionX/Y), EAlign string origin, reverse/expansion, boolean mirror.
// Bottom-layer text defaults to mirror true.
const PCB_ALIGN = ['LEFT_BOTTOM', 'CENTER_BOTTOM', 'RIGHT_BOTTOM', 'LEFT_MIDDLE',
  'CENTER_MIDDLE', 'RIGHT_MIDDLE', 'LEFT_TOP', 'CENTER_TOP', 'RIGHT_TOP'];
function pcbStringLine(v) {
  // v: {text, x, y, layerId?, fontSize?, origin?(0-8), angle?, mirror?, ticketBase}
  const layerId = v.layerId !== undefined ? v.layerId : 1;
  return formatRecord({ type: 'STRING', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0, layerId,
    x: v.x, y: v.y,
    text: v.text,
    fontFamily: 'default',
    fontSize: v.fontSize !== undefined ? v.fontSize : 60,
    strokeWidth: 6,
    bold: 0, italic: 0,
    origin: PCB_ALIGN[v.origin !== undefined ? v.origin : 4],
    angle: v.angle !== undefined ? v.angle : 0,
    reverse: false, expansion: 0,
    mirror: v.mirror !== undefined ? v.mirror : layerId === 2,
    locked: false, zIndex: -1
  });
}

// Via. Diameters follow the example PCB's PREFERENCE lastViaDiameter 24.0158 /
// lastViaInnerDiameter 12.0078 mil. viaType is the EViaType string enum
// (NORMAL/BLIND/SUTURE, default NORMAL); unusedInnerLayers hides pad layers.
function pcbViaLine(v) {
  // v: {netName?, x, y, viaDiameter?, holeDiameter?, ruleName?, viaType?, unusedInnerLayers?, ticketBase}
  return formatRecord({ type: 'VIA', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0,
    netName: v.netName || '',
    ruleName: v.ruleName !== undefined ? v.ruleName : 'viaSize',
    centerX: v.x, centerY: v.y,
    holeDiameter: v.holeDiameter !== undefined ? v.holeDiameter : 12.0078,
    viaDiameter: v.viaDiameter !== undefined ? v.viaDiameter : 24.0158,
    viaType: v.viaType !== undefined ? v.viaType : 'NORMAL',
    topSolderExpansion: null, bottomSolderExpansion: null,
    unusedInnerLayers: v.unusedInnerLayers !== undefined ? v.unusedInnerLayers : [],
    locked: false, zIndex: -1
  });
}

// Copper pour. path is an ARRAY of polygon arrays (real example: [["R",...]]).
// pourType SOLID is the only fill mode backed by a real client record; width
// 0.2 as in the example.
function pcbPourLine(v) {
  // v: {netName, layerId?, path, width?, name?, order?, style?, fineness?, ticketBase}
  return formatRecord({ type: 'POUR', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0,
    netName: v.netName || '',
    layerId: v.layerId !== undefined ? v.layerId : 1,
    width: v.width !== undefined ? v.width : 0.2,
    name: v.name !== undefined ? v.name : 'POUR1',
    order: v.order !== undefined ? v.order : 0,
    path: v.path,
    pourType: {
      pourType: v.style !== undefined ? v.style : 'SOLID',
      fineness: v.fineness !== undefined ? v.fineness : 8
    },
    keepIsland: false, locked: false, zIndex: -1
  });
}

// Static copper fill. Body mirrors the real FILL records in the example
// (footprint docs), adapted to main-doc conventions (partitionId "", zIndex -1).
// fillStyle 'SOLID' is the only mode backed by a real record.
function pcbFillLine(v) {
  // v: {netName?, layerId?, path, width?, style?, ticketBase}
  return formatRecord({ type: 'FILL', ticket: v.ticketBase, id: randId() }, {
    partitionId: '', groupId: 0,
    netName: v.netName || '',
    layerId: v.layerId !== undefined ? v.layerId : 1,
    width: v.width !== undefined ? v.width : 0.2,
    fillStyle: v.style !== undefined ? v.style : 'SOLID',
    path: v.path,
    locked: false, zIndex: -1,
    isBridgingCopper: false, networkList: [], refs: []
  });
}

// Keepout region. prohibitType uses the EProhibitType string enum (COMPONENT,
// VIA, TRACK, FILL, COPPER, PLANE); regionType: PROHIBIT (keepout) or
// CONSTRAINT. Field order follows the format-skill example.
function pcbRegionLine(v) {
  // v: {layerId?, path, width?, prohibit:[names], regionType?, name?, ticketBase}
  const body = {
    partitionId: '', groupId: 0,
    layerId: v.layerId !== undefined ? v.layerId : 1,
    width: v.width !== undefined ? v.width : 1,
    prohibitType: v.prohibit,
    path: v.path,
    locked: false, zIndex: -1,
    regionType: v.regionType !== undefined ? v.regionType : 'PROHIBIT'
  };
  if (v.name !== undefined) body.name = v.name;
  return formatRecord({ type: 'REGION', ticket: v.ticketBase, id: randId() }, body);
}

// Renumber the main-doc records (after lastDocHead) to consecutive tickets so
// they stay increasing in file order, as in the example. Library docs keep
// their per-doc ticket scopes.
function renumberMainDoc(lines, lastDocHead) {
  let t = 0;
  for (let i = lastDocHead + 1; i < lines.length; i++) {
    const r = parseRecord(lines[i]);
    if (!r || typeof r.ticket !== 'number') continue;
    lines[i] = formatRecord({ type: r.type, ticket: ++t, id: r.id }, r.body);
  }
  return t;
}

// Main-doc area of a container = everything after the LAST DOCHEAD line.
function lastDocHeadIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{"type":"DOCHEAD"}')) return i;
  }
  return -1;
}

// Display-order zIndex for the next SCH component/wire (positive ints only).
function nextMainZIndex(lines) {
  let max = 0;
  for (let i = lastDocHeadIndex(lines) + 1; i < lines.length; i++) {
    const r = parseRecord(lines[i]);
    const z = r && r.body ? r.body.zIndex : undefined;
    if (typeof z === 'number' && z > max) max = z;
  }
  return max + 1;
}

// Unique IDs are "gge"+n, numbered per document. SCH keeps them in ATTR
// records, PCB inside COMPONENT.attrs — count both.
function nextUniqueId(lines) {
  let n = 0;
  for (let i = lastDocHeadIndex(lines) + 1; i < lines.length; i++) {
    const r = parseRecord(lines[i]);
    if (!r) continue;
    if (r.type === 'ATTR' && r.body && r.body.key === 'Unique ID') {
      const m = /^gge(\d+)$/.exec(String(r.body.value));
      n = Math.max(n, m ? Number(m[1]) : n + 1);
    } else if (r.type === 'COMPONENT' && r.body && r.body.attrs && r.body.attrs['Unique ID']) {
      const m = /^gge(\d+)$/.exec(String(r.body.attrs['Unique ID']));
      n = Math.max(n, m ? Number(m[1]) : n + 1);
    }
  }
  return 'gge' + (n + 1);
}

// The example places named NET records right after the empty NET and before
// the first component. Nets already present are skipped; returns inserted names.
function ensurePcbNets(filePath, nets) {
  const lines = readLines(filePath);
  let lastHead = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{"type":"DOCHEAD"}')) { lastHead = i; break; }
  }
  if (lastHead < 0) throw new Error(`no DOCHEAD in ${filePath}`);
  const present = new Set();
  let lastNet = -1;
  for (let i = lastHead + 1; i < lines.length; i++) {
    const r = parseRecord(lines[i]);
    if (!r || r.type !== 'NET') continue;
    try {
      const arr = JSON.parse(r.id);
      if (Array.isArray(arr) && arr[0] === 'NET') {
        present.add(arr[1]);
        lastNet = i;
      }
    } catch { /* keep scanning */ }
  }
  const add = (nets || []).filter((n) => n && !present.has(n));
  if (add.length) {
    lines.splice(lastNet + 1, 0, ...add.map((n) => pcbNetLine(n, 0)));
    renumberMainDoc(lines, lastHead);
    writeLines(filePath, lines);
  }
  return add;
}

// ---------------------------------------------------------------- project
function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class Project {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.name = path.basename(rootDir);
    this.indexFile = path.join(rootDir, `${this.name}.eprj3`);
    this.index = null;
  }

  get profile() { return this.index.profile; }
  get client() { return clientIdFrom(this.index.owner_uuid); }

  static load(rootDir) {
    const p = new Project(rootDir);
    if (!fs.existsSync(p.indexFile)) {
      throw new Error(`Project index not found: ${p.indexFile}`);
    }
    p.index = JSON.parse(fs.readFileSync(p.indexFile, 'utf8'));
    if (!p.index.profile || p.index.format !== 'folder') {
      throw new Error(`Not a folder-format eprj3 project: ${p.indexFile}`);
    }
    return p;
  }

  static create(rootDir, name) {
    const finalName = name || path.basename(rootDir);
    const indexFile = path.join(rootDir, `${finalName}.eprj3`);
    if (fs.existsSync(indexFile)) {
      throw new Error(`Project index already exists: ${indexFile}. Pick another --dir/--name or remove it first.`);
    }
    fs.mkdirSync(rootDir, { recursive: true });
    const p = new Project(rootDir);
    p.name = finalName;
    p.indexFile = indexFile;
    const now = Date.now();
    const owner = uuid32();
    p.index = {
      name: finalName,
      owner_uuid: owner,
      creator_uuid: owner,
      created_at: formatDate(now),
      updated_at: formatDate(now),
      modifier_uuid: owner,
      content: '',
      archive: false,
      cbb_project: 0,
      thumb: '',
      ticket: 1,
      g_ticket: 1,
      boards: [],
      block_symbol_attrs_groups: {},
      default_sheet: '',
      branch_uuid: '',
      pcb_count: 0,
      format: 'folder',
      profile: {
        boards: {},
        schematics: {},
        sheets: {},
        pcbs: {},
        panels: {},
        blockSymbols: {},
        owner: { uuid: owner },
        simSchematics: {},
        simulations: {}
      },
      config: { defaultSheet: '', settings: {} }
    };
    fs.mkdirSync(path.join(rootDir, 'sch'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'pcb'), { recursive: true });
    // No panel by default — it is optional and created on demand (ensurePanelDocument).
    p.save();
    return p;
  }

  save() {
    this.index.updated_at = formatDate(Date.now());
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  ms() { return Date.now(); }

  // ------------------------------------------------------------ board
  ensureBoard() {
    const keys = Object.keys(this.profile.boards);
    if (keys.length) return this.profile.boards[keys[0]];
    const boardUuid = uuid16();
    const board = { uuid: boardUuid, title: 'Board1', zIndex: 1 };
    this.profile.boards[boardUuid] = board;
    this.save();
    return board;
  }

  boardTitle(boardUuid) {
    const b = this.profile.boards[boardUuid];
    return b ? b.title : '';
  }

  // ------------------------------------------------------------ schematic
  ensureSchematic(name) {
    this.ensureBoard();
    let sch = Object.values(this.profile.schematics).find((s) => s.name === name);
    if (sch) return sch;
    const board = Object.values(this.profile.boards)[0];
    sch = {
      uuid: uuid16(),
      name,
      board: board.uuid,
      source: '',
      version: String(this.ms()),
      updateTime: this.ms()
    };
    this.profile.schematics[sch.uuid] = sch;
    const dir = path.join(this.rootDir, 'sch', name);
    fs.mkdirSync(dir, { recursive: true });
    // .ecfg is the schematic container doc; .evar (variant data) stays empty.
    writeLines(path.join(dir, `${name}.ecfg`), buildEcfgDoc(sch, this.client, this.ms()));
    fs.writeFileSync(path.join(dir, `${name}.evar`), '', 'utf8');
    this.save();
    return sch;
  }

  ensureSheet(sch, title) {
    let sheet = Object.values(this.profile.sheets)
      .find((s) => s.schematic_uuid === sch.uuid && s.title === title);
    if (sheet) return sheet;
    sheet = {
      uuid: uuid16(),
      title,
      schematic_uuid: sch.uuid,
      zIndex: Object.values(this.profile.sheets)
        .filter((s) => s.schematic_uuid === sch.uuid).length + 1,
      source: '',
      version: String(this.ms()),
      updateTime: this.ms()
    };
    this.profile.sheets[sheet.uuid] = sheet;
    this.save();
    return sheet;
  }

  schematicDir(sch) { return path.join(this.rootDir, 'sch', sch.name); }
  sheetFile(sheet) {
    const sch = this.profile.schematics[sheet.schematic_uuid];
    return path.join(this.schematicDir(sch), `${sheet.title}.esch2`);
  }
  ecfgFile(sch) { return path.join(this.schematicDir(sch), `${sch.name}.ecfg`); }

  // ------------------------------------------------------------ pcb
  ensurePcb(name) {
    this.ensureBoard();
    let pcb = Object.values(this.profile.pcbs).find((p) => p.title === name);
    if (pcb) return pcb;
    const board = Object.values(this.profile.boards)[0];
    pcb = {
      uuid: uuid16(),
      title: name,
      board: board.uuid,
      parent_uuid: '',
      source: '',
      version: String(this.ms()),
      updateTime: this.ms()
    };
    this.profile.pcbs[pcb.uuid] = pcb;
    this.index.pcb_count = Object.keys(this.profile.pcbs).length;
    this.save();
    return pcb;
  }

  pcbFile(pcb) { return path.join(this.rootDir, 'pcb', `${pcb.title}.epcb2`); }

  // ------------------------------------------------------------ library
  // Preset templates (skill-owned, read-only at runtime) resolve first, then
  // this project's staging area.
  tmpLibraryDir() { return path.join(this.rootDir, '.tmp', 'library'); }
  resolveLibraryFile(name) {
    const preset = libraryFileIn(LIBRARY_DIR, name);
    if (preset) return { file: preset, src: 'preset' };
    const tmp = libraryFileIn(this.tmpLibraryDir(), name);
    if (tmp) return { file: tmp, src: 'tmp' };
    return null;
  }
  presetHas(name) { return libraryFileIn(LIBRARY_DIR, name) !== null; }
  loadLibrary(name) {
    const hit = this.resolveLibraryFile(name);
    return hit ? JSON.parse(fs.readFileSync(hit.file, 'utf8')) : null;
  }
  saveLibrary(entry) {
    const sub = entry.kind === 'footprint' ? 'footprint' : 'symbol';
    const dir = path.join(this.tmpLibraryDir(), sub);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${entry.name}.json`), JSON.stringify(entry, null, 2), 'utf8');
  }
  listLibrary() {
    const merged = [];
    for (const n of listLibraryDir(LIBRARY_DIR)) merged.push({ name: n, src: 'preset' });
    for (const n of listLibraryDir(this.tmpLibraryDir())) {
      if (!merged.some((e) => e.name === n)) merged.push({ name: n, src: 'tmp' });
    }
    return merged;
  }

  // ------------------------------------------------------------ ensure docs
  // Creates schematic+sheet in the index and the .esch2 file containing
  // [A4 frame SYMBOL doc, frame DEVICE doc, SCH_PAGE doc].
  ensureSheetDocument(schematicName, sheetTitle) {
    const sch = this.ensureSchematic(schematicName);
    const sheet = this.ensureSheet(sch, sheetTitle);
    const file = this.sheetFile(sheet);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim() === '') {
      const ms = this.ms();
      const source = makeSource(uuid32(), this.index.owner_uuid);
      const frameSymbolUuid = uuid16();
      const frameDeviceUuid = uuid16();
      const frameLines = buildFrameDocs({
        symbolUuid: frameSymbolUuid,
        deviceUuid: frameDeviceUuid,
        client: this.client,
        ms,
        source
      });
      const now = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      const pageLines = buildSheetPageDoc({
        sheetUuid: sheet.uuid,
        sheetTitle: sheet.title,
        schematicUuid: sch.uuid,
        schematicName: sch.name,
        boardTitle: this.boardTitle(sch.board),
        projectName: this.index.name,
        dateStr: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        timeStr: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        frameSymbolUuid,
        frameDeviceUuid,
        client: this.client,
        ms
      });
      writeLines(file, frameLines.concat(pageLines));
    }
    return { sch, sheet, file };
  }

  // Creates the pcb in the index and the .epcb2 file containing the full
  // preamble (layers / rules / preferences) + empty NET + RULE_SELECTOR +
  // board outline.
  ensurePcbDocument(name, opts) {
    const pcb = this.ensurePcb(name);
    const file = this.pcbFile(pcb);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim() === '') {
      const lines = buildPcbPreamble({
        uuid: pcb.uuid,
        title: pcb.title,
        board: pcb.board,
        client: this.client,
        ms: this.ms(),
        outline: (opts && opts.outline) || rectPath(0, 0, 4000, 3000)
      });
      writeLines(file, lines);
    }
    return { pcb, file };
  }

  // Optional panel document — only created when requested (init.js --panel).
  ensurePanelDocument(title = 'Panel1') {
    let panel = Object.values(this.profile.panels).find((p) => p.title === title);
    if (!panel) {
      panel = { uuid: uuid16(), title, zIndex: null };
      this.profile.panels[panel.uuid] = panel;
      this.save();
    }
    const file = path.join(this.rootDir, 'panel', `${panel.title}.epan2`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeLines(file, buildPanelDoc(panel.uuid, this.client, this.ms(), panel.title));
    }
    return { panel, file };
  }

  // ------------------------------------------------------------ get-or-die
  requireSchematic(name) {
    const sch = Object.values(this.profile.schematics).find((s) => s.name === name);
    if (!sch) {
      const known = Object.values(this.profile.schematics).map((s) => s.name).join(', ') || 'none';
      throw new Error(`Schematic not found: "${name}" (existing: ${known})`);
    }
    return sch;
  }

  requireSheet(schematicName, sheetTitle) {
    const sch = this.requireSchematic(schematicName);
    const sheet = Object.values(this.profile.sheets)
      .find((s) => s.schematic_uuid === sch.uuid && s.title === sheetTitle);
    if (!sheet) throw new Error(`Sheet not found: "${sheetTitle}" in schematic "${schematicName}"`);
    return { sch, sheet };
  }

  requirePcb(name) {
    const pcb = Object.values(this.profile.pcbs).find((p) => p.title === name);
    if (!pcb) throw new Error(`PCB not found: "${name}"`);
    return pcb;
  }
}

module.exports = {
  uuid,
  uuid16,
  uuid32,
  randId,
  PART_ID,
  clientIdFrom,
  makeSource,
  parseRecord,
  readLines,
  readRecords,
  formatRecord,
  writeLines,
  writeRecords,
  maxTicketOfLines,
  appendLines,
  appendRecord,
  updateRecord,
  removeRecord,
  insertDocsBeforeMain,
  rewriteDocHeads,
  LIBRARY_DIR,
  libraryFileIn,
  listLibraryDir,
  readDocHeadUuid,
  DocBuilder,
  docHeadLine,
  buildSymbolDoc,
  buildPowerSymbolDoc,
  buildFootprintDoc,
  buildDeviceDoc,
  buildEcfgDoc,
  buildPanelDoc,
  buildSheetPageDoc,
  schComponentBlock,
  powerComponentBlock,
  portComponentBlock,
  specialComponentBlock,
  buildPortSymbolDoc,
  wireBlock,
  schTextLine,
  schRectLine,
  schPolyLine,
  schArcLine,
  schCircleLine,
  schBezierLine,
  schEllipseLine,
  pcbComponentBlock,
  pcbTrackLine,
  pcbNetLine,
  pcbPolyLine,
  rectPath,
  pcbArcLine,
  pcbStringLine,
  pcbViaLine,
  pcbPourLine,
  pcbFillLine,
  pcbRegionLine,
  renumberMainDoc,
  ensurePcbNets,
  lastDocHeadIndex,
  nextMainZIndex,
  nextUniqueId,
  attrNull,
  attrStyled,
  Project,
  formatDate
};
