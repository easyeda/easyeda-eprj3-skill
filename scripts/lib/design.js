'use strict';
/**
 * design.js — the declaration layer.
 *
 * A design file (`design.json`) describes WHAT the circuit is; this module
 * turns that into a validated, fully-positioned plan (WHERE everything goes).
 * The build driver only executes plans, and the checkers only re-read the
 * resulting project, so both sides stay honest about the same data.
 *
 * Design file shape (all lengths mil, Y up):
 *
 * {
 *   "name": "blink",
 *   "board": { "width": 1600, "height": 1000 },
 *   "sheet": { "schematic": "Schematic1", "name": "P1" },
 *   "powers": { "VCC": "up", "GND": "down" },
 *   "blocks": [ { "title": "POWER INPUT", "parts": ["J1", "C1"] } ],
 *   "parts": [
 *     { "id": "R1", "symbol": "RES", "footprint": "R0603", "value": "330R",
 *       "pins": { "1": "VCC", "2": "LED_A" } }
 *   ],
 *   "pcb": { "place": { "R1": [300, 300, 0] }, "route": true,
 *            "pour": { "net": "GND" } }
 * }
 *
 * `symbol`/`footprint` accept a library entry name, an inline symbol spec
 * (`{ "pins": ["1:A", "2:B"], "designator": "U" }`), or an inline footprint
 * spec (`{ "pads": [[1,-16,0,31,35], ...] }`).
 */

const fs = require('fs');
const path = require('path');
const G = require('./geom');

const DEFAULTS = {
  schematic: 'Schematic1',
  sheet: 'P1',
  pcb: 'PCB1',
  board: { width: 1600, height: 1000 },
  layout: { cols: 3, cellW: 260, cellH: 200, blockGapX: 280, blockGapY: 240, margin: 120 }
};

const BLOCK_TITLE_H = 60;

class DesignError extends Error {}

function fail(msg) { throw new DesignError(msg); }

