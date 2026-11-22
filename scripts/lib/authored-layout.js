'use strict';

// Interpret AI-authored geometry. This module never picks positions, layers or paths.
const G = require('./geom');
const D = require('./design');
const P = require('./parts');
const isNC = (net) => D.NC_NET.test(net || '');
const own = (obj, key) => Object.hasOwn(obj, key);
const fail = (message) => { throw new D.DesignError(`${message} — supply or correct the AI layout (docs/ai-layout.md)`); };
// Sheet coordinates are authored as literals and pin tips are rounded to 0.001,
// so "the same point" means within that grid — stricter than the client's
// exact equality would only produce messages nobody can satisfy.
const ptEq = (a, b) => Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
/** Nearest wire endpoint to (x,y): the coordinate the author most likely meant. */
function nearestEndpoint(segs, x, y) {
  let best = null;
  for (const s of segs) {
    for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const d = Math.hypot(px - x, py - y);
      if (!best || d < best.d) best = { d, x: px, y: py };
    }
  }
  return best;
}

function object(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${key} must be an object`);
  return value;
}
function list(value, key) {
  if (!Array.isArray(value)) fail(`${key} must be an array`);
  return value;
}
function tuple(value, length, key) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    fail(`${key} must contain exactly ${length} finite numbers`);
  }
  return value.slice();
}
function positive(value, key) {
  if (!Number.isFinite(value) || value <= 0) fail(`${key} must be a positive number`);
  return value;
}
function segments(points, key, orthogonal = false) {
  const path = list(points, `${key}.points`).map((p, i) => tuple(p, 2, `${key}.points[${i}]`));
  if (path.length < 2) fail(`${key}.points needs at least two points`);
  return path.slice(1).map(([x2, y2], i) => {
    const [x1, y1] = path[i];
    if (x1 === x2 && y1 === y2) fail(`${key} has a zero-length segment at ${i}`);
    if (orthogonal && x1 !== x2 && y1 !== y2) fail(`${key} segment ${i} is not orthogonal`);
    return { x1, y1, x2, y2 };
  });
}
function pcbParts(design) {
  const result = new Map();
  for (const part of design.parts) {
    const id = part.multiUnitBase || part.id;
    if (!result.has(id)) result.set(id, { ...part, id, pins: { ...part.pins } });
    else Object.assign(result.get(id).pins, part.pins);
  }
  return [...result.values()];
}
function positions(parts, values, key, read) {
  const map = object(values, key);
  const ids = new Set(parts.map((p) => p.id));
  const missing = parts.filter((p) => !own(map, p.id)).map((p) => p.id);
  const unknown = Object.keys(map).filter((id) => !ids.has(id));
  if (missing.length || unknown.length) {
    fail(`${key}: ${[missing.length && `missing ${missing.join(', ')}`, unknown.length && `unknown ${unknown.join(', ')}`].filter(Boolean).join('; ')}`);
  }
  return parts.map((p) => read(p, tuple(map[p.id], 3, `${key}.${p.id}`)));
}
function netNames(parts) {
  return new Set(parts.flatMap((p) => Object.values(p.pins)).filter((n) => n && !isNC(n)));
}
function netName(net, key, nets) {
  if (!nets.has(net)) fail(`${key}.net is not a connected design net: ${JSON.stringify(net)}`);
  return net;
}
function sheetNumber(value, key, design) {
  const sheet = value === undefined && design.sheets === 1 ? 1 : value;
  if (!Number.isInteger(sheet) || sheet < 1 || sheet > design.sheets) fail(`${key}.sheet must be in 1..${design.sheets}`);
  return sheet;
}
function schematic(design, lib) {
  const cfg = object(design.schSpec, 'sch');
  if (design.sheets > 1 && !design.explicitSheetAssignments) fail('multi-sheet layouts need blocks[].sheet for every block and all parts assigned to a block');
  const nets = netNames(design.parts);
  const placements = positions(design.parts, cfg.place, 'sch.place', (part, [x, y, rotation]) => {
    if (rotation % 90 !== 0) fail(`sch.place.${part.id} rotation must be a multiple of 90 degrees`);
    const sym = lib.symbolOf(part);
    const sheet = design.blocks[part.blockIndex].sheet;
    return { part, sym, x, y, rotation, sheet, extent: D.partExtent(sym, x, y, rotation) };
  });
  const wires = list(cfg.wires, 'sch.wires').map((wire, i) => {
    const key = `sch.wires[${i}]`;
    object(wire, key);
    if (wire.label !== undefined && typeof wire.label !== 'boolean') fail(`${key}.label must be boolean`);
    return { net: netName(wire.net, key, nets), sheet: sheetNumber(wire.sheet, key, design),
      label: wire.label !== false, segs: segments(wire.points, key, true) };
  });
  function terminals(value, group, stock, defaultKind) {
    return list(value ?? [], `sch.${group}`).map((terminal, i) => {
      const key = `sch.${group}[${i}]`;
      object(terminal, key);
      const [x, y] = tuple(terminal.at, 2, `${key}.at`);
      const net = netName(terminal.net, key, nets);
      const sheet = sheetNumber(terminal.sheet, key, design);
      const kind = terminal.kind ?? defaultKind;
      if (!stock.includes(kind)) fail(`${key}.kind must be ${stock.join(' or ')}`);
      return { x, y, net, sheet, kind, style: kind, rot: 0 };
    });
  }
  const flags = terminals(cfg.flags, 'flags', ['up', 'down'], 'up');
  const ports = terminals(cfg.ports, 'ports', ['IN', 'OUT', 'BI'], 'BI');
  const frames = object(cfg.frames ?? {}, 'sch.frames');
  const blocks = Object.keys(frames).map((key) => {
    const block = design.blocks[Number(key) - 1];
    if (!block || String(Number(key)) !== key) fail(`sch.frames.${key} must index a declared block`);
    const [x1, y1, x2, y2] = tuple(frames[key], 4, `sch.frames.${key}`);
    if (x1 >= x2 || y1 >= y2) fail(`sch.frames.${key} needs increasing bounds`);
    return { ...block, rect: { x1, y1, x2, y2 } };
  });
  const terminalsBySheet = [...flags, ...ports, ...placements.flatMap((pl) => pl.sym.pins.map((pin) => ({
    ...G.pinTip(pin, pl.x, pl.y, pl.rotation), sheet: pl.sheet, net: pl.part.pins[pin.num],
    ref: `${pl.part.id}.${pin.num}`
  })))];
  const endpoint = (seg, x, y) => (seg.x1 === x && seg.y1 === y) || (seg.x2 === x && seg.y2 === y);
  const sameNet = (a, b) => a && a === b && !isNC(a);
  for (const t of terminalsBySheet) {
    for (const w of wires) if (w.sheet === t.sheet && !sameNet(w.net, t.net)) {
      if (w.segs.some((seg) => G.pointSegDist(t, seg) < G.EPS)) {
        fail(`P${t.sheet}: wire ${w.net} touches ${t.ref || t.net} at ${t.x},${t.y}`);
      }
    }
  }
  for (let i = 0; i < terminalsBySheet.length; i += 1) {
    const a = terminalsBySheet[i];
    for (let j = i + 1; j < terminalsBySheet.length; j += 1) {
      const b = terminalsBySheet[j];
      if (a.sheet === b.sheet && a.x === b.x && a.y === b.y && !sameNet(a.net, b.net)) {
        fail(`P${a.sheet}: ${a.ref || a.net} contacts ${b.ref || b.net} at ${a.x},${a.y}`);
      }
    }
  }
  for (let i = 0; i < wires.length; i += 1) {
    const a = wires[i];
    for (let j = i + 1; j < wires.length; j += 1) {
      const b = wires[j];
      if (a.sheet !== b.sheet || a.net === b.net) continue;
      for (const t of a.segs) for (const u of b.segs) {
        const touching = [[t.x1, t.y1], [t.x2, t.y2], [u.x1, u.y1], [u.x2, u.y2]].find(([x, y]) =>
          (endpoint(t, x, y) && G.pointSegDist({ x, y }, u) < G.EPS) ||
          (endpoint(u, x, y) && G.pointSegDist({ x, y }, t) < G.EPS));
        if (touching) fail(`P${a.sheet}: ${a.net} contacts ${b.net} at ${touching.join(',')}`);
      }
    }
  }
  // ---------------------------------------------------------- connectivity
  // Written geometry is final, so prove it BEFORE anything reaches disk: every
  // pin must land on a wire END (the client joins only at ends), every
  // flag/port must sit on one, and a net that spans pages must be linked by a
  // port/flag on each page. Reporting all of them at once keeps the AI from
  // fix-one-rerun loops, and the message names the exact coordinate to use.
  const problems = [];
  const segsBySheet = new Map();
  for (const w of wires) {
    if (!segsBySheet.has(w.sheet)) segsBySheet.set(w.sheet, []);
    for (const s of w.segs) segsBySheet.get(w.sheet).push({ ...s, net: w.net });
  }
  const pins = [];
  for (const pl of placements) {
    for (const pin of pl.sym.pins) {
      const t = G.pinTip(pin, pl.x, pl.y, pl.rotation);
      pins.push({
        x: t.x, y: t.y, net: pl.part.pins[String(pin.num)] ?? null,
        ref: pl.part.id, num: String(pin.num), sheet: pl.sheet
      });
    }
  }
  const atEnd = (seg, p) => ptEq({ x: seg.x1, y: seg.y1 }, p) || ptEq({ x: seg.x2, y: seg.y2 }, p);
  for (const p of pins) {
    if (!p.net || isNC(p.net)) continue;
    const segs = segsBySheet.get(p.sheet) || [];
    if (segs.some((s) => atEnd(s, p))) continue;
    if (pins.some((q) => q !== p && q.sheet === p.sheet && ptEq(q, p) && q.net === p.net)) continue;
    const near = nearestEndpoint(segs, p.x, p.y);
    const mid = segs.find((s) => G.pointSegDist(p, s) < G.EPS && !atEnd(s, p));
    const why = mid
      ? `the tip lands on the middle of net "${mid.net}"'s wire — split that segment at ${p.x},${p.y} in sch.wires`
      : near
        ? `no wire ends there; the nearest endpoint ${near.x},${near.y} is ${near.d.toFixed(1)} mil away — add [${p.x},${p.y}] to the points of net "${p.net}" in sch.wires`
        : `no wire on sheet ${p.sheet} — add a segment ending at [${p.x},${p.y}] to net "${p.net}" in sch.wires`;
    problems.push(`pin ${p.ref}.${p.num} (net "${p.net}") at ${p.x},${p.y}: ${why}`);
  }
  for (const t of [...flags, ...ports]) {
    const segs = segsBySheet.get(t.sheet) || [];
    if (segs.some((s) => atEnd(s, t))) continue;
    const near = nearestEndpoint(segs, t.x, t.y);
    const kind = t.kind === 'up' || t.kind === 'down' ? 'power flag' : 'net port';
    problems.push(`${kind} "${t.net}" at ${t.x},${t.y} (sheet ${t.sheet}) is not on a wire endpoint`
      + (near ? `; the nearest endpoint ${near.x},${near.y} is ${near.d.toFixed(1)} mil away` : '; add a wire ending there'));
  }
  const pinSheets = new Map();
  for (const p of pins) {
    if (!p.net || isNC(p.net)) continue;
    if (!pinSheets.has(p.net)) pinSheets.set(p.net, new Set());
    pinSheets.get(p.net).add(p.sheet);
  }
  for (const [net, sheets] of pinSheets) {
    if (sheets.size < 2) continue;
    const linked = new Set([...flags, ...ports].filter((t) => t.net === net).map((t) => t.sheet));
    const list = [...sheets].sort((a, b) => a - b);
    for (const s of list) {
      if (!linked.has(s)) {
        problems.push(`net "${net}" has pins on sheets ${list.join(', ')} but sheet ${s} has no net port or power flag — a wire name alone does not cross pages`);
      }
    }
  }
  if (problems.length) fail(`schematic connectivity:\n  - ${problems.join('\n  - ')}`);

  return { placements, blocks, routed: { wires, flags, ports, issues: [], stats: {
    segments: wires.reduce((n, w) => n + w.segs.length, 0), flags: flags.length, ports: ports.length
  } } };
}

