'use strict';
/**
 * design.js — the declaration layer.
 *
 * A design file (`design.json`) describes WHAT the circuit is; this module
 * normalizes the circuit and preserves explicitly authored geometry.
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
 *   "sch": { "place": { "R1": [300, 300, 0] }, "wires": [] }
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

const DEFAULTS = {
  schematic: 'Schematic1',
  sheet: 'P1',
  pcb: 'PCB1',
  board: { width: 1600, height: 1000 }
};

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
    libraryRef: { name: String(p.ic), lcsc: p.lcsc === undefined ? null : String(p.lcsc), subPartName: p.subPartName || undefined }
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
          symbol: p.ic ? undefined : { name: sym.name, designator: sym.designator, multipart: base, partIndex: i },
          subPartName: u.subPartName,
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
  const expanded = expandMultiUnits(Array.isArray(raw.parts) ? raw.parts : []);
  const rawParts = expanded.parts.map(resolveIcPart);
  const d = {
    file: file || null,
    name: raw.name || (file ? path.basename(file).replace(/\.json$/i, '') : 'project'),
    schematic: (raw.sheet && raw.sheet.schematic) || raw.schematic || DEFAULTS.schematic,
    sheet: (raw.sheet && (raw.sheet.name || raw.sheet.title)) || raw.sheetName || DEFAULTS.sheet,
    pcb: raw.pcbName || DEFAULTS.pcb,
    board: Object.assign({}, DEFAULTS.board, raw.board || {}),
    boardDeclared: !!(raw.board && Object.hasOwn(raw.board, 'width') && Object.hasOwn(raw.board, 'height')),
    schSpec: raw.sch,
    frame: raw.frame || {},
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
    // requirement metadata carried over from intake (function / input power /
    // rails / interfaces / current): the project report turns it into the
    // functional description. The build itself never reads it, so an old
    // design.json without `meta` keeps working.
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : null,
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
  d.explicitSheetAssignments = leftovers.length === 0 && d.blocks.every((b) => b.sheet !== null);
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
  // is normally a plane. Width declarations are DRC floors, not routes.
  for (const [net, width] of Object.entries(d.netWidths || {})) {
    if (width < 4 || width > 100) {
      errors.push(`net "${net}": track width ${width} mil is out of range (4–100)`);
    } else if (width > 40) {
      warnings.push(`net "${net}": track width ${width} mil is very wide; consider a plane`);
    }
  }
  return { errors, warnings, netUsers };
}

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

const NC_NET = /^(D?NC\d*|N\/C)$/i;
function noConnectPins(design) {
  const pins = new Set();
  for (const part of design?.parts || []) {
    for (const [num, net] of Object.entries(part.pins)) if (NC_NET.test(net)) {
      pins.add(`${part.multiUnitBase || part.id}.${num}`);
    }
  }
  return pins;
}

module.exports = {
  NC_NET,
  noConnectPins,
  DEFAULTS,
  DesignError,
  readDesign,
  readSource,
  normalize,
  validateDesign,
  partExtent,
  multiUnitBaseOf
};
