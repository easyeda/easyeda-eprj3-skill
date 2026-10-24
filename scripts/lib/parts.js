'use strict';
/**
 * parts.js — turn library entries into electrical geometry.
 *
 * A library entry (preset template or `<project>/.tmp/library` staging file) is
 * a bag of pre-formatted record lines. Everything an author needs out of it is
 * derived here: pin connection points, pad centres, body boxes, designator
 * prefix. No client, no project required — these are pure functions over an
 * entry object, which makes them testable.
 *
 * The same module can synthesise entries from an inline spec, so a design file
 * can define a part without a separate `generate-symbol.js` round trip.
 */

const E = require('./eprj3');
const G = require('./geom');

const PIN_LEN = 10;
const SYMBOL_DOC_TYPES = { 2: 'symbol', 18: 'power', 19: 'port' };

function recordsOf(lines) {
  return (lines || []).map(E.parseRecord).filter(Boolean);
}

function docTypeOf(lines) {
  for (const r of recordsOf(lines)) {
    if (r.type === 'META' && r.body && typeof r.body.docType === 'number') return r.body.docType;
  }
  return undefined;
}

/**
 * Pins of a symbol entry, in symbol space plus the tip in symbol space.
 * tip = the far end of the pin stub — the point wires must touch.
 */
function parseSymbolEntry(entry) {
  const lines = entry.symbolDoc || entry.powerSymbolDoc || entry.portSymbolDoc || entry.deviceDoc || [];
  const docType = docTypeOf(lines);
  const kind = entry.kind || SYMBOL_DOC_TYPES[docType] || 'symbol';
  const recs = recordsOf(lines);
  const pins = [];
  const byId = new Map();
  for (const r of recs) {
    if (r.type === 'PIN') {
      const pin = {
        num: '',
        name: '',
        type: 'Undefined',
        x: r.body.x,
        y: r.body.y,
        length: r.body.length === undefined ? PIN_LEN : r.body.length,
        rotation: r.body.rotation || 0,
        elemId: r.id
      };
      // Power flags / net ports are placed by their ORIGIN, not by the stub end:
      // the symbol body is drawn away from the connection point.
      if (docType === 18 || docType === 19 || pin.length === 0) {
        pin.x = 0;
        pin.y = 0;
        pin.length = 0;
      }
      pin.tip = G.pinTip(pin, 0, 0, 0);
      pins.push(pin);
      byId.set(r.id, pin);
    }
  }
  for (const r of recs) {
    if (r.type !== 'ATTR' || !r.body || !r.body.parentId) continue;
    const pin = byId.get(r.body.parentId);
    if (!pin) continue;
    if (r.body.key === 'Pin Number') pin.num = String(r.body.value);
    else if (r.body.key === 'Pin Name') pin.name = String(r.body.value);
    else if (r.body.key === 'Pin Type') pin.type = String(r.body.value);
  }
  for (const p of pins) {
    if (!p.num) p.num = p.name || String(pins.indexOf(p) + 1);
    if (!p.name) p.name = p.num;
  }

  let bbox = null;
  for (const r of recs) {
    if (r.type === 'PART' && Array.isArray(r.body.BBOX)) {
      const b = r.body.BBOX;
      bbox = G.rect(b[0], b[1], b[2], b[3]);
      break;
    }
  }
  if (!bbox && pins.length) {
    const pts = pins.map((p) => p.tip).concat(pins.map((p) => ({ x: p.x, y: p.y })));
    bbox = G.bboxOfPoints(pts);
  }
  let designator;
  for (const r of recs) {
    if (r.type === 'ATTR' && r.body && r.body.key === 'Designator' && r.body.parentId === '') {
      designator = r.body.value;
      break;
    }
  }
  return {
    kind,
    docType,
    title: entry.title || entry.name,
    name: entry.name,
    designator: entry.designator || designator || 'U?',
    bbox,
    pins,
    pinByNum: new Map(pins.map((p) => [String(p.num), p]))
  };
}

/** Absolute tip of a pin on a placed component. */
function placedTip(sym, pinNum, x, y, rotation) {
  const pin = sym.pinByNum.get(String(pinNum));
  if (!pin) return null;
  return G.pinTip(pin, x, y, rotation || 0);
}

/** All absolute pin tips of a placed component: [{num, name, type, x, y}]. */
function placedPins(sym, x, y, rotation) {
  return sym.pins.map((p) => {
    const t = G.pinTip(p, x, y, rotation || 0);
    return { num: String(p.num), name: p.name, type: p.type, x: t.x, y: t.y };
  });
}

