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
        elemId: r.id,
        partId: r.body.partId || null
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
  // Symbol artwork (what the client draws): open POLY strokes, closed POLY
  // fills and RECTs. The client renders these instead of a plain body
  // box, so a diode looks like a diode and an LED like an LED.
  const graphics = [];
  for (const r of recs) {
    if (r.type === 'POLY' && r.body && Array.isArray(r.body.points) && r.body.points.length >= 2) {
      graphics.push({ kind: 'poly', points: r.body.points, closed: !!r.body.closed });
    } else if (r.type === 'RECT' && r.body) {
      graphics.push({ kind: 'rect', x1: r.body.dotX1, y1: r.body.dotY1, x2: r.body.dotX2, y2: r.body.dotY2 });
    }
  }
  let designator;
  for (const r of recs) {
    if (r.type === 'ATTR' && r.body && r.body.key === 'Designator' && r.body.parentId === '') {
      designator = r.body.value;
      break;
    }
  }
  // Multi-part symbols: pins belong to a PART via `partId`. Expose the per-part
  // grouping so a schematic COMPONENT (which references one part) shows only
  // its own pins.
  const pinsByPart = new Map();
  for (const p of pins) {
    const pid = p.partId || '';
    if (!pinsByPart.has(pid)) pinsByPart.set(pid, []);
    pinsByPart.get(pid).push(p);
  }
  return {
    kind,
    docType,
    title: entry.title || entry.name,
    name: entry.name,
    designator: entry.designator || designator || 'U?',
    bbox,
    pins,
    graphics,
    pinByNum: new Map(pins.map((p) => [String(p.num), p])),
    pinsByPart,
    parts: [...pinsByPart.entries()].map(([partId, plist]) => ({ partId, pins: plist }))
  };
}

/**
 * For a multi-part symbol, return a view holding only `partId`'s pins (a unit
 * of U34A/U34B/… shows its own subset) with a matching bbox. Non-multi-part
 * symbols (no pinsByPart / no partId) pass through unchanged.
 */