function readDesign(file) {
  if (!fs.existsSync(file)) fail(`design file not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`design file is not valid JSON: ${e.message}`);
  }
  return normalize(raw, file);
}

/** Apply defaults and resolve the shorthand forms into one canonical shape. */
function normalize(raw, file) {
  if (!raw || typeof raw !== 'object') fail('design must be a JSON object');
  const d = {
    file: file || null,
    name: raw.name || (file ? path.basename(file).replace(/\.json$/i, '') : 'project'),
    schematic: (raw.sheet && raw.sheet.schematic) || raw.schematic || DEFAULTS.schematic,
    sheet: (raw.sheet && (raw.sheet.name || raw.sheet.title)) || raw.sheetName || DEFAULTS.sheet,
    pcb: raw.pcbName || DEFAULTS.pcb,
    board: Object.assign({}, DEFAULTS.board, raw.board || {}),
    layout: Object.assign({}, DEFAULTS.layout, raw.layout || {}),
    powers: Object.assign({}, raw.powers || {}),
    nets: Object.assign({}, raw.nets || {}),
    blocks: [],
    parts: [],
    pcbSpec: raw.pcb && typeof raw.pcb === 'object' ? raw.pcb : {},
    skipPcb: raw.pcb === false
  };

  // nets may also declare power style: "nets": { "VCC": { "power": "up" } }
  for (const [name, spec] of Object.entries(d.nets)) {
    if (spec && typeof spec === 'object' && spec.power) d.powers[name] = spec.power;
  }

  const partsIn = Array.isArray(raw.parts) ? raw.parts : [];
  if (!partsIn.length) fail('design has no "parts" — nothing to build');
  const seen = new Set();
  d.parts = partsIn.map((p, i) => {
    if (!p || typeof p !== 'object') fail(`parts[${i}] must be an object`);
    const id = String(p.id || '').trim();
    if (!id) fail(`parts[${i}] has no "id"`);
    if (seen.has(id)) fail(`duplicate part id "${id}"`);
    seen.add(id);
    if (!p.symbol) fail(`part "${id}" has no "symbol"`);
    const pins = {};
    if (p.pins && typeof p.pins === 'object') {
      for (const [k, v] of Object.entries(p.pins)) {
        if (v === null || v === undefined || v === '') continue;
        pins[String(k)] = String(v);
      }
    } else if (Array.isArray(p.pins)) {
      // ["1:VCC","2:GND"] shorthand
      for (const s of p.pins) {
        const [num, net] = String(s).split(':');
        if (num && net) pins[num.trim()] = net.trim();
      }
    }
    const rot = Number(p.rotation || p.rot || 0);
    if (![0, 90, 180, 270].includes(rot)) fail(`part "${id}": rotation must be 0/90/180/270`);
    return {
      id,
      symbol: p.symbol,
      footprint: p.footprint || null,
      value: p.value === undefined ? null : String(p.value),
      name: p.name || null,
      pins,
      rotation: rot,
      block: p.block === undefined ? null : (typeof p.block === 'number' ? p.block : String(p.block))
    };
  });

  // Blocks: explicit list first, leftovers go to an implicit MISC block.
  const blocksIn = Array.isArray(raw.blocks) ? raw.blocks : [];
  const assigned = new Map();
  blocksIn.forEach((b, i) => {
    if (!b || typeof b !== 'object') fail(`blocks[${i}] must be an object`);
    const title = String(b.title || b.name || `BLOCK ${i + 1}`);
    const list = Array.isArray(b.parts) ? b.parts.map(String) : [];
    for (const id of list) {
      if (!seen.has(id)) fail(`block "${title}" references unknown part "${id}"`);
      if (assigned.has(id)) fail(`part "${id}" is listed in two blocks`);
      assigned.set(id, i);
    }
    d.blocks.push({ title, parts: list, colspan: Number(b.colspan || 0) || 0 });
  });
  const leftovers = d.parts.filter((p) => !assigned.has(p.id)).map((p) => p.id);
  if (leftovers.length) {
    if (!d.blocks.length) d.blocks.push({ title: 'CIRCUIT', parts: [] });
    d.blocks[d.blocks.length - 1].parts.push(...leftovers);
  }
  // drop empty blocks, then reindex every part → block
  d.blocks = d.blocks.filter((b) => b.parts.length);
  d.parts.forEach((p) => { p.blockIndex = 0; });
  d.blocks.forEach((b, i) => {
    for (const id of b.parts) {
      const part = d.parts.find((p) => p.id === id);
      if (part) part.blockIndex = i;
    }
  });

  // Net → power style
  d.powerNets = new Map(Object.entries(d.powers).filter(([, v]) => v === 'up' || v === 'down'));
  d.allNets = new Set();
  for (const p of d.parts) for (const n of Object.values(p.pins)) d.allNets.add(n);
  return d;
}

/**
 * Structural validation that needs the resolved library geometry.
 * `lib` is {symbolOf(part), footprintOf(part)} supplied by the build driver.
 */
function validateDesign(d, lib) {
  const errors = [];
  const warnings = [];
  for (const p of d.parts) {
    let sym;
    try {
      sym = lib.symbolOf(p);
    } catch (e) {
      errors.push(`part "${p.id}": ${e.message}`);
      continue;
    }
    for (const [num, net] of Object.entries(p.pins)) {
      if (!sym.pinByNum.has(String(num))) {
        const known = [...sym.pinByNum.keys()].join(', ');
        errors.push(`part "${p.id}" (${sym.name}): net "${net}" assigned to pin "${num}", which does not exist (pins: ${known})`);
      }
    }
    for (const pin of sym.pins) {
      if (p.pins[pin.num] === undefined) {
        warnings.push(`part "${p.id}" (${sym.name}): pin "${pin.num}" (${pin.name}) has no net — it will be flagged unconnected`);
      }
    }
    if (!d.skipPcb) {
      if (!p.footprint) {
        errors.push(`part "${p.id}": no "footprint" (required unless the design sets "pcb": false)`);
      } else {
        try {
          lib.footprintOf(p);
        } catch (e) {
          errors.push(`part "${p.id}": ${e.message}`);
        }
      }
    }
  }
  // net sanity: a net used by exactly one pin is a dead end (ERC also reports it,
  // but catching it at plan time gives the author the design-level message)
  const netUsers = new Map();
  for (const p of d.parts) {
    for (const net of Object.values(p.pins)) {
      if (!netUsers.has(net)) netUsers.set(net, []);
      netUsers.get(net).push(`${p.id}.${Object.keys(p.pins).find((k) => p.pins[k] === net)}`);
    }
  }
  for (const [net, users] of netUsers) {
    if (users.length === 1 && !d.powerNets.has(net)) {
      warnings.push(`net "${net}" has only one connection (${users[0]}) — dead-end net`);
    }
  }
  return { errors, warnings, netUsers };
}

// ------------------------------------------------------------ auto layout
/**
 * Order parts inside a block so electrically related parts sit next to each
 * other. Union-find over shared nets, then a BFS from the most connected part;
 * isolated parts keep their declaration order at the end.
 */
function orderByConnectivity(parts) {
  const parent = new Map(parts.map((p) => [p.id, p.id]));
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const byNet = new Map();
  const degree = new Map(parts.map((p) => [p.id, 0]));
  for (const p of parts) {
    for (const net of new Set(Object.values(p.pins))) {
      if (!byNet.has(net)) byNet.set(net, []);
      byNet.get(net).push(p.id);
      degree.set(p.id, degree.get(p.id) + 1);
    }
  }
  for (const ids of byNet.values()) {
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
  }
  const groups = new Map();
  for (const p of parts) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  const order = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (degree.get(b.id) - degree.get(a.id)) || a.id.localeCompare(b.id));
    order.push(...g);
  }
  return order;
}

/** Visual extent of a placed part: body box, pins and the two label rows. */
function partExtent(sym, x, y, rotation) {
  const pts = [];
  const b = sym.bbox;
  if (b) {
    for (const [cx, cy] of [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]]) {
      const r = G.rotate(cx, cy, rotation || 0);
      pts.push({ x: x + r.x, y: y + r.y });
    }
  }
  for (const p of sym.pins) {
    const t = G.pinTip(p, x, y, rotation || 0);
    pts.push(t);
    const base = G.rotate(p.x, p.y, rotation || 0);
    pts.push({ x: x + base.x, y: y + base.y });
  }
  if (!pts.length) {
    pts.push({ x: x - 20, y: y - 20 }, { x: x + 20, y: y + 20 });
  }
  // designator/name rows sit just above the origin (mirrors schComponentBlock).
  // Keep this band narrow: a fat label box would make the geometry checks
  // report false overlaps against every wire that passes near the part.
  const labelW = 36;
  pts.push({ x: x - 10, y: y + 16 }, { x: x + labelW, y: y + 34 });
  return G.bboxOfPoints(pts);
}

function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2)
  };
}

/**
 * Lay blocks out left→right along the signal flow, each block as a grid of
 * parts, and return absolute placements plus the annotation boxes.
 */
function layoutSchematic(d, lib) {
  const L = d.layout;
  const placements = [];
  const blocks = [];
  let cursorX = 0;

  for (const block of d.blocks) {
    const members = block.parts
      .map((id) => d.parts.find((p) => p.id === id))
      .filter(Boolean);
    if (!members.length) continue;
    const ordered = orderByConnectivity(members);
    const n = ordered.length;
    const cols = Math.max(1, Math.min(L.cols, Math.ceil(Math.sqrt(n)) || 1));

    let box = null;
    ordered.forEach((part, i) => {
      const sym = lib.symbolOf(part);
      const col = i % cols;
      const row = Math.floor(i / cols);
      // Y-up: rows march downward from the block's top, columns left→right.
      // Origins snap to the 10 mil grid so pins keep landing on it too.
      const px = grid(cursorX + L.margin + col * L.cellW);
      const py = grid(-L.margin - row * L.cellH);
      const pl = { part, sym, x: px, y: py, rotation: part.rotation || 0, block };
      pl.extent = partExtent(sym, px, py, pl.rotation);
      placements.push(pl);
      box = unionRect(box, pl.extent);
    });

    const pad = 70;
    const rect = {
      x1: grid(box.x1 - pad),
      y1: grid(box.y1 - pad),
      x2: grid(box.x2 + pad),
      y2: grid(box.y2 + pad + BLOCK_TITLE_H)
    };
    blocks.push({ title: block.title, rect, members: ordered.map((p) => p.id) });
    cursorX = rect.x2 + L.blockGapX;
  }
  return { placements, blocks };
}

const grid = (v) => Math.round(v / 10) * 10;

module.exports = {
  DEFAULTS,
  DesignError,
  readDesign,
  normalize,
  validateDesign,
  layoutSchematic,
  orderByConnectivity,
  partExtent,
  unionRect
};
