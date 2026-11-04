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
// BOM-tolerant JSON reading: user-authored design.json files often carry a
// U+FEFF (Notepad / "UTF-8 with BOM"). `utils` requires nothing from lib/, so
// this dependency direction cannot form a cycle.
const { readJsonText, parseJsonText } = require('./utils');
const P = require('./parts');
const T = require('./sch-tokens');

const DEFAULTS = {
  schematic: 'Schematic1',
  sheet: 'P1',
  pcb: 'PCB1',
  board: { width: 1600, height: 1000 },
  layout: {
    cols: 3, cellW: T.CELL_W, cellH: T.CELL_H,
    blockGapX: T.BLOCK_GAP_X, blockGapY: T.BLOCK_GAP_Y, margin: T.MARGIN
  }
};

const BLOCK_TITLE_H = T.TITLE_H;

class DesignError extends Error {}

function fail(msg) { throw new DesignError(msg); }

function readDesign(file) {
  if (!fs.existsSync(file)) fail(`design file not found: ${file}`);
  let raw;
  try {
    raw = parseJsonText(readJsonText(file));
  } catch (e) {
    fail(`design file is not valid JSON: ${e.message}`);
  }
  return normalize(raw, file);
}

/**
 * Load a normalized design from a design.json or from a generator module
 * (`--gen <file>` exporting `(A) => design`, see lib/authoring.js).
 * Shared by `netlist.js --audit` and `make-board.js` so the audit compares the
 * SAME design the build used — for a 50-part board written as a generator there
 * is no design.json to read.
 */
function readSource(file, isGen) {
  if (!isGen) return readDesign(file);
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) fail(`generator not found: ${abs}`);
  const A = require('./authoring').createAuthoring();
  const gen = require(abs);
  if (typeof gen !== 'function') {
    fail('generator file must export a function: module.exports = (A) => { ...; return A.design(); }');
  }
  return normalize(gen(A), abs);
}

// ------------------------------------------------------------ IC pinout library
// Model-specific parts are NOT shipped with the skill. 2.x resolves them
// through the EDA client CLI at build time: the device is looked up in the
// system library, its GEOMETRY is read for layout, and the client places the
// official symbol/footprint instance itself (no local cache, no document
// download). The design only names the device:
//
//   { "id": "U1", "ic": "STM32F103C8T6" }         // by device name
//   { "id": "U1", "ic": "STM32F103C8T6", "lcsc": "C8734" }   // exact LCSC id
//
// resolveIcPart keeps that reference until build.js resolves it.
function resolveIcPart(p) {
  if (!p || typeof p !== 'object' || !p.ic) return p;
  if (p.symbol) fail(`part "${p.id}": give "ic" OR "symbol", not both`);
  if (p.footprint) fail(`part "${p.id}": give "ic" OR "footprint", not both (the system library ships one)`);
  return Object.assign({}, p, {
    libraryRef: { name: String(p.ic), lcsc: p.lcsc === undefined ? null : String(p.lcsc) }
  });
}

/** Build the single multi-part symbol spec for a multi-unit component: one
 *  symbol doc holds N PARTs (one per unit). Each part's pins are grouped (or
 *  flat) and laid out by parts.js into a wide body with the EasyEDA Pro label
 *  style (name inside, number outside). */
function multiPartSymbolSpec(base, part) {
  const name = part.symbolName || (part.name || base);
  const pinListOf = (pins, pinNames) => Object.entries(pins || {}).map(([num, net]) => {
    const pn = pinNames && pinNames[num];
    return `${num}:${pn || net}`;
  });
  const parts = part.units.map((u) => {
    if (u.groups && u.groups.length) {
      return { title: u.name || u.id, groups: u.groups.map((g) => ({ name: g.name || '', pins: pinListOf(g.pins, u.pinNames) })) };
    }
    return { title: u.name || u.id, groups: [{ name: '', pins: pinListOf(u.pins, u.pinNames) }] };
  });
  return {
    name, designator: part.designator || 'U', pitch: part.pitch, halfW: part.halfW,
    parts, multipart: true
  };
}

/** Expand multi-unit components into one schematic part per unit. A component
 *  with `units` becomes N parts (U34A/U34B/…) sharing ONE footprint and ONE
 *  multi-part symbol doc; the PCB stage re-merges them by `multiUnitBase`.
 *  Returns {parts, multiUnits}. */