/** Pad centres of a footprint entry (pad geometry is real footprint space). */
function parseFootprintEntry(entry) {
  const recs = recordsOf(entry.footprintDoc || []);
  const pads = [];
  for (const r of recs) {
    if (r.type !== 'PAD') continue;
    const b = r.body;
    const d = b.defaultPad || {};
    pads.push({
      num: String(b.num),
      x: b.centerX,
      y: b.centerY,
      w: d.width,
      h: d.height,
      hole: b.hole === undefined ? null : b.hole,
      layer: b.layerId,
      elemId: r.id
    });
  }
  let bbox = null;
  for (const r of recs) {
    if (r.type === 'POLY' && r.body && r.body.polyType === 'NORMAL' && Array.isArray(r.body.path)) {
      // component-body outline (layer 48) is the footprint's real extent
      if (r.body.layerId !== 48) continue;
      const pts = pathToPoints(r.body.path);
      const bb = G.bboxOfPoints(pts);
      if (bb) bbox = bb;
    }
  }
  if (!bbox && pads.length) bbox = G.bboxOfPoints(pads.map((p) => ({ x: p.x, y: p.y })));
  let designator;
  for (const r of recs) {
    if (r.type === 'ATTR' && r.body && r.body.key === 'Designator' && !r.body.parentId) {
      designator = r.body.value;
      break;
    }
  }
  return {
    kind: 'footprint',
    name: entry.name,
    title: entry.title || entry.name,
    designator: entry.designator || designator || 'U?',
    pads,
    padByNum: new Map(pads.map((p) => [String(p.num), p])),
    bbox
  };
}

/** [x,y,'L',x,y,...] → [{x,y}] */
function pathToPoints(p) {
  const out = [];
  if (!Array.isArray(p)) return out;
  if (typeof p[0] === 'string') {
    if (p[0] === 'CIRCLE') return [{ x: p[1], y: p[2] }];
    // ["R", x, yTop, w, h]: the anchor is the min-x/max-y corner and the height
    // extends toward -y, so the rect covers x..x+w and yTop-h..yTop.
    if (p[0] === 'R') return [
      { x: p[1], y: p[2] }, { x: p[1] + p[3], y: p[2] },
      { x: p[1] + p[3], y: p[2] - p[4] }, { x: p[1], y: p[2] - p[4] }
    ];
  }
  for (let i = 0; i < p.length;) {
    if (typeof p[i] === 'string') { i += 1; continue; }
    out.push({ x: p[i], y: p[i + 1] });
    i += 2;
  }
  return out;
}

/** Rotate a footprint pad into page space. */
function placedPads(fp, x, y, angle) {
  return fp.pads.map((p) => {
    const r = G.rotate(p.x, p.y, angle || 0);
    return { num: String(p.num), x: G.round(x + r.x), y: G.round(y + r.y), w: p.w, h: p.h, hole: p.hole };
  });
}

// ------------------------------------------------------------ inline specs
// Two-column auto layout, same convention as generate-symbol.js: left column
// rot 0 at x=-20, right column rot 180 at x=+20, pin length 10.
function autoPinLayout(pins, pitch) {
  const left = [];
  const right = [];
  pins.forEach((p, i) => (i % 2 === 0 ? left : right).push(p));
  for (const [list, x, rot] of [[left, -20, 0], [right, 20, 180]]) {
    list.forEach((p, i) => {
      p.x = x;
      p.rotation = rot;
      p.length = PIN_LEN;
      p.y = Math.round((i - (list.length - 1) / 2) * pitch * 100) / 100;
    });
  }
  return pins;
}

function symbolBodyBox(pins, pitch) {
  const innerLeft = pins.filter((p) => p.rotation === 0).map((p) => p.x + p.length);
  const innerRight = pins.filter((p) => p.rotation === 180).map((p) => p.x - p.length);
  const ys = pins.map((p) => p.y);
  return {
    dotX1: innerLeft.length ? Math.max(...innerLeft) : -10,
    dotX2: innerRight.length ? Math.min(...innerRight) : 10,
    dotY1: Math.min(...ys) - pitch / 2,
    dotY2: Math.max(...ys) + pitch / 2
  };
}

/** Pin spec: "1:VCC;2:GND" or [{num,name}] → full pin objects. */
function normalizePinSpec(spec, pitch) {
  if (!Array.isArray(spec) || !spec.length) throw new Error('inline symbol needs a non-empty "pins" array');
  const pins = spec.map((s, i) => {
    if (typeof s === 'string') {
      const p = s.split(':');
      if (!p[0]) throw new Error(`bad pin spec "${s}"`);
      return { num: String(p[0]).trim(), name: (p[1] || p[0]).trim() };
    }
    if (!s || !s.num) throw new Error(`bad pin object at index ${i}`);
    return { num: String(s.num), name: String(s.name || s.num) };
  });
  return symbolBodyBox(autoPinLayout(pins, pitch || 10), pitch || 10);
}