function pcb(design, lib) {
  const cfg = design.pcbSpec;
  if (!design.boardDeclared) fail('PCB needs explicit board.width and board.height (mil)');
  positive(design.board.width, 'board.width');
  positive(design.board.height, 'board.height');
  const layers = design.board.layers ?? 2;
  if (!Number.isInteger(layers) || layers < 2 || layers > 32 || layers % 2) fail('board.layers must be an even integer from 2 to 32');
  const copperLayers = new Set([1, 2, ...Array.from({ length: layers - 2 }, (_, i) => i + 15)]);
  const parts = pcbParts(design);
  const placements = positions(parts, cfg.place, 'pcb.place', (part, pcbPos) => {
    if (!lib.footprintOf(part)?.pads.length) fail(`part ${part.id} needs a PCB footprint with pads`);
    return { part, pcbPos };
  });
  if (cfg.layout !== undefined || cfg.route !== undefined || cfg.pour !== undefined) {
    fail('legacy pcb.layout, pcb.route or pcb.pour is not supported; use pcb.tracks/vias and check pours separately in the editor');
  }
  const mode = cfg.mode ?? 'routed';
  if (!['routed', 'placed-only'].includes(mode)) fail('pcb.mode must be routed or placed-only');
  const nets = new Set(parts.flatMap((p) => lib.footprintOf(p).pads.map((pad) => p.pins[pad.num]))
    .filter((n) => n && !isNC(n)));
  const tracks = list(cfg.tracks ?? (mode === 'placed-only' ? [] : undefined), 'pcb.tracks').flatMap((track, i) => {
    const key = `pcb.tracks[${i}]`;
    object(track, key);
    const netNameValue = netName(track.net, key, nets);
    if (!copperLayers.has(track.layer)) fail(`${key}.layer is not an enabled copper layer`);
    const width = positive(track.width, `${key}.width`);
    return segments(track.points, key).map(({ x1, y1, x2, y2 }) => ({ netName: netNameValue, layerId: track.layer, width,
      startX: x1, startY: y1, endX: x2, endY: y2 }));
  });
  const vias = list(cfg.vias ?? [], 'pcb.vias').map((via, i) => {
    const key = `pcb.vias[${i}]`;
    object(via, key);
    const [x, y] = tuple(via.at, 2, `${key}.at`);
    const viaDiameter = positive(via.diameter, `${key}.diameter`);
    const holeDiameter = positive(via.drill, `${key}.drill`);
    if (holeDiameter >= viaDiameter) fail(`${key}.drill must be less than the diameter`);
    return { netName: netName(via.net, key, nets), x, y, viaDiameter, holeDiameter };
  });
  if (mode === 'placed-only' && (tracks.length || vias.length)) fail('pcb.mode placed-only cannot contain tracks or vias');
  return { placements, tracks, vias, copperLayers, mode };
}