function expandMultiUnits(rawParts) {
  const multiUnits = {};
  const out = [];
  for (const p of rawParts) {
    if (p.units && Array.isArray(p.units) && p.units.length) {
      const base = String(p.id);
      const sym = multiPartSymbolSpec(base, p);
      const ids = [];
      p.units.forEach((u, i) => {
        const uid = `${base}${u.id}`;
        ids.push(uid);
        out.push(Object.assign({}, p, {
          id: uid,
          symbol: { name: sym.name, designator: sym.designator, multipart: base, partIndex: i },
          pins: Object.assign({}, u.pins),
          units: undefined,
          multiUnitBase: base,
          multiUnitPart: i,
          // a bank symbol is read left-to-right: never let the rotation pass
          // turn it (pin names would run vertically and the block loses its shape)
          rotation: 0
        }));
      });
      multiUnits[base] = {
        designator: p.designator || 'U',
        name: p.name,
        footprint: p.footprint,
        units: ids,
        symbol: sym
      };
    } else {
      out.push(p);
    }
  }
  return { parts: out, multiUnits };
}

/** Map unit designator ("U34A") → base designator ("U34") for multi-unit
 *  components, so the schematic↔PCB netlist comparison can match a unit's
 *  pins to the single footprint that carries them. */
function multiUnitBaseOf(multiUnits) {
  const m = new Map();
  for (const [base, info] of Object.entries(multiUnits || {})) {
    for (const uid of info.units) m.set(uid, base);
  }
  return m;
}