/**
 * Compose a library entry from an inline design spec.
 * spec: {name, pins: ["1:A", ...], designator, pitch}
 */
function buildInlineSymbolEntry(spec, ctx) {
  const pitch = spec.pitch || 10;
  const pins = (spec.pins || []).map((s) => (typeof s === 'string'
    ? { num: s.split(':')[0].trim(), name: (s.split(':')[1] || s.split(':')[0]).trim() }
    : { num: String(s.num), name: String(s.name || s.num) }));
  const box = normalizePinSpec(spec.pins, pitch);
  const uuid = E.uuid16();
  // buildSymbolDoc needs explicit geometry, so lay the pins out first.
  const laidOut = autoPinLayout(pins, pitch);
  const doc = E.buildSymbolDoc({
    uuid,
    title: spec.name,
    description: spec.description || '',
    tags: [],
    source: E.makeSource(E.uuid32(), ctx.ownerUuid),
    client: ctx.client,
    ms: ctx.ms,
    name: spec.name,
    designator: spec.designator || 'U?',
    bbox: [box.dotX1, box.dotY1, box.dotX2, box.dotY2],
    graphics: [{ type: 'RECT', body: {
      dotX1: box.dotX1, dotY1: box.dotY1, dotX2: box.dotX2, dotY2: box.dotY2,
      radiusX: 0, radiusY: 0, rotation: 0, strokeColor: null, strokeStyle: null,
      fillColor: null, strokeWidth: null, fillStyle: null
    } }],
    pins: laidOut
  });
  return {
    name: spec.name,
    kind: 'symbol',
    title: spec.name,
    designator: spec.designator || 'U?',
    description: spec.description || '',
    symbolUuid: uuid,
    symbolDoc: doc,
    placement: { nameZ: 10, designatorZ: 11, symbolZ: 12 }
  };
}

/**
 * Compose a footprint entry from an inline design spec.
 * spec: {name, pads: [[num,x,y,w,h,hole?]], outline: [x1,y1,x2,y2], designator}
 */
function buildInlineFootprintEntry(spec, ctx) {
  const uuid = E.uuid16();
  const pads = (spec.pads || []).map((p) => (Array.isArray(p)
    ? { num: String(p[0]), x: Number(p[1]), y: Number(p[2]), w: Number(p[3]), h: Number(p[4]), hole: p[5] === undefined ? null : Number(p[5]) }
    : p));
  const box = spec.outline
    ? G.rect(spec.outline[0], spec.outline[1], spec.outline[2], spec.outline[3])
    : G.bboxOfPoints(pads.map((p) => ({ x: p.x, y: p.y })));
  const doc = E.buildFootprintDoc({
    uuid,
    title: spec.name,
    description: spec.description || '',
    tags: [],
    source: E.makeSource(E.uuid32(), ctx.ownerUuid),
    client: ctx.client,
    ms: ctx.ms,
    designator: spec.designator || 'U?',
    outline: [box.x1, box.y1, 'L', box.x2, box.y1, box.x2, box.y2, box.x1, box.y2, box.x1, box.y1],
    silks: [],
    pads
  });
  // buildFootprintDoc returns {lines, pads:[{num, elemId}], attrs:{Footprint:id,
  // Designator:id}} — the placement block needs those elem ids and attr z.
  const zByAttrId = new Map();
  for (const line of doc.lines) {
    const r = E.parseRecord(line);
    if (r && r.type === 'ATTR' && r.id && r.body && typeof r.body.zIndex === 'number') {
      zByAttrId.set(r.id, r.body.zIndex);
    }
  }
  return {
    name: spec.name,
    kind: 'footprint',
    title: spec.name,
    designator: spec.designator || 'U?',
    footprintUuid: uuid,
    footprintDoc: doc.lines,
    footprintElems: {
      pads: doc.pads,
      attrFootprint: doc.attrs.Footprint,
      attrDesignator: doc.attrs.Designator
    },
    attrZ: {
      footprint: zByAttrId.get(doc.attrs.Footprint) || 15,
      designator: zByAttrId.get(doc.attrs.Designator) || 16
    }
  };
}

/** "R1.2" → {part:'R1', pin:'2'}; "VCC" (no dot) → null. */
function parsePinRef(ref) {
  const m = /^([A-Za-z_][\w-]*)\.(\w+)$/.exec(String(ref).trim());
  return m ? { part: m[1], pin: m[2] } : null;
}

module.exports = {
  PIN_LEN,
  parseSymbolEntry,
  parseFootprintEntry,
  placedTip,
  placedPins,
  placedPads,
  pathToPoints,
  normalizePinSpec,
  buildInlineSymbolEntry,
  buildInlineFootprintEntry,
  parsePinRef,
  symbolBodyBox,
  autoPinLayout
};