function geometry(design, lib, doPcb) {
  // With sch.place present, every pin also carries its ABSOLUTE sheet position
  // (sheetAt): the AI must otherwise rotate+translate the symbol-local `at`
  // itself, and a one-mil arithmetic slip silently disconnects the net.
  const schPlace = (design.schSpec && design.schSpec.place) || {};
  const parts = design.parts.map((part) => {
    const sym = lib.symbolOf(part);
    const pos = schPlace[part.id];
    const placed = Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite) ? pos : null;
    return {
      ref: part.id,
      sheet: design.blocks[part.blockIndex].sheet,
      bbox: sym.bbox,
      ...(placed ? { place: [placed[0], placed[1], placed[2]] } : {}),
      pins: sym.pins.map((p) => {
        const r = placed ? G.rotate(p.x, p.y, placed[2] || 0) : null;
        return {
          num: p.num, name: p.name, net: part.pins[p.num] ?? null,
          at: [p.x, p.y], rotation: p.rotation, length: p.length,
          ...(r ? { sheetAt: [G.round(placed[0] + r.x), G.round(placed[1] + r.y)] } : {})
        };
      })
    };
  });
  const footprints = doPcb ? pcbParts(design).map((part) => {
    const fp = lib.footprintOf(part);
    if (!fp) return { ref: part.id, missing: true };
    const pos = design.pcbSpec.place?.[part.id];
    const placed = Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite) ? P.placedPads(fp, ...pos) : [];
    return { ref: part.id, bbox: fp.bbox, pads: fp.pads.map((p, i) => ({ num: p.num, net: part.pins[p.num] ?? null,
      at: [p.x, p.y], width: p.w, height: p.h, hole: p.hole, layer: p.layer || p.layerId || (p.hole ? 12 : 1),
      ...(placed[i] ? { boardAt: [placed[i].x, placed[i].y] } : {}) })) };
  }) : [];
  return { units: { pcb: 'mil', schematic: 'sheet units' }, parts, footprints };
}

module.exports = { schematic, pcb, geometry, isNC };