/** Apply defaults and resolve the shorthand forms into one canonical shape. */
function normalize(raw, file) {
  if (!raw || typeof raw !== 'object') fail('design must be a JSON object');
  const expanded = expandMultiUnits(Array.isArray(raw.parts) ? raw.parts.map((p) => resolveIcPart(p)) : []);
  const rawParts = expanded.parts;
  const d = {
    file: file || null,
    name: raw.name || (file ? path.basename(file).replace(/\.json$/i, '') : 'project'),
    schematic: (raw.sheet && raw.sheet.schematic) || raw.schematic || DEFAULTS.schematic,
    sheet: (raw.sheet && (raw.sheet.name || raw.sheet.title)) || raw.sheetName || DEFAULTS.sheet,
    pcb: raw.pcbName || DEFAULTS.pcb,
    board: Object.assign({}, DEFAULTS.board, raw.board || {}),
    // an explicitly declared board is a floor (grown if needed); an undeclared
    // one auto-fits the parts (build.js shrinks the 1600×1000 default to fit)
    boardDeclared: !!(raw.board && Number(raw.board.width) > 0 && Number(raw.board.height) > 0),
    layout: Object.assign({}, DEFAULTS.layout, raw.layout || {}),
    powers: Object.assign({}, raw.powers || {}),
    nets: Object.assign({}, raw.nets || {}),
    blocks: [],
    parts: [],
    pcbSpec: raw.pcb && typeof raw.pcb === 'object' ? raw.pcb : {},
    skipPcb: raw.pcb === false,
    // schematic pagination: 1 = every block on one sheet; N = blocks fill N
    // sheets in declaration order (or per-block "sheet" overrides). The
    // intake asks 单页/多页 before generating.
    sheets: Math.max(1, Math.floor(Number(raw.sheets) || 1)),
    // optional functional page titles, one per sheet (tab text + file name).
    // Without them each sheet is named after its first block.
    sheetNames: Array.isArray(raw.sheetNames)
      ? raw.sheetNames.map((x) => String(x)).filter(Boolean)
      : [],
    expect: raw.expect && typeof raw.expect === 'object' ? raw.expect : null,
    // multi-unit components: base designator → {designator, name, footprint, units:[unitIds]}
    multiUnits: expanded.multiUnits
  };

  // nets may also declare power style: "nets": { "VCC": { "power": "up" } }
  // or a per-net track width: "nets": { "MOTOR_A": { "width": 30 } }.
  // netClasses group knobs: "netClasses": { "POWER": { "width": 30 } },
  // "nets": { "VCC": { "class": "POWER" } }.
  const netWidths = {};
  const netClasses = {};
  for (const [name, spec] of Object.entries(raw.netClasses || {})) {
    if (spec && typeof spec === 'object' && Number(spec.width) > 0) netClasses[name] = { width: Number(spec.width) };
  }
  for (const [name, spec] of Object.entries(d.nets)) {
    if (!spec || typeof spec !== 'object') continue;
    if (spec.power) d.powers[name] = spec.power;
    if (Number(spec.width) > 0) netWidths[name] = Number(spec.width);
    else if (spec.class && netClasses[spec.class]) netWidths[name] = netClasses[spec.class].width;
  }
  d.netWidths = netWidths;

  const partsIn = rawParts;
  if (!partsIn.length) fail('design has no "parts" — nothing to build');
  const seen = new Set();
  d.parts = partsIn.map((p, i) => {
    if (!p || typeof p !== 'object') fail(`parts[${i}] must be an object`);
    const id = String(p.id || '').trim();
    if (!id) fail(`parts[${i}] has no "id"`);
    if (seen.has(id)) fail(`duplicate part id "${id}"`);
    seen.add(id);
    if (!p.symbol && !p.libraryRef) fail(`part "${id}" has no "symbol"`);
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
    // role binding (typed recipes): `roles: { VDD: '3V3', SDA: 'I2C_SDA' }`
    // expands to pin→net through the device entry's pinRoles. Explicit
    // parts[].pins win when both are given.
    const roleNets = {};
    if (p.roles && typeof p.roles === 'object' && p.pinRoles) {
      for (const [role, net] of Object.entries(p.roles)) {
        const nums = p.pinRoles[role];
        if (nums === undefined) fail(`part "${id}": role "${role}" does not exist on ${p.ic || 'the device'} (roles: ${Object.keys(p.pinRoles).join(', ')})`);
        for (const num of [].concat(nums)) {
          if (pins[String(num)] === undefined) pins[String(num)] = String(net);
          roleNets[role] = String(net);
        }
      }
    }
    const rot = Number(p.rotation || p.rot || 0);
    // autoNC: unmapped pins of inline/IC symbols default to NC (the IC entry
    // or inline spec defines the pin numbers, so this is evidence-based)
    const autoNC = p.autoNC === true || d.autoNC === true;
    if (autoNC) {
      let symNums = null;
      // an "ic" part's pin numbers come from the resolved system-library
      // device; build.js fills the unmapped pins after the CLI lookup
      if (p.symbol && typeof p.symbol === 'object' && Array.isArray(p.symbol.pins)) {
        symNums = p.symbol.pins.map((s) => String(typeof s === 'string' ? s.split(':')[0] : (s.num || '')));
      }
      if (symNums) {
        for (const num of symNums) if (pins[num] === undefined) pins[num] = 'NC';
      }
    }
    if (![0, 90, 180, 270].includes(rot)) fail(`part "${id}": rotation must be 0/90/180/270`);
    // electrical directions (I/O/B/P/W/T/C) declared on the symbol spec or the
    // IC entry — consumed by the ERC output-conflict check (E008)
    const pinDirs = {};
    if (p.symbol && typeof p.symbol === 'object' && Array.isArray(p.symbol.pins)) {
      for (const t of P.parseAutoPinSpec(p.symbol.pins)) {
        if (t.dir) pinDirs[String(t.num)] = t.dir;
      }
    }
    return {
      id,
      symbol: p.symbol,
      footprint: p.footprint || null,
      value: p.value === undefined ? null : String(p.value),
      name: p.name || null,
      pins,
      pinDirs,
      polarity: p.polarity && typeof p.polarity === 'object' ? p.polarity : null,
      // "shunt" = TVS / flyback / clamp diode: its cathode legitimately sits on
      // a supply rail and its anode on ground, so the polarity gate must not
      // read "+" on a ground net as a reversal (intent.js I001)
      role: p.role === undefined ? null : String(p.role),
      // pin definitions source note (datasheet URL / 官方库出处) — required by
      // I007 for multi-pin inline symbols that look like real devices
      pinoutSource: p.pinoutSource === undefined ? null : String(p.pinoutSource),
      // system-library reference (resolved by build.js through the client CLI)
      ic: p.ic === undefined ? null : String(p.ic),
      libraryRef: p.libraryRef || null,
      autoNC,
      // device metadata + role binding (typed recipes; gate I008)
      deviceClass: p.deviceClass || null,
      pinRoles: p.pinRoles || null,
      requiredRoles: p.requiredRoles || null,
      roles: Object.keys(roleNets).length ? roleNets : null,
      rotation: rot,
      // the author chose this rotation — sch-tidy must not move it
      rotationExplicit: p.rotation !== undefined || p.rot !== undefined,
      // multi-unit component: this part is one unit of `multiUnitBase` (the PCB
      // stage re-merges units into ONE footprint with this base designator)
      multiUnitBase: p.multiUnitBase === undefined ? null : String(p.multiUnitBase),
      block: p.block === undefined ? null : (typeof p.block === 'number' ? p.block : String(p.block))
    };
  });

  // Blocks: explicit list first, leftovers go to an implicit MISC block.
  const blocksIn = Array.isArray(raw.blocks) ? raw.blocks : [];
  const assigned = new Map();
  blocksIn.forEach((b, i) => {
    if (!b || typeof b !== 'object') fail(`blocks[${i}] must be an object`);
    const title = String(b.title || b.name || `BLOCK ${i + 1}`);
    // a block may list a multi-unit component's base id ("U34") — expand it to
    // its unit ids so each schematic symbol lands in the block
    const list = Array.isArray(b.parts)
      ? b.parts.map(String).flatMap((id) => (d.multiUnits[id] ? d.multiUnits[id].units : [id]))
      : [];
    for (const id of list) {
      if (!seen.has(id)) fail(`block "${title}" references unknown part "${id}"`);
      if (assigned.has(id)) fail(`part "${id}" is listed in two blocks`);
      assigned.set(id, i);
    }
    d.blocks.push({
      title,
      parts: list,
      colspan: Number(b.colspan || 0) || 0,
      // one-line functional description rendered under the block title
      desc: b.desc === undefined ? '' : String(b.desc),
      // explicit sheet assignment (1-based); undefined → auto-filled below
      sheet: b.sheet === undefined ? null : Number(b.sheet)
    });
  });
  const leftovers = d.parts.filter((p) => !assigned.has(p.id)).map((p) => p.id);
  if (leftovers.length) {
    if (!d.blocks.length) d.blocks.push({ title: 'CIRCUIT', parts: [], sheet: null });
    d.blocks[d.blocks.length - 1].parts.push(...leftovers);
  }
  // drop empty blocks, then reindex every part → block
  d.blocks = d.blocks.filter((b) => b.parts.length);
  // sheet assignment: explicit per-block wins, otherwise blocks fill pages in
  // declaration order (ceil(blocks/sheets) per page)
  for (const b of d.blocks) {
    if (b.sheet !== null && (!Number.isInteger(b.sheet) || b.sheet < 1 || b.sheet > d.sheets)) {
      fail(`block "${b.title}": sheet ${b.sheet} out of range 1..${d.sheets}`);
    }
  }
  const auto = d.blocks.filter((b) => b.sheet === null);
  const perSheet = Math.ceil(auto.length / d.sheets) || 1;
  auto.forEach((b, i) => { b.sheet = Math.min(d.sheets, Math.floor(i / perSheet) + 1); });
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
      if (!p.footprint && !p.libraryEntry) {
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
  // per-net track width sanity: below 4 mil does not etch reliably, above 100
  // is never a trace (that is a plane). Since 1.13 widths are HANDOFF
  // annotations — the skill never lays copper; the client honors them when a
  // human routes, and the DRC uses them as floors for imported copper.
  for (const [net, width] of Object.entries(d.netWidths || {})) {
    if (width < 4 || width > 100) {
      errors.push(`net "${net}": track width ${width} mil is out of range (4–100)`);
    } else if (width > 40) {
      warnings.push(`net "${net}": track width ${width} mil is very wide — it is an annotation for the client; a plane (poured in the client) usually beats one fat trace`);
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
 *
 * Blocks wrap onto a new row when the next one would run past the A4 drawing
 * frame (lint.js FRAME width 11700 mil) — a one-row layout silently pushed
 * parts off-sheet on larger designs, and L007 only warned about it.
 */
function layoutSchematic(d, lib) {
  const L = d.layout;
  // Pack blocks into a near-square (√N × √N) grid — N is the count of blocks
  // ON THIS SHEET, not the whole design (the design-wide count spread a
  // 9-block sheet across a 31-inch row of 8 columns).
  const blocksPerSheet = new Map();
  for (const b of d.blocks) blocksPerSheet.set(b.sheet, (blocksPerSheet.get(b.sheet) || 0) + 1);
  const placements = [];
  const blocks = [];
  let cursorX = 0;
  let colInRow = 0;
  let rowBaseY = 100;           // y of the current block row top (y-down: increases)
  let rowMaxH = 0;              // tallest block frame in the current row
  let currentSheet = 0;         // sheet the cursors belong to (reset on change)
  let colsPerRow = 1;

  for (const block of d.blocks) {
    // a new sheet starts a fresh cursor: blocks on sheet 2+ are laid out
    // independently (multi-sheet = the intake's 单页/多页 answer)
    if (block.sheet !== currentSheet) {
      currentSheet = block.sheet;
      colsPerRow = Math.max(1, Math.ceil(Math.sqrt(blocksPerSheet.get(block.sheet) || 1)));
      cursorX = 0;
      rowBaseY = 0;
      rowMaxH = 0;
      colInRow = 0;
    }
    const members = block.parts
      .map((id) => d.parts.find((p) => p.id === id))
      .filter(Boolean);
    if (!members.length) continue;
    const ordered = orderByConnectivity(members);
    const n = ordered.length;
    const cols = Math.max(1, Math.min(L.cols, Math.ceil(Math.sqrt(n)) || 1));

    // Row/column pitch adapts to the real symbol extents: small parts keep the
    // default grid, a 48-pin IC stretches its cell instead of overlapping.
    const rels = ordered.map((part) => {
      const sym = lib.symbolOf(part);
      const rot = part.rotation || 0;
      return { part, sym, rot, rel: partExtent(sym, 0, 0, rot) };
    });
    const rows = Math.ceil(n / cols) || 1;
    // Column/row pitches from the ACTUAL rotated extents, including their
    // asymmetry: a rotated symbol's extent box may reach far to the LEFT of
    // its origin (U2 rot 270 reached back 150 mil into the previous column),
    // so each column/row tracks its backward reach separately.
    const colBack = new Array(cols).fill(0);   // min rel.x1 (≤ 0) per column
    const colFwd = new Array(cols).fill(0);    // max rel.x2 per column
    const rowBack = new Array(rows).fill(0);   // min rel.y1 per row
    const rowFwd = new Array(rows).fill(0);    // max rel.y2 per row
    rels.forEach((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      colBack[col] = Math.min(colBack[col], r.rel.x1);
      colFwd[col] = Math.max(colFwd[col], r.rel.x2);
      rowBack[row] = Math.min(rowBack[row], r.rel.y1);
      rowFwd[row] = Math.max(rowFwd[row], r.rel.y2);
    });
    // Origins of one column share an x; a rotated symbol's extent may reach
    // BACKWARD past its origin (U2 rot 270 reaches 150 mil left), so each
    // column's origins shift right by its backward reach and the pitch covers
    // shift + forward reach + gutter. Rows are TOP-aligned (py anchors every
    // part's extent top to the row line), so height alone governs rowPitch.
    const colShift = colBack.map((b) => Math.max(0, -b));
    const colPitch = colBack.map((b, c) => grid(Math.max(L.cellW, colShift[c] + colFwd[c] + 30)));
    const rowPitch = rowBack.map((b, r) => grid(Math.max(L.cellH, (rowFwd[r] - b) + 30)));

    // wrap after colsPerRow blocks — the √N grid keeps the sheet landscape
    // instead of a tall sparse column
    if (colInRow >= colsPerRow) {
      rowBaseY += rowMaxH + L.blockGapY;
      cursorX = 0;
      rowMaxH = 0;
      colInRow = 0;
    }

    let box = null;
    rels.forEach((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // Y-down: rows march downward from the block's top (y increases),
      // columns left→right. The part's extent TOP (smallest y) anchors to the
      // row top line.
      const colStart = colPitch.slice(0, col).reduce((a, b) => a + b, 0) + colShift[col];
      const rowTop = L.margin + rowPitch.slice(0, row).reduce((a, b) => a + b, 0);
      const px = grid(cursorX + L.margin + colStart);
      const py = grid(rowBaseY + rowTop - r.rel.y1);
      const pl = { part: r.part, sym: r.sym, x: px, y: py, rotation: r.rot, block, sheet: currentSheet };
      pl.extent = partExtent(r.sym, px, py, r.rot);
      placements.push(pl);
      box = unionRect(box, pl.extent);
    });

    // Frame padding must hold the NET NAMES, port bodies and designator text,
    // not just the symbol extents: ports print their net ~45 mil beyond a
    // 40-mil body, and flags print theirs above/below. 36 mil left names
    // outside the black frame (the user's complaint); 110 matches the layered
    // placer and the chain macro.
    const pad = T.FRAME_PAD;
    // The client draws Y-UP: the bigger coordinate is the top edge. Reserve the
    // title strip on the TOP so the module caption reads top-left (it used to
    // sit at the bottom because the strip was subtracted from y1).
    const rect = {
      x1: grid(box.x1 - pad),
      y1: grid(box.y1 - pad),
      x2: grid(box.x2 + pad),
      y2: grid(box.y2 + pad + BLOCK_TITLE_H)
    };
    blocks.push({ title: block.title, desc: block.desc, sheet: block.sheet, rect, members: ordered.map((p) => p.id) });
    cursorX = rect.x2 + L.blockGapX;
    rowMaxH = Math.max(rowMaxH, rect.y2 - rect.y1);
    colInRow += 1;
  }
  return { placements, blocks };
}

const grid = (v) => Math.round(v / 10) * 10;

module.exports = {
  DEFAULTS,
  DesignError,
  readDesign,
  readSource,
  normalize,
  validateDesign,
  layoutSchematic,
  orderByConnectivity,
  partExtent,
  unionRect,
  multiUnitBaseOf
};