function partView(sym, partId) {
  if (!sym || !partId || !sym.pinsByPart) return sym;
  const pp = sym.pinsByPart.get(partId);
  if (!pp) return sym;
  const tips = pp.map((p) => p.tip || G.pinTip(p, 0, 0, 0)).concat(pp.map((p) => ({ x: p.x, y: p.y })));
  return Object.assign({}, sym, {
    pins: pp,
    pinByNum: new Map(pp.map((p) => [String(p.num), p])),
    bbox: G.bboxOfPoints(tips) || sym.bbox
  });
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
// Pins may carry a side hint ('L'/'R') and an electrical direction letter
// (I/O/B/P/W/T/C): hinted pins take their column, unhinted ones balance-fill
// (which for a hint-free list is exactly the old alternating order).

/** "num:name:dir:side" / "num:name:dir" / "num:name" → {num,name,dir,side}.
 *  Explicit geometry ("num:name:x:y:rot") is NOT handled here. */
function parseAutoPinSpec(spec) {
  return spec.map((s, i) => {
    if (typeof s === 'string') {
      const t = s.split(':').map((x) => x.trim());
      if (!t[0]) throw new Error(`bad pin spec "${s}"`);
      return { num: t[0], name: t[1] || t[0], dir: t[2] || null, side: t[3] || null };
    }
    if (!s || !s.num) throw new Error(`bad pin object at index ${i}`);
    return { num: String(s.num), name: String(s.name || s.num), dir: s.dir || null, side: s.side || null };
  });
}

function autoPinLayout(pins, pitch) {
  const left = [];
  const right = [];
  const hinted = pins.some((p) => p.dir || p.side);
  if (hinted) {
    // Functional grouping (the way humans draw): inputs top-left, outputs
    // top-right, bidirectionals under the outputs, passives under the inputs,
    // power at the BOTTOM of whichever column is shorter. Declaration order
    // is kept inside each group. The list order runs bottom→top, so groups
    // are pushed bottom-first.
    const inputs = [];
    const outputs = [];
    const bidirs = [];
    const passives = [];
    const power = [];
    const explicitL = [];
    const explicitR = [];
    for (const p of pins) {
      if (p.side === 'L') explicitL.push(p);
      else if (p.side === 'R') explicitR.push(p);
      else if (p.dir === 'W') power.push(p);
      else if (p.dir === 'I') inputs.push(p);
      else if (p.dir === 'P') passives.push(p);
      else if (p.dir === 'O') outputs.push(p);
      else if (p.dir) bidirs.push(p);                 // B / T / C
      else inputs.push(p);                            // unmarked reads as input-ish
    }
    // power fills the shorter column, alternating on ties
    for (const p of power) (left.length <= right.length ? left : right).push(p);
    left.push(...passives, ...inputs, ...explicitL);  // bottom→top: passive, input, explicit
    right.push(...bidirs, ...outputs, ...explicitR);
  } else {
    // no hints at all → the classic alternating balance (unchanged behaviour)
    for (const p of pins) (left.length <= right.length ? left : right).push(p);
  }
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

// Symbol-doc coordinates are 10-mil units (the reference symbol's 400-mil
// body is a RECT of -20..20). Design-side values (pitch, halfW) are written in
// MIL, so they are scaled by MIL here — forgetting this makes every symbol 10×
// oversized and no sheet size can hold it.
const MIL = 0.1;
const DEFAULT_BODY_HALF_W = 400;   // mil — minimum half body width (400 mil → 800 mil body)
const FLAT_BODY_HALF_W = 200;      // mil — flat IC minimum; grows with the longest pin name
const GROUP_GAP = 30;              // symbol units (300 mil) of blank band between banks
const MULTI_PIN_LEN = 20;          // symbol units (200 mil) pin stub — matches the reference

/**
 * Lay grouped pins into a two-column symbol body at `pitch`, so a large
 * multi-function chip reads as banks of related pins instead of one
 * undifferentiated sliver.
 *
 * groups: [{name?, pins:[{num,name,dir,side}]}] in top-to-bottom declaration
 * order. Within a group the pins stay contiguous and balance across the
 * left/right columns; a gap separates adjacent groups so the reader sees the
 * functional split. Returns {pins, body, labels} — the body is a proper wide
 * rectangle (`halfW` each side); pins carry the EasyEDA Pro label layout:
 * name INSIDE the body, number OUTSIDE near the pin.
 */
function layoutSymbolPins(groups, pitchMil, halfWMil, pinLen) {
  const len = pinLen === undefined ? MULTI_PIN_LEN : pinLen;
  // design values arrive in MIL; the symbol document works in 10-mil units
  const pitch = Math.max(4, Math.round((pitchMil === undefined ? 100 : pitchMil) * MIL));
  let halfW = Math.max(10, Math.round((halfWMil === undefined ? DEFAULT_BODY_HALF_W : halfWMil) * MIL));
  // widen the body until the longest pin name fits each column (text is drawn
  // INSIDE the body, so a fixed width would clip long names)
  const textW = (s) => Math.round(String(s).length * 5.2) + 8;
  for (const g of groups) {
    for (const p of g.pins) halfW = Math.max(halfW, textW(p.name || p.num));
  }
  halfW = Math.ceil(halfW / 5) * 5;                    // keep pin tips on a 50-mil grid
  // pin number sits above the stub, ending just outside the body edge
  const numIn = Math.min(5, len / 2);
  const out = [];
  const labels = [];
  let cursor = 0;   // y of the current group's bottom row (y-up)
  for (const g of groups) {
    const left = [];
    const right = [];
    for (const p of g.pins) {
      if (p.side === 'L') left.push(p);
      else if (p.side === 'R') right.push(p);
      else if (p.dir === 'I') left.push(p);
      else if (p.dir === 'O' || p.dir === 'B' || p.dir === 'T' || p.dir === 'C') right.push(p);
      else (left.length <= right.length ? left : right).push(p);
    }
    const rows = Math.max(left.length, right.length);
    left.forEach((p, i) => {
      const y = cursor + i * pitch;
      out.push(Object.assign({}, p, {
        x: -(halfW + len), rotation: 0, length: len, y,
        nameX: -halfW + 2, nameY: y - 5, nameAlign: 'LEFT_BOTTOM',
        numX: -(halfW + numIn), numY: y - 1, numAlign: 'RIGHT_BOTTOM'
      }));
    });
    right.forEach((p, i) => {
      const y = cursor + i * pitch;
      out.push(Object.assign({}, p, {
        x: halfW + len, rotation: 180, length: len, y,
        nameX: halfW - 2, nameY: y - 5, nameAlign: 'RIGHT_BOTTOM',
        numX: halfW + numIn, numY: y - 1, numAlign: 'LEFT_BOTTOM'
      }));
    });
    // the caption sits in the blank band ABOVE this bank, so it never
    // collides with a pin name
    if (g.name) labels.push({ name: g.name, y: cursor + (rows - 1) * pitch + GROUP_GAP / 2 });
    cursor += rows * pitch + GROUP_GAP;
  }
  // centre the stack vertically around the body origin
  if (out.length) {
    const ys = out.map((p) => p.y);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const p of out) {
      p.y = Math.round((p.y - mid) * 100) / 100;
      p.nameY = Math.round((p.nameY - mid) * 100) / 100;
      p.numY = Math.round((p.numY - mid) * 100) / 100;
    }
    for (const l of labels) l.y = Math.round((l.y - mid) * 100) / 100;
  }
  const ys = out.map((p) => p.y);
  let top = (ys.length ? Math.max(...ys) : 0) + pitch / 2;
  // headroom for the top bank's caption
  if (labels.length) top = Math.max(top, Math.max(...labels.map((l) => l.y)) + pitch / 2);
  const body = {
    x1: -halfW, x2: halfW,
    y1: (ys.length ? Math.min(...ys) : 0) - pitch / 2,
    y2: top
  };
  return { pins: out, body, labels };
}

/** Pin spec: "1:VCC;2:GND" or [{num,name}] → full pin objects. */
function normalizePinSpec(spec, pitch) {
  if (!Array.isArray(spec) || !spec.length) throw new Error('inline symbol needs a non-empty "pins" array');
  const pins = parseAutoPinSpec(spec);
  return symbolBodyBox(autoPinLayout(pins, pitch || 10), pitch || 10);
}

/**
 * Compose a library entry from an inline design spec.
 * spec: {name, pins: ["1:A", ...], designator, pitch}
 *
 * pitch defaults to 30 mil whenever the pin list has 3+ entries (any auto
 * column then holds ≥2 pins, and the old 10 mil default stacked stubs on top
 * of each other); 1–2 pin symbols keep the tight 10 mil default.
 */
function buildInlineSymbolEntry(spec, ctx) {
  // RAW mode (fetched official symbols): explicit pin geometry + graphics are
  // carried through VERBATIM — no auto layout, no re-drawing
  if (spec.raw) {
    const uuid = E.uuid16();
    const rawPins = (spec.pins || []).map((p) => ({
      num: String(p.num), name: p.name || p.num,
      x: p.x, y: p.y, rotation: p.rotation || 0,
      length: p.length !== undefined ? p.length : 100
    }));
    const xs = rawPins.map((p) => p.x), ys = rawPins.map((p) => p.y);
    // Official LCSC graphics arrive in the fetch format, NOT the client record
    // shape. Re-emit each with the client's exact field set — a RECT carrying
    // x/y/x2/y2 or a CIRCLE carrying cx/cy/r makes the client reject the
    // symbol document ("符号加载报错"), losing the association entirely.
    const graphics = (spec.graphics || []).map((g) => {
      const b = g.body || {};
      if (g.type === 'RECT') {
        const x1 = b.dotX1 !== undefined ? b.dotX1 : Math.min(b.x, b.x2);
        const y1 = b.dotY1 !== undefined ? b.dotY1 : Math.min(b.y, b.y2);
        const x2 = b.dotX2 !== undefined ? b.dotX2 : Math.max(b.x, b.x2);
        const y2 = b.dotY2 !== undefined ? b.dotY2 : Math.max(b.y, b.y2);
        return { type: 'RECT', body: {
          dotX1: x1, dotY1: y1, dotX2: x2, dotY2: y2,
          radiusX: b.radiusX || 0, radiusY: b.radiusY || 0, rotation: b.rotation || 0,
          strokeColor: b.strokeColor || null, strokeStyle: b.strokeStyle || null,
          fillColor: b.fillColor || null, strokeWidth: b.strokeWidth || null,
          fillStyle: b.fillStyle || null
        } };
      }
      if (g.type === 'CIRCLE') {
        return { type: 'CIRCLE', body: {
          centerX: b.centerX !== undefined ? b.centerX : b.cx,
          centerY: b.centerY !== undefined ? b.centerY : b.cy,
          radius: b.radius !== undefined ? b.radius : b.r,
          strokeColor: b.strokeColor || null, strokeStyle: b.strokeStyle || null,
          fillColor: b.fillColor || null, strokeWidth: b.strokeWidth || null,
          fillStyle: b.fillStyle || null
        } };
      }
      if (g.type === 'POLY') {
        return { type: 'POLY', body: {
          points: (b.points || []).map((p) => ({ x: p.x, y: p.y })),
          closed: !!b.closed, rotation: b.rotation || 0,
          strokeColor: b.strokeColor || null, strokeStyle: b.strokeStyle || null,
          fillColor: b.fillColor || null, strokeWidth: b.strokeWidth || null,
          fillStyle: b.fillStyle || null
        } };
      }
      return { type: g.type, body: Object.assign({}, b) };
    });
    // BBOX = the BODY graphics extent (NOT the pin-tip span) — lint L004
    // judges wire-crossing against this, and pins legitimately extend outward
    let gx1 = 1e9, gy1 = 1e9, gx2 = -1e9, gy2 = -1e9;
    for (const g of graphics) {
      const b = g.body;
      // read the NORMALIZED shapes (see the mapping above): RECT = dotX1…,
      // CIRCLE = centerX/centerY/radius, POLY = points
      if (g.type === 'RECT' && b.dotX1 !== undefined) {
        gx1 = Math.min(gx1, b.dotX1); gx2 = Math.max(gx2, b.dotX2);
        gy1 = Math.min(gy1, b.dotY1); gy2 = Math.max(gy2, b.dotY2);
      } else if (g.type === 'CIRCLE' && b.centerX !== undefined) {
        gx1 = Math.min(gx1, b.centerX - b.radius); gx2 = Math.max(gx2, b.centerX + b.radius);
        gy1 = Math.min(gy1, b.centerY - b.radius); gy2 = Math.max(gy2, b.centerY + b.radius);
      } else {
        for (const p of (b.points || [])) {
          gx1 = Math.min(gx1, p.x); gx2 = Math.max(gx2, p.x);
          gy1 = Math.min(gy1, p.y); gy2 = Math.max(gy2, p.y);
        }
      }
    }
    if (gx1 > gx2) { gx1 = Math.min(...xs) - 10; gy1 = Math.min(...ys) - 10; gx2 = Math.max(...xs) + 10; gy2 = Math.max(...ys) + 10; }
    // Show pin names/numbers the way the official client does (name just inside
    // the body edge, number on the stub near the hotspot). The pin's rotation
    // points hotspot→body, so rot 0 = left side, 180 = right side.
    const showLabels = rawPins.length > 2;
    if (showLabels) {
      for (const p of rawPins) {
        if (p.rotation === 180) {
          p.nameX = p.x - p.length - 2; p.nameY = p.y - 4.9; p.numX = p.x - 5; p.numY = p.y - 0.9;
        } else if (p.rotation === 0) {
          p.nameX = p.x + p.length + 2; p.nameY = p.y - 4.9; p.numX = p.x + 5; p.numY = p.y - 0.9;
        } else if (p.rotation === 90) {          // bottom side, stub runs up into the body
          p.nameX = p.x + 2; p.nameY = p.y + p.length - 2; p.numX = p.x + 2; p.numY = p.y + 5;
        } else {                                  // 270: top side, stub runs down
          p.nameX = p.x + 2; p.nameY = p.y - p.length + 2; p.numX = p.x + 2; p.numY = p.y - 5;
        }
      }
    }
    const doc = E.buildSymbolDoc({
      uuid,
      title: spec.title || spec.name,
      description: spec.description || '',
      tags: [],
      source: E.makeSource(E.uuid32(), ctx.ownerUuid),
      client: ctx.client,
      ms: ctx.ms,
      name: spec.title || spec.name,
      designator: spec.designator || 'U?',
      bbox: [gx1, gy1, gx2, gy2],
      graphics: graphics.map((g) => ({ type: g.type, body: Object.assign({}, g.body, { partId: 'PART_ID' }) })),
      pins: rawPins
    });
    return {
      name: spec.name,
      kind: 'symbol',
      title: spec.title || spec.name,
      designator: spec.designator || 'U?',
      description: spec.description || '',
      symbolUuid: uuid,
      symbolDoc: doc,
      placement: { nameZ: 10, designatorZ: 11, symbolZ: 12 },
      raw: true
    };
  }
  let pins;
  let box;
  if (Array.isArray(spec.groups) && spec.groups.length) {
    // Grouped path (large multi-function chips): wide body, `pitch` (default
    // 100 mil / 0.1"), banks separated by a gap. The doc's pin records and
    // body box come from ONE layout pass — side hints make column assignment
    // non-trivial, so two independent passes could desync.
    const pitch = spec.pitch || 100;
    const halfW = spec.halfW || DEFAULT_BODY_HALF_W;
    const gs = spec.groups.map((g) => ({ name: g.name || '', pins: parseAutoPinSpec(g.pins || []) }));
    const laid = layoutSymbolPins(gs, pitch, halfW);
    pins = laid.pins;
    box = { dotX1: laid.body.x1, dotY1: laid.body.y1, dotX2: laid.body.x2, dotY2: laid.body.y2 };
  } else if ((spec.pins || []).length > 4) {
    // Flat IC / connector spec: lay it out the way the official library draws
    // ICs — 100-mil pin pitch, 200-mil pin stubs, a body wide enough for the
    // longest pin name, names inside and numbers outside, both VISIBLE. The
    // old auto layout used a 300-mil pitch on a 200-mil-wide sliver with
    // hidden labels, which is what made USB1/U1 unreadable.
    const pitch = Math.max(100, Number(spec.pitch) || 0);
    const halfW = spec.halfW || FLAT_BODY_HALF_W;
    const laid = layoutSymbolPins([{ name: '', pins: parseAutoPinSpec(spec.pins) }], pitch, halfW);
    pins = laid.pins;
    box = { dotX1: laid.body.x1, dotY1: laid.body.y1, dotX2: laid.body.x2, dotY2: laid.body.y2 };
  } else {
    const nPins = (spec.pins || []).length;
    const pitch = spec.pitch || (nPins >= 3 ? 30 : 10);
    // parse once, lay out once — the doc's pin records and the body box must
    // come from the same layout pass (side hints make column assignment
    // non-trivial, so two independent passes could desync)
    pins = parseAutoPinSpec(spec.pins || []);
    box = symbolBodyBox(autoPinLayout(pins, pitch), pitch);
  }
  const uuid = E.uuid16();
  // buildSymbolDoc needs explicit geometry, so lay the pins out first.
  const doc = E.buildSymbolDoc({
    uuid,
    title: spec.title || spec.name,
    description: spec.description || '',
    tags: [],
    source: E.makeSource(E.uuid32(), ctx.ownerUuid),
    client: ctx.client,
    ms: ctx.ms,
    name: spec.title || spec.name,
    designator: spec.designator || 'U?',
    bbox: [box.dotX1, box.dotY1, box.dotX2, box.dotY2],
    graphics: [{ type: 'RECT', body: {
      dotX1: box.dotX1, dotY1: box.dotY1, dotX2: box.dotX2, dotY2: box.dotY2,
      radiusX: 0, radiusY: 0, rotation: 0, strokeColor: null, strokeStyle: null,
      fillColor: null, strokeWidth: null, fillStyle: null
    } }],
    pins
  });
  return {
    name: spec.name,
    kind: 'symbol',
    title: spec.title || spec.name,
    designator: spec.designator || 'U?',
    description: spec.description || '',
    symbolUuid: uuid,
    symbolDoc: doc,
    placement: { nameZ: 10, designatorZ: 11, symbolZ: 12 }
  };
}

/**
 * Compose a MULTI-PART symbol entry: ONE symbol doc holding N PART records
 * (one per unit of a split component). Each part lays its grouped pins into a
 * wide body with the EasyEDA Pro label style (name inside, number outside).
 * spec: {name, designator, pitch, halfW, parts:[{title, groups:[{name,pins}]}]}
 * The entry carries `multipart` (the ordered part ids) so the build can place
 * one schematic COMPONENT per part.
 */
function buildMultiPartSymbolEntry(spec, ctx) {
  const uuid = E.uuid16();
  const pitch = spec.pitch || 100;
  const halfW = spec.halfW || DEFAULT_BODY_HALF_W;
  const parts = (spec.parts || []).map((part, i) => {
    const id = `${spec.name}.${i + 1}`;
    const groups = (part.groups || []).map((g) => ({ name: g.name || '', pins: parseAutoPinSpec(g.pins || []) }));
    const laid = layoutSymbolPins(groups, pitch, halfW);
    return {
      id,
      // the reference names every PART "<symbol>.<n>"; the client shows the
      // unit suffix from this title (U34.1, U34.2, …)
      title: id,
      graphics: [{ type: 'RECT', body: {
        dotX1: laid.body.x1, dotY1: laid.body.y1, dotX2: laid.body.x2, dotY2: laid.body.y2,
        radiusX: 0, radiusY: 0, rotation: 0, strokeColor: null, strokeStyle: null,
        fillColor: null, strokeWidth: null, fillStyle: null
      } }],
      // bank captions ("Power", "DQ", …) drawn inside the body
      texts: laid.labels.map((l) => ({
        x: laid.body.x1 + 6, y: l.y, value: l.name, fontSize: 9, align: 'LEFT_BOTTOM'
      })),
      pins: laid.pins
    };
  });
  const doc = E.buildMultiPartSymbolDoc({
    uuid,
    title: spec.name,
    description: spec.description || '',
    tags: [],
    source: E.makeSource(E.uuid32(), ctx.ownerUuid),
    client: ctx.client,
    ms: ctx.ms,
    name: spec.name,
    designator: spec.designator || 'U?',
    parts
  });
  return {
    name: spec.name,
    kind: 'symbol',
    title: spec.title || spec.name,
    designator: spec.designator || 'U?',
    description: spec.description || '',
    symbolUuid: uuid,
    symbolDoc: doc,
    placement: { nameZ: 10, designatorZ: 11, symbolZ: 12 },
    multipart: parts.map((p) => p.id)
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
    title: spec.title || spec.name,
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
    title: spec.title || spec.name,
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
  DEFAULT_BODY_HALF_W,
  GROUP_GAP,
  MULTI_PIN_LEN,
  parseSymbolEntry,
  parseFootprintEntry,
  partView,
  placedTip,
  placedPins,
  placedPads,
  pathToPoints,
  parseAutoPinSpec,
  normalizePinSpec,
  buildInlineSymbolEntry,
  buildMultiPartSymbolEntry,
  buildInlineFootprintEntry,
  parsePinRef,
  symbolBodyBox,
  autoPinLayout,
  layoutSymbolPins
};
