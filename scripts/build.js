#!/usr/bin/env node
'use strict';
/**
 * build.js — the declarative entry point.
 *
 * One command, one design file, one complete project:
 *
 *   node scripts/build.js --design design.json --dir <projectDir> [--force]
 *
 * It bootstraps the project, resolves every library entry (presets, inline
 * specs, or staged files), lays the schematic out in signal-flow blocks, routes
 * every net on the SHEET (wire / L / Z / stub+label / power flag), annotates
 * the blocks, places the footprints on the PCB — placement only: this skill
 * NEVER auto-routes or pours copper; the rats list tells the human what to
 * finish in the client. Then it validates and reports, so an agent gets the
 * same information a human reviewer would.
 *
 * Re-running over an existing project requires --force, which deletes ONLY the
 * files this skill owns (index, sch/, pcb/, panel/, .tmp/).
 */

const fs = require('fs');
const path = require('path');
const E = require('./lib/eprj3');
const G = require('./lib/geom');
const P = require('./lib/parts');
const D = require('./lib/design');
const R = require('./lib/sch-route');
const PAT = require('./lib/sch-patterns');
const FA = require('./lib/fp-auto');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory to create', required: true },
  { name: 'design', desc: 'design.json file (or use --gen)' },
  { name: 'gen', desc: 'generator module exporting (A) => design — see lib/authoring.js' },
  { name: 'force', desc: 'overwrite an existing project (deletes skill-owned files only)', hasValue: false },
  { name: 'schematic-only', desc: 'skip the PCB entirely', hasValue: false },
  { name: 'allow-erc', desc: 'do not fail the build on ERC errors', hasValue: false },
  { name: 'allow-intent', desc: 'do not fail the build on design-intent errors', hasValue: false },
  { name: 'allow-lint', desc: 'do not fail the build on layout errors', hasValue: false },
  { name: 'allow-drc', desc: 'do not fail the build on DRC errors', hasValue: false },
  { name: 'allow-sch-drc', desc: 'do not fail the build on client schematic DRC errors', hasValue: false },
  { name: 'dry-run', desc: 'build into a throwaway directory, report, then delete it', hasValue: false },
  { name: 'report', desc: 'write the machine-readable build report to this file' },
  { name: 'digest', desc: 'print a one-page design digest (counts, gates, rats) — for resuming a session without re-reading logs', hasValue: false },
  { name: 'plan', desc: 'print what would be built (parts, nets, rules, intent gate) and write nothing', hasValue: false },
  { name: 'quiet', desc: 'only print the final summary line', hasValue: false },
  { name: 'no-tidy', desc: 'keep declared rotations (skip the sch-tidy orientation pass)', hasValue: false },
  { name: 'no-patterns', desc: 'skip the circuit-pattern macros (two-pin chains)', hasValue: false },
  { name: 'no-search', desc: 'skip the local block-move search pass', hasValue: false },
  { name: 'keep-tmp', desc: 'keep the .tmp staging area (normally removed after a clean build)', hasValue: false }
];

const SKILL_OWNED = ['sch', 'pcb', 'panel', '.tmp'];

function safeClean(dir) {
  const entries = fs.readdirSync(dir);
  const index = entries.find((e) => e.endsWith('.eprj3'));
  if (!index) {
    // no skill project here: the --gen workflow legitimately drops the
    // generator into the target directory. Wipe nothing — but refuse when
    // skill-owned dirs DO exist (that would be a broken project, not a fresh one)
    if (SKILL_OWNED.some((e) => entries.includes(e))) {
      die(`refusing to build into ${dir}: it contains skill-owned dirs but no .eprj3 index`);
    }
    return;
  }
  for (const e of entries) {
    if (SKILL_OWNED.includes(e) || e.endsWith('.eprj3') || e === '.easyeda-pro-client.json') {
      fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    }
  }
}

class Emitter {
  constructor(filePath) {
    this.filePath = filePath;
    this.lines = E.readLines(filePath);
    this.z = E.nextMainZIndex(this.lines);
    this.t = E.maxTicketOfLines(this.lines) + 1;
    this.docs = [];
  }

  nextZ() { return this.z++; }
  nextTicket() { return this.t++; }

  embed(docs) { for (const d of docs) this.docs.push(d); }

  addLines(lines) { this.lines = this.lines.concat(lines); }

  flush() {
    E.writeLines(this.filePath, this.lines);
    if (this.docs.length) E.insertDocsBeforeMain(this.filePath, this.docs);
  }
}

/**
 * Sheet coordinates are y-UP (the client reads them that way when every record
 * carries yAxisDirection "up"), so the page origin is the BOTTOM-left. The
 * layout packs from y=0 upward and lets a block's title strip dip below it;
 * lift each sheet's content by a margin so nothing hangs outside the border.
 */
function shiftSheetsIntoPage(placements, blocks) {
  const MARGIN = 40;
  const minY = new Map();
  const put = (s, y) => minY.set(s, Math.min(minY.has(s) ? minY.get(s) : Infinity, y));
  for (const pl of placements) put(pl.sheet || 1, pl.extent.y1);
  for (const b of blocks) put(b.sheet || 1, b.rect.y1);
  const dy = new Map();
  // snap the shift itself to the 10-mil grid: extents include the label band
  // (+16/+34 may be off-grid), and an unsnapped shift moves EVERY part off the
  // grid at once (lint L008 on parts nobody touched)
  for (const [s, y] of minY) dy.set(s, Math.round((MARGIN - y) / 10) * 10);
  for (const pl of placements) {
    const d = dy.get(pl.sheet || 1) || 0;
    if (!d) continue;
    pl.y += d;
    pl.extent.y1 += d;
    pl.extent.y2 += d;
  }
  for (const b of blocks) {
    const d = dy.get(b.sheet || 1) || 0;
    if (!d) continue;
    b.rect.y1 += d;
    b.rect.y2 += d;
  }
}

/**
 * Center each sheet's block group inside its page. The page is the smallest
 * standard size that fits (A4 for a small design), so without this the circuit
 * hugs the bottom-left border and the sheet reads as empty. Wires, flags and
 * ports move with the parts; the frame itself stays pinned to the page origin.
 */
/**
 * Module frames are sized from part extents before routing, but the router
 * then prints text OUTSIDE those extents: net-port names (45 units beyond the
 * port), power-flag names and stub-label names. Grow every frame to contain
 * the text that belongs to it (nearest frame within 200 units), with a 12-unit
 * margin, and never let a grown side come closer than 20 units to another
 * frame on the same sheet.
 */
/**
 * The client's NETOBJECTONGRID rule requires every net object on the 50-mil
 * grid (5 schematic units; the official example has every component at
 * 0/5 mod 10, and the DRC flags only the few routed jogs that end up off it).
 * Pin tips are already on the grid; the odd vertices come from router margins
 * (e.g. +18 / +53). Snap every wire vertex, flag and port with the same
 * mapping, so shared endpoints stay shared and connections survive.
 */
function snapNetObjectsToGrid(routed, grid) {
  const g = grid || 5;
  const snap = (v) => Math.round(v / g) * g;
  for (const w of routed.wires || []) {
    for (const s of w.segs) {
      s.x1 = snap(s.x1); s.y1 = snap(s.y1);
      s.x2 = snap(s.x2); s.y2 = snap(s.y2);
    }
  }
  for (const f of routed.flags || []) { f.x = snap(f.x); f.y = snap(f.y); }
  for (const p of routed.ports || []) { p.x = snap(p.x); p.y = snap(p.y); }
}

function growFramesToLabels(blocks, routed) {
  const textW = (s) => Math.max(20, String(s).length * 5.5);
  const boxes = [];
  for (const p of routed.ports || []) {
    const w = textW(p.net) + 45;
    const d = p.dir || { x: 1, y: 0 };
    let r;
    if (d.x > 0) r = G.rect(p.x, p.y - 8, p.x + w, p.y + 8);
    else if (d.x < 0) r = G.rect(p.x - w, p.y - 8, p.x, p.y + 8);
    else if (d.y > 0) r = G.rect(p.x - textW(p.net) / 2, p.y, p.x + textW(p.net) / 2, p.y + 58);
    else r = G.rect(p.x - textW(p.net) / 2, p.y - 58, p.x + textW(p.net) / 2, p.y);
    boxes.push({ sheet: p.sheet || 1, at: { x: p.x, y: p.y }, r });
  }
  for (const f of routed.flags || []) {
    const hw = textW(f.net) / 2;
    const r = f.style === 'down'
      ? G.rect(f.x - hw, f.y - 32, f.x + hw, f.y)
      : G.rect(f.x - hw, f.y, f.x + hw, f.y + 24);
    boxes.push({ sheet: f.sheet || 1, at: { x: f.x, y: f.y }, r });
  }
  for (const w of routed.wires || []) {
    if (!w.net || w.segs.length !== 1) continue;
    const s = w.segs[0];
    if (s.y1 !== s.y2 || s.x1 === s.x2) continue;
    const left = s.x2 < s.x1;
    const tw = textW(w.net);
    const r = left ? G.rect(s.x2 - tw, s.y2 - 7, s.x2, s.y2 + 7) : G.rect(s.x2, s.y2 - 7, s.x2 + tw, s.y2 + 7);
    boxes.push({ sheet: w.sheet || 1, at: { x: s.x2, y: s.y2 }, r });
  }
  const original = blocks.map((b) => Object.assign({}, b.rect));
  const grown = blocks.map((b) => Object.assign({}, b.rect));
  for (const bx of boxes) {
    let best = -1;
    let bestD = Infinity;
    blocks.forEach((b, i) => {
      if ((b.sheet || 1) !== bx.sheet) return;
      const r = original[i];
      const dx = Math.max(r.x1 - bx.at.x, 0, bx.at.x - r.x2);
      const dy = Math.max(r.y1 - bx.at.y, 0, bx.at.y - r.y2);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0 || bestD > 200) continue;
    const g = grown[best];
    g.x1 = Math.min(g.x1, bx.r.x1 - 12);
    g.y1 = Math.min(g.y1, bx.r.y1 - 12);
    g.x2 = Math.max(g.x2, bx.r.x2 + 12);
    g.y2 = Math.max(g.y2, bx.r.y2 + 12);
  }
  const snapDown = (v) => Math.floor(v / 10) * 10;
  const snapUp = (v) => Math.ceil(v / 10) * 10;
  blocks.forEach((b, i) => {
    const g = { x1: snapDown(grown[i].x1), y1: snapDown(grown[i].y1), x2: snapUp(grown[i].x2), y2: snapUp(grown[i].y2) };
    const o = original[i];
    blocks.forEach((n, j) => {
      if (i === j || (n.sheet || 1) !== (b.sheet || 1)) return;
      // clamp against the OTHER block's CURRENT rect (it may already have grown
      // towards this gap): the clamp may only pull a grown side back, never
      // push it further out — both blocks growing into the same gap used to
      // cross by 10 units (lint L005)
      const r = grown[j];
      const og = original[j];
      const vOverlap = g.y1 < r.y2 + 20 && r.y1 - 20 < g.y2;
      const hOverlap = g.x1 < r.x2 + 20 && r.x1 - 20 < g.x2;
      if (vOverlap && og.x1 >= o.x2 && g.x2 > r.x1 - 20) g.x2 = Math.max(o.x2, Math.min(g.x2, snapDown(r.x1 - 20)));
      if (vOverlap && og.x2 <= o.x1 && g.x1 < r.x2 + 20) g.x1 = Math.min(o.x1, Math.max(g.x1, snapUp(r.x2 + 20)));
      if (hOverlap && og.y1 >= o.y2 && g.y2 > r.y1 - 20) g.y2 = Math.max(o.y2, Math.min(g.y2, snapDown(r.y1 - 20)));
      if (hOverlap && og.y2 <= o.y1 && g.y1 < r.y2 + 20) g.y1 = Math.min(o.y1, Math.max(g.y1, snapUp(r.y2 + 20)));
    });
    b.rect = g;
  });
}

function centerSheetsInPage(placements, blocks, routed, sheetFrames) {
  for (const [s, frame] of sheetFrames) {
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    const see = (r) => {
      x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
      x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
    };
    for (const b of blocks) if ((b.sheet || 1) === s) see(b.rect);
    for (const p of placements) if ((p.sheet || 1) === s) see(p.extent);
    if (!Number.isFinite(x1)) continue;
    // keep the whole sheet on the 10-mil grid (L008): round the centering
    // offset itself, not the moved records
    const snap = (v) => Math.round(v / 10) * 10;
    const dx = snap((frame.width - (x2 - x1)) / 2 - x1);
    const dy = snap((frame.height - (y2 - y1)) / 2 - y1);
    if (!dx && !dy) continue;
    for (const p of placements) {
      if ((p.sheet || 1) !== s) continue;
      p.x += dx; p.extent.x1 += dx; p.extent.x2 += dx;
      p.y += dy; p.extent.y1 += dy; p.extent.y2 += dy;
    }
    for (const b of blocks) {
      if ((b.sheet || 1) !== s) continue;
      b.rect.x1 += dx; b.rect.x2 += dx;
      b.rect.y1 += dy; b.rect.y2 += dy;
    }
    for (const w of routed.wires) {
      if ((w.sheet || 1) !== s) continue;
      for (const seg of w.segs) { seg.x1 += dx; seg.x2 += dx; seg.y1 += dy; seg.y2 += dy; }
    }
    for (const f of routed.flags) if ((f.sheet || 1) === s) { f.x += dx; f.y += dy; }
    for (const p of routed.ports) if ((p.sheet || 1) === s) { p.x += dx; p.y += dy; }
  }
}

function makeLibrary(project, design) {  const symbolCache = new Map();
  const footprintCache = new Map();
  const ctx = { ownerUuid: project.index.owner_uuid, client: project.client, ms: project.ms() };

  function symbolOf(part) {
    // system-library part resolved through the CLI: geometry drives the
    // layout; the client places the official symbol itself (no doc download)
    if (part.libraryEntry) {
      const e = part.libraryEntry;
      const key = `lib:${e.name}`;
      if (!symbolCache.has(key)) {
        const sym = e.symbol || {};
        const b = sym.bodyBBox || sym.fullBBox || null;
        const pins = (sym.pins || []).map((pin) => {
          const num = String(pin.pinNumber !== undefined ? pin.pinNumber : pin.num);
          const x = Number(pin.x) || 0;
          const y = Number(pin.y) || 0;
          return {
            num,
            name: pin.pinName || pin.name || num,
            x, y,
            length: Number(pin.length) || 10,
            rotation: Number(pin.rotation) || 0,
            type: pin.direction || null,
            tip: { x, y }
          };
        });
        symbolCache.set(key, {
          name: e.name,
          title: e.symbolName || e.name,
          designator: e.designator || 'U?',
          bbox: b ? { x1: b.minX, y1: b.minY, x2: b.maxX, y2: b.maxY } : { x1: -50, y1: -50, x2: 50, y2: 50 },
          pins,
          pinByNum: new Map(pins.map((p) => [p.num, p])),
          library: true,
          libraryUuid: e.libraryUuid,
          deviceUuid: e.uuid,
          entry: { name: e.name, designator: e.designator, libraryUuid: e.libraryUuid, deviceUuid: e.uuid, title: e.symbolName || e.name }
        });
      }
      return Object.assign({}, symbolCache.get(key));
    }
    if (typeof part.symbol === 'string') {
      const entry = project.loadLibrary(part.symbol);
      if (!entry) die(`part "${part.id}": symbol entry "${part.symbol}" not found (see scripts/load-library.js list)`);
      if (entry.kind === 'footprint') die(`part "${part.id}": "${part.symbol}" is a footprint, not a symbol`);
      if (!symbolCache.has(entry.name)) symbolCache.set(entry.name, P.parseSymbolEntry(entry));
      return Object.assign({ entry }, symbolCache.get(entry.name));
    }
    // Multi-part component: all units share ONE symbol doc (N PARTs) and ONE
    // device; a unit's `symbol.partIndex` selects which PART it displays.
    if (part.symbol && part.symbol.multipart) {
      const base = part.symbol.multipart;
      const m = design.multiUnits[base];
      if (!m) die(`part "${part.id}": multi-unit base "${base}" not found`);
      const cacheKey = `multipart:${base}`;
      if (!symbolCache.has(cacheKey)) {
        const raw = m.symbol.name;
        const spec = Object.assign({}, m.symbol, { name: `SYM_${raw}`, title: raw });
        const entry = P.buildMultiPartSymbolEntry(spec, ctx);
        project.saveLibrary(entry);
        symbolCache.set(cacheKey, { entry, parsed: P.parseSymbolEntry(entry), partIds: entry.multipart || [] });
      }
      const cached = symbolCache.get(cacheKey);
      const partId = cached.partIds[part.symbol.partIndex];
      const myPins = (cached.parsed.pinsByPart.get(partId)) || [];
      const tips = myPins.map((p) => p.tip).concat(myPins.map((p) => ({ x: p.x, y: p.y })));
      return {
        entry: cached.entry,
        name: cached.parsed.name,
        title: cached.parsed.title,
        designator: cached.parsed.designator,
        bbox: G.bboxOfPoints(tips) || cached.parsed.bbox,
        pins: myPins,
        pinByNum: new Map(myPins.map((p) => [String(p.num), p])),
        graphics: cached.parsed.graphics,
        kind: 'symbol',
        partId,
        parts: cached.parsed.parts
      };
    }
    const key = `inline:${JSON.stringify(part.symbol)}`;
    if (!symbolCache.has(key)) {
      // Inline entries are keyed `SYM_*` / `FP_*`: a symbol and a footprint that
      // share a display name (very common: "HDR_2P") must not collide in the
      // staging directory, where lookup scans both subfolders by file name.
      const raw = part.symbol.name || part.id;
      const spec = Object.assign({}, part.symbol, { name: `SYM_${raw}`, title: raw });
      const entry = P.buildInlineSymbolEntry(spec, ctx);
      project.saveLibrary(entry);
      symbolCache.set(key, Object.assign(P.parseSymbolEntry(entry), { entry }));
    }
    return symbolCache.get(key);
  }

  function footprintOf(part) {
    // system-library part: pads/bbox come from the client's footprint geometry;
    // the client creates the footprint instance itself during the post-pass
    if (part.libraryEntry) {
      const e = part.libraryEntry;
      const key = `lib:${e.name}`;
      if (!footprintCache.has(key)) {
        const fp = e.footprint || {};
        const pads = (fp.pads || []).map((p) => ({
          num: String(p.padNumber !== undefined ? p.padNumber : p.num),
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          w: Number(p.width) || 20,
          h: Number(p.height) || 20
        }));
        const b = fp.fullBBox || fp.bodyBBox || null;
        footprintCache.set(key, {
          name: fp.name || e.footprintName || e.name,
          pads,
          bbox: b ? { x1: b.minX, y1: b.minY, x2: b.maxX, y2: b.maxY } : null,
          library: true,
          libraryUuid: e.libraryUuid,
          deviceUuid: e.uuid,
          entry: { name: fp.name || e.footprintName || e.name, libraryUuid: e.libraryUuid, deviceUuid: e.uuid }
        });
      }
      return Object.assign({}, footprintCache.get(key));
    }
    if (!part.footprint) return null;
    if (typeof part.footprint === 'string') {
      const entry = project.loadLibrary(part.footprint);
      if (!entry) die(`part "${part.id}": footprint entry "${part.footprint}" not found`);
      if (entry.kind !== 'footprint') die(`part "${part.id}": "${part.footprint}" is not a footprint entry`);
      if (!footprintCache.has(entry.name)) footprintCache.set(entry.name, P.parseFootprintEntry(entry));
      return Object.assign({ entry }, footprintCache.get(entry.name));
    }
    const key = `inline:${JSON.stringify(part.footprint)}`;
    if (!footprintCache.has(key)) {
      // {auto:"SOP8"} etc. expands into a full pad layout before synthesis.
      const expanded = FA.expandAuto(part.footprint);
      const raw = expanded.name || part.id;
      const spec = Object.assign({}, expanded, { name: `FP_${raw}`, title: raw });
      const entry = P.buildInlineFootprintEntry(spec, ctx);
      project.saveLibrary(entry);
      footprintCache.set(key, Object.assign(P.parseFootprintEntry(entry), { entry }));
    }
    return footprintCache.get(key);
  }

  return { symbolOf, footprintOf, symbolCache, footprintCache };
}

function placeSchematicComponent(em, project, pl, lib, design) {
  const sym = pl.sym;
  const entry = sym.entry;

  // Power flags / net ports / special entries are self-contained documents whose
  // net is baked in — they are placed by their own block builder, not as a
  // regular symbol+device pair.
  if (entry.kind && entry.kind !== 'symbol' && entry.kind !== 'footprint') {
    const isPort = entry.kind === 'port';
    const docA = isPort ? entry.portSymbolDoc : entry.powerSymbolDoc;
    const docB = isPort ? entry.portDeviceDoc : entry.powerDeviceDoc;
    em.embed([E.rewriteDocHeads(docA, project.client), E.rewriteDocHeads(docB, project.client)]);
    const common = {
      compId: E.randId(),
      x: pl.x, y: pl.y,
      zIndex: em.nextZ(),
      symbolUuid: entry.symbolUuid,
      deviceUuid: entry.deviceUuid,
      ticketBase: em.nextTicket() - 1
    };
    const block = isPort
      ? E.portComponentBlock(Object.assign({ net: entry.net }, common))
      : E.powerComponentBlock(Object.assign({ net: entry.net, style: entry.style }, common));
    em.addLines(block.lines);
    em.t = block.nextTicket + 1;
    return;
  }

  const deviceTitle = pl.part.name || entry.title || entry.name;
  // Resolve the footprint through the SAME cache the validation used — an
  // inline entry's staged name is `FP_*`, not the display name in the design.
  let fpEntry = null;
  if (pl.part.footprint) {
    const fp = lib.footprintOf(pl.part);
    fpEntry = fp ? fp.entry : null;
  }
  const deviceUuid = (pl.part.multiUnitBase && design && design.multiUnits[pl.part.multiUnitBase])
    ? (() => { const m = design.multiUnits[pl.part.multiUnitBase]; if (!m.deviceUuid) m.deviceUuid = E.uuid16(); return m.deviceUuid; })()
    : E.uuid16();
  const deviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: deviceTitle,
    designator: entry.designator || 'U?',
    symbolUuid: entry.symbolUuid,
    // the client shows these names: keep the original library names, never the
    // SYM_/FP_ staging keys
    symbolName: entry.title || entry.name,
    footprintUuid: fpEntry ? fpEntry.footprintUuid : undefined,
    footprintName: fpEntry ? (fpEntry.title || fpEntry.name) : undefined,
    tags: [],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    client: project.client,
    ms: project.ms()
  });
  if (fpEntry) em.embed([E.rewriteDocHeads(fpEntry.footprintDoc, project.client)]);
  em.embed([
    E.rewriteDocHeads(entry.symbolDoc, project.client),
    E.rewriteDocHeads(deviceDoc, project.client)
  ]);

  const placement = entry.placement || { nameZ: 10, designatorZ: 11, symbolZ: 12 };
  const block = E.schComponentBlock({
    compId: E.randId(),
    partId: sym.partId,
    x: pl.x, y: pl.y, rotation: pl.rotation || 0,
    extent: pl.extent,
    zIndex: em.nextZ(),
    symbolUuid: entry.symbolUuid,
    deviceUuid,
    deviceName: deviceTitle,
    footprintUuid: fpEntry ? fpEntry.footprintUuid : null,
    // a multi-part unit stores the BASE designator (U34); the client appends
    // the unit suffix itself (U34.1 …), exactly like the reference project
    refdes: pl.part.multiUnitBase || pl.part.id,
    uniqueId: E.nextUniqueId(em.lines),
    nameZ: placement.nameZ,
    designatorZ: placement.designatorZ,
    symbolZ: placement.symbolZ,
    ticketBase: em.nextTicket() - 1
  });
  em.addLines(block.lines);
  em.t = block.nextTicket + 1;
}

function placePowerFlag(em, project, flag, entry) {
  em.embed([
    E.rewriteDocHeads(entry.powerSymbolDoc, project.client),
    E.rewriteDocHeads(entry.powerDeviceDoc, project.client)
  ]);
  const block = E.powerComponentBlock({
    compId: E.randId(),
    x: flag.x, y: flag.y,
    zIndex: em.nextZ(),
    symbolUuid: entry.symbolUuid,
    deviceUuid: entry.deviceUuid,
    net: flag.net,
    style: flag.style,
    ticketBase: em.nextTicket() - 1
  });
  em.addLines(block.lines);
  em.t = block.nextTicket + 1;
}

// net port for cross-sheet nets — same placement model as power flags: the
// component's pin sits at its origin, the wire from the part's hotspot lands
// exactly there, and the net name lives in the component's ATTR records
function placeNetPort(em, project, port, entry) {
  em.embed([
    E.rewriteDocHeads(entry.portSymbolDoc, project.client),
    E.rewriteDocHeads(entry.portDeviceDoc, project.client)
  ]);
  const block = E.portComponentBlock({
    compId: E.randId(),
    x: port.x, y: port.y,
    dir: port.dir,
    portKind: entry.portKind || 'BI',
    zIndex: em.nextZ(),
    symbolUuid: entry.symbolUuid,
    deviceUuid: entry.deviceUuid,
    net: port.net,
    ticketBase: em.nextTicket() - 1
  });
  em.addLines(block.lines);
  em.t = block.nextTicket + 1;
}

function placePcbComponent(em, project, design, pl, lib) {
  const part = pl.part;
  const sym = lib.symbolOf(part);
  const fp = lib.footprintOf(part);
  if (!fp) return null;
  const fpEntry = fp.entry;
  const deviceUuid = E.uuid16();
  const deviceTitle = part.name || fpEntry.title || fpEntry.name;
  const deviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: deviceTitle,
    designator: sym.designator || 'U?',
    symbolUuid: sym.entry.symbolUuid,
    symbolName: sym.entry.title || sym.name,
    footprintUuid: fpEntry.footprintUuid,
    footprintName: fpEntry.title || fpEntry.name,
    tags: [],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    client: project.client,
    ms: project.ms()
  });
  em.embed([
    E.rewriteDocHeads(sym.entry.symbolDoc || sym.entry.portSymbolDoc || sym.entry.powerSymbolDoc, project.client),
    E.rewriteDocHeads(fpEntry.footprintDoc, project.client),
    E.rewriteDocHeads(deviceDoc, project.client)
  ]);

  const [px, py, angle] = pl.pcbPos;
  const netsByNum = {};
  for (const [num, net] of Object.entries(part.pins)) netsByNum[num] = net;
  const placed = P.placedPads(fp, px, py, angle || 0);
  const pads = fp.pads.map((p) => ({
    num: p.num,
    elemId: p.elemId,
    net: netsByNum[p.num] || ''
  }));
  const block = E.pcbComponentBlock({
    compId: E.randId(),
    x: px, y: py, angle: angle || 0,
    deviceUuid,
    deviceName: deviceTitle,
    footprintUuid: fpEntry.footprintUuid,
    refdes: part.id,
    uniqueId: E.nextUniqueId(em.lines),
    pads,
    attrFootprint: fpEntry.footprintElems && fpEntry.footprintElems.attrFootprint,
    attrDesignator: fpEntry.footprintElems && fpEntry.footprintElems.attrDesignator,
    zIndexFootprint: (fpEntry.attrZ && fpEntry.attrZ.footprint) || 15,
    zIndexDesignator: (fpEntry.attrZ && fpEntry.attrZ.designator) || 16,
    ticketBase: em.nextTicket() - 1
  });
  em.addLines(block.lines);
  em.t = block.nextTicket + 1;
  void design;
  return {
    blockPads: pads,
    geoPads: placed.map((p) => ({ ref: part.id, num: p.num, net: netsByNum[p.num] || '', x: p.x, y: p.y, w: p.w, h: p.h })),
    x: px, y: py, angle: angle || 0
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('build.js [options]', SCHEMA,
      'Build a complete .eprj3 project from a design.json (schematic + PCB PLACEMENT; routing/pour are done in the client, not here).');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const requestedDir = path.resolve(opts.dir);
  // --dry-run and --plan both build into a throwaway sibling and delete it on
  // exit: a rehearsal costs nothing and never touches the real project dir.
  // --plan is the human confirmation gate — it shows the *real* stats (because
  // it really built them) while writing nothing.
  const rehearsal = !!(opts['dry-run'] || opts.plan);
  const dir = rehearsal ? requestedDir + `.${opts.plan ? 'plan' : 'dryrun'}` + process.pid : requestedDir;
  if (rehearsal) {
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  // Design source: a plain design.json (--design) or a generator module
  // (--gen board.gen.js exporting (A) => design, see lib/authoring.js) — big
  // boards are authored as a short generator, never as thousands of JSON lines
  // and never as an agent-invented temp script.
  let designSource = opts.design ? path.resolve(opts.design) : path.resolve(opts.gen);
  let design;
  if (opts.gen) {
    const A = require('./lib/authoring').createAuthoring();
    const gen = require(designSource);
    if (typeof gen !== 'function') die(`--gen file must export a function: module.exports = (A) => { ...; return A.design(); }`);
    const out = gen(A);
    design = D.normalize(out, designSource);
  } else {
    design = D.readDesign(designSource);
  }
  const declaredW = design.board.width;   // declared size, for the --plan blow-up check
  const declaredH = design.board.height;
  const t0 = Date.now();                  // report.elapsed_ms
  const doPcb = !opts['schematic-only'] && !design.skipPcb;

  // ---- system-library devices, resolved through the client CLI (2.x) -------
  // No local cache and no document download: the client returns the device
  // geometry (layout) and later places the official symbol/footprint instances
  // itself. See lib/cli-lib.js.
  const libRefs = design.parts.filter((p) => p.libraryRef);
  if (libRefs.length) {
    const CLI_LIB = require('./lib/cli-lib');
    const uniq = new Map();
    for (const p of libRefs) if (!uniq.has(p.libraryRef.name)) uniq.set(p.libraryRef.name, p.libraryRef);
    let resolved;
    try {
      resolved = CLI_LIB.resolveDevices([...uniq.values()].map((r) => ({ key: r.name, name: r.name, lcsc: r.lcsc || undefined })));
    } catch (e) {
      die(`resolving system-library device(s) needs the LCEDA/EasyEDA Pro CLI (V4.1.94+): ${e.message}`);
    }
    const byKey = new Map((resolved || []).map((e) => [e.key, e]));
    for (const p of libRefs) {
      const e = byKey.get(p.libraryRef.name);
      if (!e || e.error || !e.symbol) {
        die(`part "${p.id}": device "${p.libraryRef.name}" was not found in the client's system library`
          + `${e && e.error ? ` (${e.error})` : ''} — check the name or add "lcsc": "C<id>"`);
      }
      p.libraryEntry = e;
      p.ic = e.name;
      if (p.autoNC) {
        for (const pin of e.symbol.pins || []) {
          const num = String(pin.pinNumber !== undefined ? pin.pinNumber : pin.num);
          if (p.pins[num] === undefined) p.pins[num] = 'NC';
        }
      }
    }
  }
  // Strategy: the skill NEVER lays copper — no auto routing, no pours, no flags
  // to turn them on. The deliverable is footprints placed with pad-net links
  // bound and the board outline; copper is finished in the EasyEDA client by a
  // human. The build reports `rats` (nets awaiting copper) so the handoff is
  // explicit; the DRC is told the board is placement-only (D004/D006 never
  // fire here, but stay live for imported client-authored boards).
  const log = (msg) => { if (!opts.quiet) console.log(msg); };

  // ------------------------------------------------------------ bootstrap
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (!opts.force) {
      die(`${dir} is not empty — pass --force to rebuild it (only skill-owned files are removed)`);
    }
    safeClean(dir);
  }
  const project = E.Project.create(dir, design.name);
  project.ensureBoard();
  // sheet documents are created AFTER the schematic layout (see below) so the
  // drawing frame can be sized around what the packing actually produced
  const pcbDoc = project.ensurePcbDocument(design.pcb, {
    outline: E.rectPath(0, 0, design.board.width, design.board.height)
  });
  log(`created ${design.name} at ${dir} (board ${design.board.width}×${design.board.height} mil)`
    + (design.sheets > 1 ? `, ${design.sheets} schematic sheets` : ''));

  // ------------------------------------------------------------ library
  const lib = makeLibrary(project, design);
  const check = D.validateDesign(design, lib);
  if (check.errors.length) {
    console.error('design errors:');
    for (const e of check.errors) console.error(`  ✗ ${e}`);
    process.exit(2);
  }
  // Library fidelity: a real multi-pin device drawn from an inline pin list is
  // NOT the official symbol (shape, pin order and names differ from the
  // library). Name every such part so the author pins the system-library
  // device instead (`"ic": "<name>"`, placed by the client).
  const inlineIcs = design.parts.filter((p) => p.symbol && typeof p.symbol === 'object'
    && !p.symbol.raw && !p.symbol.multipart && !p.ic
    && Array.isArray(p.symbol.pins) && p.symbol.pins.length > 4);
  if (inlineIcs.length) {
    log(`library: ${inlineIcs.length} multi-pin part(s) use a self-drawn inline symbol, not the official library`
      + ` — reference the system-library device with "ic": ${inlineIcs.slice(0, 10).map((p) => p.id).join(' ')}`
      + `${inlineIcs.length > 10 ? ' …' : ''}`);
  }

  // ------------------------------------------------- plan gate (--plan)
  // What a human must be able to veto before anything is written: the power
  // chain, the net names, the rule set and the intent declarations. Printed
  // from the *validated* design, so it cannot disagree with the build.
  if (opts.plan) {
    const rules = design.pcbSpec.rules || {};
    const nets = [...new Set(design.parts.flatMap((p) => Object.values(p.pins || {})))].sort();
    console.log(`方案 ${design.name} → ${requestedDir}`);
    console.log(`  板框  ${design.boardDeclared ? `${design.board.width}×${design.board.height} mil` : '自动适配（按器件收敛）'} · `
      + `${doPcb ? '只布局（本 skill 不做布线/铺铜，铜皮在客户端完成）' : '仅原理图 (--schematic-only)'}`);
    console.log(`  电源  ${Object.entries(design.powers).map(([n, s]) => `${n}${s === 'up' ? '↑' : '↓'}`).join(' ')}`);
    const widths = Object.entries(design.netWidths || {});
    if (widths.length) console.log(`  线宽  ${widths.map(([n, w]) => `${n}=${w}mil`).join(' ')}`);
    if (Object.keys(rules).length) console.log(`  规则  ${Object.entries(rules).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    // same net counting as the build report: signal nets and NC separately,
    // so the plan and the final report always agree (report P7)
    const signalNets = nets.filter((n) => !/^(NC|DNC\d*)$/i.test(n));
    console.log(`  规模  ${design.parts.length} parts · ${signalNets.length} 信号网络${nets.length > signalNets.length ? ` + ${nets.length - signalNets.length} NC` : ''} · ${(design.blocks || []).length} blocks · ${design.sheets} 原理图页`);
    console.log(`  模块  ${(design.blocks || []).map((b) => `${b.title}${b.desc ? `（${b.desc}）` : ''}@P${b.sheet}`).join(' | ') || '(未分块)'}`);
    console.log(`  网络  ${nets.slice(0, 18).join(' ')}${nets.length > 18 ? ' …' : ''}`);
    if (design.expect) {
      const keys = Object.entries(design.expect).filter(([, v]) => v !== undefined && (!Array.isArray(v) || v.length));
      console.log(`  意图  ${keys.map(([k, v]) => `${k}${v === true ? '' : `(${Array.isArray(v) ? v.length : v})`}`).join(' ')}`);
    }
    if (check.warnings && check.warnings.length) {
      for (const w of check.warnings) console.log(`  · ${w}`);
    }
  }

  // ------------------------------------------------------------ schematic
  // PLACEMENT CANDIDATES (idea absorbed from the reference implementation,
  // report §4/§7): two layout strategies — the declaration-order shelf and a
  // signal-flow LAYERED layout — are each laid out, tidied, routed and scored
  // with one quality model; the best wins under a safe gate, so a new strategy
  // can never make a sheet worse than the baseline.
  //
  // Robustness: at tight densities two nets' stubs can meet (the client merges
  // them), so every candidate is verified for cross-net contacts and retried on
  // a looser grid before it may be selected.
  const T = require('./lib/sch-tidy');
  const Q = require('./lib/quality');
  const SP = require('./lib/sch-place');
  const baseRotations = new Map(design.parts.map((p) => [p.id, {
    r: p.rotation, e: p.rotationExplicit, t: p.rotationTidied
  }]));
  const restoreRotations = () => {
    for (const p of design.parts) {
      const b = baseRotations.get(p.id);
      p.rotation = b.r;
      p.rotationExplicit = b.e;
      p.rotationTidied = b.t;
    }
  };
  const layoutFor = (kind, passDesign) => (kind === 'layered'
    ? SP.layoutLayered(passDesign, lib)
    : D.layoutSchematic(passDesign, lib));

  const bodyOf = (pl) => {
    const bb = pl.sym && pl.sym.bbox;
    if (!bb) return pl.extent;
    const pts = [[bb.x1, bb.y1], [bb.x2, bb.y1], [bb.x2, bb.y2], [bb.x1, bb.y2]].map(([x, y]) => {
      const r = G.rotate(x, y, pl.rotation || 0);
      return { x: pl.x + r.x, y: pl.y + r.y };
    });
    return G.bboxOfPoints(pts);
  };

  /** Route + score one placement state (positions must already be shifted). */
  const assess = (placements, blocks, patternNets) => {
    const routed = R.routeSchematic(design, placements, { patternPortNets: patternNets });
    const contacts = R.countCrossNetContacts(routed);
    const quality = Q.evaluate({
      parts: placements.map((p) => ({ extent: p.extent, body: bodyOf(p), sheet: p.sheet || 1 })),
      wires: routed.wires,
      blocks
    });
    return { routed, contacts, quality };
  };

  /** Two block frames on one sheet must never overlap. */
  const framesOverlap = (blocks) => {
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        if ((blocks[i].sheet || 1) !== (blocks[j].sheet || 1)) continue;
        if (G.rectsOverlap(blocks[i].rect, blocks[j].rect)) return true;
      }
    }
    return false;
  };

  /**
   * Group-level local search (idea from the reference engine's local-search
   * pass, re-derived): move one block at a time on the 10-mil grid, re-route,
   * and keep a move only when the sheet stays contact-free, block frames stay
   * apart, and the SAME safe gate as candidate selection accepts it. Bounded
   * by design size: a large sheet skips the per-trial routing.
   */
  const refineLayout = (state) => {
    if (state.placements.length > 48 || state.blocks.length > 8) return state;
    let cur = state;
    let moved = 0;
    const from = state.quality.score;
    const deltas = [[20, 0], [-20, 0], [0, 20], [0, -20], [40, 0], [-40, 0], [0, 40], [0, -40]];
    for (let round = 0; round < 2; round += 1) {
      let improved = false;
      for (let bi = 0; bi < cur.blocks.length; bi += 1) {
        const block = cur.blocks[bi];
        const ids = new Set(block.members || []);
        const sheet = block.sheet || 1;
        for (const [dx, dy] of deltas) {
          const placements = cur.placements.map((pl) => Object.assign({}, pl, {
            extent: Object.assign({}, pl.extent)
          }));
          const blocks = cur.blocks.map((b) => Object.assign({}, b, { rect: Object.assign({}, b.rect) }));
          for (const pl of placements) {
            if (!ids.has(pl.part.id) || (pl.sheet || 1) !== sheet) continue;
            pl.x += dx;
            pl.extent.x1 += dx; pl.extent.x2 += dx;
            pl.y += dy;
            pl.extent.y1 += dy; pl.extent.y2 += dy;
          }
          blocks[bi].rect.x1 += dx; blocks[bi].rect.x2 += dx;
          blocks[bi].rect.y1 += dy; blocks[bi].rect.y2 += dy;
          shiftSheetsIntoPage(placements, blocks);
          if (framesOverlap(blocks)) continue;
          const trial = assess(placements, blocks, cur.patternNets);
          if (trial.contacts !== 0 || !Q.safelyImproves(trial.quality, cur.quality)) continue;
          if (trial.quality.score >= cur.quality.score) continue;
          cur = Object.assign({}, cur, trial, { placements, blocks });
          moved += 1;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    if (!moved) return state;
    return Object.assign({}, cur, { search: { moves: moved, from, to: cur.quality.score } });
  };

  function makeCandidate(kind, scale, rotatedNote, patternOpts) {
    const passDesign = scale === 1 ? design : Object.assign({}, design, {
      layout: {
        cols: design.layout.cols,
        cellW: Math.round(design.layout.cellW * scale),
        cellH: Math.round(design.layout.cellH * scale),
        blockGapX: Math.round(design.layout.blockGapX * scale),
        blockGapY: Math.round(design.layout.blockGapY * scale),
        margin: design.layout.margin
      }
    });
    let { placements, blocks } = layoutFor(kind, passDesign);
    if (!opts['no-tidy']) {
      const tidy = T.tidyRotations(design, lib, placements);
      if (tidy.rotated.length) {
        ({ placements, blocks } = layoutFor(kind, passDesign));
        if (rotatedNote && tidy.rotated.length) {
          log(`sch-tidy: rotated ${tidy.rotated.length} part(s) onto their signal axes (${tidy.rotated.slice(0, 8).join(' ')}${tidy.rotated.length > 8 ? ' …' : ''})`);
        }
      }
      // the re-layout may have moved a part away from the position its
      // rotation was scored for; re-check 2-pin parts on the FINAL spot
      const aligned = T.alignRotations(placements, blocks);
      if (rotatedNote && aligned.length) {
        log(`sch-tidy: re-aligned ${aligned.length} part(s) after placement (${aligned.slice(0, 8).join(' ')}${aligned.length > 8 ? ' …' : ''})`);
      }
    }
    // Circuit pattern macros: a block that is a pure two-pin chain (LED +
    // resistor, RC, divider) is re-laid as a vertical chain with the supply up
    // and ground down; frame clashes are resolved by pushing blocks apart.
    const pat = opts['no-patterns']
      ? { changed: 0, subBanks: 0, portNets: new Set() }
      : PAT.applyPatterns(design, placements, blocks, patternOpts);
    // Sheet coordinates are y-UP: place each sheet's content a margin above
    // the page origin so no block frame or label hangs below the border.
    shiftSheetsIntoPage(placements, blocks);
    const { routed, contacts, quality } = assess(placements, blocks, pat.portNets);
    // a pin the router could not even leave ("no clean exit") is electrically
    // unconnected — same retry tier as a cross-net contact, because a looser
    // grid is the fix (dense ICs need room around their pin columns)
    const noExit = routed.issues.filter((s) => /no clean exit/.test(s)).length;
    return {
      kind, scale, placements, blocks, routed, contacts, noExit, quality,
      patternNets: pat.portNets, subBanks: pat.subBanks || 0
    };
  }

  const candidates = [];
  const kinds = process.env.EPRJ3_NO_LAYERED === '1' ? ['shelf'] : ['shelf', 'layered'];
  for (const kind of kinds) {
    for (const scale of [1, 1.7, 2.9, 5, 8]) {
      restoreRotations();
      let c = makeCandidate(kind, scale, candidates.length === 0);
      if (c.contacts > 0 && c.subBanks > 0 && !opts['no-patterns']) {
        // A mixed-block row can crowd a dense block until the router has no
        // clean path left. Retry THIS density with the generic placement
        // before loosening the whole sheet: the row is an optimisation, never
        // a reason to fail a design that used to build.
        restoreRotations();
        const flat = makeCandidate(kind, scale, false, { noSubBanks: true });
        if (flat.contacts < c.contacts) c = flat;
      }
      candidates.push(c);
      if (c.contacts === 0 && c.noExit === 0) break;
      log(`layout(${kind}): ${c.contacts} cross-net contact(s), ${c.noExit} pin(s) with no clean exit`
        + ` at this density — retrying on a ${Math.round(scale * 1.7 * 100)}% looser grid`);
    }
  }
  restoreRotations();
  const usable = candidates.filter((c) => c.contacts === 0 && c.noExit === 0 && c.quality.valid);
  if (!usable.length) {
    const worst = candidates.reduce((a, b) => ((a.contacts + a.noExit) <= (b.contacts + b.noExit) ? a : b));
    const q = worst.quality || {};
    die(`schematic layout failed: ${worst.contacts} cross-net contact(s), ${worst.noExit} pin(s) with no clean exit`
      + `, ${q.parts ? q.parts.overlaps : '?'} overlapping part pair(s), ${q.wires ? q.wires.through : '?'} wire(s) through a body`
      + ' — at every density. Two nets would be merged or a symbol would be corrupted in the client. '
      + 'Split the dense block (blocks[].parts) or set "layout": { "cellW", "cellH" } explicitly.');
  }
  const baseline = usable.find((c) => c.kind === 'shelf') || usable[0];
  let best = baseline;
  for (const c of usable) {
    if (Q.safelyImproves(c.quality, baseline.quality) && c.quality.score < best.quality.score) best = c;
  }
  if (usable.length > 1) {
    log(`layout: ${best.kind}${best.scale > 1 ? ` ×${best.scale}` : ''} chosen — score ${best.quality.score.toFixed(2)}`
      + ` (shelf baseline ${baseline.quality.score.toFixed(2)}; ${usable.length} candidate(s), `
      + `${best.quality.wires.bends} bends, ${best.quality.wires.crossings} crossings)`);
  }
  if (!opts['no-search']) {
    const refined = refineLayout(best);
    if (refined !== best) {
      log(`layout: local search accepted ${refined.search.moves} move(s) — score `
        + `${refined.search.from.toFixed(2)} → ${refined.search.to.toFixed(2)}`);
      best = refined;
    }
  }
  const placements = best.placements;
  const patternNets = best.patternNets || new Set();
  const blocks = best.blocks;
  const routed = best.routed;
  snapNetObjectsToGrid(routed);
  growFramesToLabels(blocks, routed);
  const sheetFrames = new Map();
  // per-sheet frame: sized around what the packing produced, 明细表 off by
  // default (design.frame.titleBlock opts back in)
  const sheetDocs = new Map();
  const usedSheetTitles = new Set();
  const sheetTitleBySheet = new Map();
  for (let s = 1; s <= design.sheets; s += 1) {
    const sheetBlocks = blocks.filter((bl) => bl.sheet === s);
    const sheetPls = placements.filter((p) => (p.sheet || 1) === s);
    // the tab (and the file name) is the page's FUNCTION, not "P3": an explicit
    // sheetNames[s-1] wins, otherwise the first block on the page names it.
    // A SINGLE-page design keeps its classic sheet name (P1 unless the design
    // says otherwise) — there is no page list to tell apart.
    let sheetTitle = (design.sheetNames && design.sheetNames[s - 1])
      || (design.sheets <= 1 ? design.sheet : null)
      || (sheetBlocks.length ? sheetBlocks[0].title : `P${s}`);
    // a title becomes a FILE name — strip path-hostile characters and cap the
    // length; a repeated title gets the page number appended to stay unique
    sheetTitle = String(sheetTitle).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 40) || `P${s}`;
    if (usedSheetTitles.has(sheetTitle)) sheetTitle = `${sheetTitle} ${s}`;
    usedSheetTitles.add(sheetTitle);
    sheetTitleBySheet.set(s, sheetTitle);
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const bl of sheetBlocks) { x1 = Math.min(x1, bl.rect.x1); y1 = Math.min(y1, bl.rect.y1); x2 = Math.max(x2, bl.rect.x2); y2 = Math.max(y2, bl.rect.y2); }
    for (const p of sheetPls) { const e = p.extent; x1 = Math.min(x1, e.x1); y1 = Math.min(y1, e.y1); x2 = Math.max(x2, e.x2); y2 = Math.max(y2, e.y2); }
    // y-down sheet space: content occupies y1..y2 (both positive), so the
    // frame must reach past y2 (bottom) and keep a title strip at the top
    if (x1 > x2) { x1 = 0; x2 = 1000; y1 = 0; y2 = 600; }
    // The client draws the drawing frame from the Width/Height attributes, so
    // size them from the REAL content box (both ends, including negative x/y):
    // A4 when it fits, otherwise a custom frame just large enough — never snap
    // up to the next paper size and leave the circuit in a mostly empty sheet.
    const MARGIN = 60;
    const needW = Math.ceil((x2 - x1) + 2 * MARGIN);
    const needH = Math.ceil((y2 - y1) + 2 * MARGIN
      + (design.frame && design.frame.titleBlock === true ? 100 : 0));
    const stds = [['A4', 1170, 825], ['A3', 1680, 1170], ['A2', 2360, 1656], ['A1', 3350, 2360], ['A0', 4740, 3350]];
    const a4 = stds[0];
    let fit;
    if (needW <= a4[1] && needH <= a4[2]) {
      fit = a4;
    } else {
      // W/H are adjustable in the client: keep the frame at the content size
      // and use the smallest standard paper only as its size LABEL.
      const label = stds.find(([, w, h]) => needW <= w && needH <= h);
      fit = [label ? label[0] : 'A0', Math.max(needW, 200), Math.max(needH, 150)];
    }
    // The sheet is a real paper size: the client draws the page border from
    // the frame's Width/Height, so a standard size keeps the border and the
    // embedded frame component coincident (reference project: A4 = 1170×825).
    const frame = {
      width: fit[1], height: fit[2],
      size: fit[0],
      xRegions: Math.max(1, Math.round(fit[1] / 200)),
      yRegions: Math.max(1, Math.round(fit[2] / 200)),
      titleBlock: design.frame && design.frame.titleBlock === true ? 1 : 0
    };
    sheetDocs.set(s, project.ensureSheetDocument(design.schematic, sheetTitle, frame));
    sheetFrames.set(s, { ...frame, wMil: fit[1] * 10, hMil: fit[2] * 10 });
  }

  // the page is chosen to fit the content, so center the circuit in it — a
  // small design must not sit in the bottom-left corner of an A4 sheet
  centerSheetsInPage(placements, blocks, routed, sheetFrames);

  // one emitter per sheet; blocks/components/flags/ports/wires land on the
  // sheet their block was assigned to
  const emitters = new Map();
  for (let s = 1; s <= design.sheets; s += 1) emitters.set(s, new Emitter(sheetDocs.get(s).file));

  // block frames first (lowest z, so components draw on top) + the block's
  // one-line functional description under its title
  for (const b of blocks) {
    const em = emitters.get(b.sheet);
    // a rectangle frame wraps the module (human style: a thin border groups the
    // block's parts, the title sits on its top edge)
    em.addLines([E.schRectLine({
      x1: b.rect.x1, y1: b.rect.y1, x2: b.rect.x2, y2: b.rect.y2,
      zIndex: em.nextZ(), ticketBase: em.nextTicket()
    })]);
    em.addLines([E.schTextLine({
      x: b.rect.x1 + 10, y: b.rect.y2 - 20,
      value: b.title, fontSize: 14,
      zIndex: em.nextZ(), ticketBase: em.nextTicket()
    })]);
    if (b.desc) {
      em.addLines([E.schTextLine({
        x: b.rect.x1 + 10, y: b.rect.y2 - 40,
        value: b.desc, fontSize: 9,
        zIndex: em.nextZ(), ticketBase: em.nextTicket()
      })]);
    }
  }

  const librarySch = [];
  for (const pl of placements) {
    if (pl.part.libraryEntry) {
      librarySch.push({
        schematicName: design.schematic,
        pageName: sheetTitleBySheet.get(pl.sheet || 1),
        deviceName: pl.part.libraryEntry.name,
        libraryUuid: pl.part.libraryEntry.libraryUuid,
        designator: pl.part.multiUnitBase || pl.part.id,
        x: pl.x,
        y: pl.y,
        rotation: pl.rotation || 0
      });
      continue;
    }
    placeSchematicComponent(emitters.get(pl.sheet || 1), project, pl, lib, design);
  }

  const powerEntries = new Map();
  for (const flag of routed.flags) {
    if (!powerEntries.has(flag.net)) {
      const entry = require('./lib/entries').buildPowerEntry(project, flag.net, flag.style);
      project.saveLibrary(entry);
      powerEntries.set(flag.net, entry);
    }
    placePowerFlag(emitters.get(flag.sheet || 1), project, flag, powerEntries.get(flag.net));
  }

  // cross-sheet / cross-block nets: ONE generic client Netport symbol (the
  // committed preset, official geometry and name) is placed at every port; the
  // net name lives in the component attributes, so it must not be regenerated
  // per net.
  // Netport-IN / -OUT / -BI follow the pin directions on each block's side
  const portEntries = new Map();
  for (const port of routed.ports) {
    const kind = port.kind || 'BI';
    if (!portEntries.has(kind)) {
      const entry = require('./lib/entries').buildPortEntry(project, port.net, kind);
      project.saveLibrary(entry);
      portEntries.set(kind, entry);
    }
    placeNetPort(emitters.get(port.sheet || 1), project, port, portEntries.get(kind));
  }

  // A wire that lands on a power flag or a net port already carries its name
  // there; repeating it as the wire's NET text puts a second copy tight against
  // the pin, on top of the part's designator/value. The client's own saves leave
  // the NET value empty in that case (see examples/eprj3-example).
  //
  // A pin's path can be split into several WIRE records (pin → jog → flag), so
  // decide by CONNECTED WIRE PATH, not per record: a record whose segment chain
  // reaches a flag/port at the same net loses the printed name. A disjoint
  // stub+label wire keeps its NET value — same-named wires are what joins those
  // pins in the client (clearing them disconnected JP1/C156 on the H6 board).
  const hiddenWire = new Set();
  for (let s = 1; s <= design.sheets; s += 1) {
    const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
    const parent = new Map();
    const ensure = (k) => { if (!parent.has(k)) parent.set(k, k); };
    const find = (k) => {
      let r = k;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
      return r;
    };
    const union = (a, b) => {
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    routed.wires.forEach((w) => {
      if ((w.sheet || 1) !== s) return;
      for (const g of w.segs) {
        const a = key(g.x1, g.y1); const b = key(g.x2, g.y2);
        ensure(a); ensure(b); union(a, b);
      }
    });
    const terminalRoots = new Set();
    const mark = (x, y) => { const k = key(x, y); if (parent.has(k)) terminalRoots.add(find(k)); };
    for (const f of routed.flags) if ((f.sheet || 1) === s) mark(f.x, f.y);
    for (const p of routed.ports) if ((p.sheet || 1) === s) mark(p.x, p.y);
    routed.wires.forEach((w, i) => {
      if ((w.sheet || 1) !== s) return;
      if (w.segs.some((g) => terminalRoots.has(find(key(g.x1, g.y1)))
        || terminalRoots.has(find(key(g.x2, g.y2))))) hiddenWire.add(i);
    });
  }

  // Short pin-to-pin links (a chain member to its neighbour) are self-evident:
  // printing the net name there only covers the two symbols' own labels.
  const pinKeysBySheet = new Map();
  const ptKey = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  for (const pl of placements) {
    const s = pl.sheet || 1;
    if (!pinKeysBySheet.has(s)) pinKeysBySheet.set(s, new Set());
    const set = pinKeysBySheet.get(s);
    for (const pin of (pl.sym && pl.sym.pins) || []) {
      const t = G.pinTip(pin, pl.x, pl.y, pl.rotation || 0);
      set.add(ptKey(t.x, t.y));
    }
  }

  routed.wires.forEach((w, i) => {
    const em = emitters.get(w.sheet || 1);
    const pinKeys = pinKeysBySheet.get(w.sheet || 1) || new Set();
    const short = w.segs.length === 1 && G.segLen(w.segs[0]) <= 80
      && pinKeys.has(ptKey(w.segs[0].x1, w.segs[0].y1))
      && pinKeys.has(ptKey(w.segs[0].x2, w.segs[0].y2));
    // a chain's shared net reads from the chain itself; its name only clutters
    const chainNet = patternNets.has(w.net);
    // a zero-length anchor (a port/flag sitting on a bare pin) carries no
    // readable label — the port/flag symbol already prints the net name
    const anchorOnly = w.segs.every((s) => G.segLen(s) < G.EPS);
    const nameShown = !hiddenWire.has(i) && !short && !chainNet && !anchorOnly;
    const block = E.wireBlock({
      segs: w.segs.map((s) => ({ startX: s.x1, startY: s.y1, endX: s.x2, endY: s.y2 })),
      net: w.net,
      netVisible: nameShown,
      zIndex: em.nextZ(),
      ticketBase: em.nextTicket() - 1
    });
    em.addLines(block.lines);
    em.t = block.nextTicket + 1;
  });

  for (const em of emitters.values()) em.flush();
  project.save();
  log(`schematic: ${placements.length} parts in ${blocks.length} blocks across ${design.sheets} sheet(s)`
    + `, ${routed.stats.segments} wire segments, ${routed.stats.flags} power flags, ${routed.stats.ports} net ports`);

  // ------------------------------------------------------------ pcb
  const pcbParts = [];
  const pcbGeoPads = [];
  let ratNets = [];
  if (doPcb) {
    const { planPcb } = require('./lib/pcb-plan');
    // Board size settles here. A DECLARED board is honoured as a floor and
    // grown if the placer needs more. An UNDECLARED board takes the aggregate
    // footprint bbox of the natural placement, gives it 1.35× area, reshapes
    // that to a 4:3 rectangle and re-packs the parts inside it (the placer
    // wraps rows at the new width, so the board itself drives the layout).
    const MIN_W = 400;
    const MIN_H = 300;
    const snap10 = (v) => Math.round(v / 10) * 10;
    let plan = planPcb(design, lib, placements);
    if (!design.boardDeclared) {
      const naturalW = Math.max(plan.required.width, MIN_W);
      const naturalH = Math.max(plan.required.height, MIN_H);
      const area = naturalW * naturalH * 1.35;
      let H = Math.max(MIN_H, snap10(Math.sqrt((area * 3) / 4)));
      let W = Math.max(MIN_W, snap10((H * 4) / 3));
      for (let round = 0; round < 4; round += 1) {
        design.board.width = W;
        design.board.height = H;
        plan = planPcb(design, lib, placements);
        const needW = Math.max(plan.required.width, MIN_W);
        const needH = Math.max(plan.required.height, MIN_H);
        if (needW <= W && needH <= H) break;
        // grow the 4:3 rectangle (keeping the aspect) until the packing fits
        const f = Math.max(needW / W, needH / H) * 1.02;
        H = snap10(H * f);
        W = snap10((H * 4) / 3);
      }
      log(`board set to ${W}×${H} mil (4:3, 1.35× the natural ${naturalW}×${naturalH} footprint bbox)`);
    } else {
      for (let round = 0; round < 4; round += 1) {
        const targetW = Math.max(design.board.width, plan.required.width, MIN_W);
        const targetH = Math.max(design.board.height, plan.required.height, MIN_H);
        if (targetW === design.board.width && targetH === design.board.height) break;
        log(`board set to ${targetW}×${targetH} mil to fit ${design.parts.length} parts (declared size kept as a floor)`);
        design.board.width = targetW;
        design.board.height = targetH;
        plan = planPcb(design, lib, placements);
      }
    }
    {
      const targetW = design.board.width;
      const targetH = design.board.height;
      E.updateRecord(pcbDoc.file,
        (r) => r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE',
        (r) => { r.body.path = E.rectPath(0, 0, targetW, targetH); });
    }
    const placementPlan = plan.placements;
    const pcbEm = new Emitter(pcbDoc.file);
    for (const pl of placementPlan) {
      if (pl.part.libraryEntry) {
        // the client places the official footprint in the post-pass; we only
        // record the planned position and the pad nets
        const fp = lib.footprintOf(pl.part);
        const [px, py, angle] = pl.pcbPos;
        const nets = {};
        for (const [num, net] of Object.entries(pl.part.pins || {})) nets[String(num)] = net;
        const designator = pl.part.multiUnitBase || pl.part.id;
        const geo = fp ? P.placedPads(fp, px, py, angle || 0) : [];
        for (const g of geo) pcbGeoPads.push({ ref: designator, num: g.num, net: nets[g.num] || "", x: g.x, y: g.y, w: g.w, h: g.h });
        pcbParts.push({ part: pl.part, x: px, y: py, angle: angle || 0, library: true });
        continue;
      }
      const placed = placePcbComponent(pcbEm, project, design, pl, lib);
      if (placed) {
        pcbParts.push(Object.assign({ part: pl.part }, placed));
        pcbGeoPads.push(...placed.geoPads);
      }
    }

    const pcbCfg = design.pcbSpec || {};
    void pcbCfg; // kept for shape compatibility; copper keys are ignored by design

    // Strategy: the skill NEVER lays copper. No router, no pour planner — the
    // deliverable is a placed board and a rats list the human finishes in the
    // client. (--route/--pour no longer exist, so a copper-hungry design file
    // cannot accidentally opt in.)
    const rats = new Map();
    for (const p of pcbGeoPads) {
      if (!p.net || /^NC\d*$/i.test(p.net) || /^DNC\d*$/i.test(p.net)) continue;
      rats.set(p.net, (rats.get(p.net) || 0) + 1);
    }
    ratNets = [...rats.entries()].filter(([, n]) => n >= 2);

    const nets = new Set();
    for (const p of pcbGeoPads) if (p.net) nets.add(p.net);
    pcbEm.flush();
    if (nets.size) E.ensurePcbNets(pcbDoc.file, [...nets]);
    project.save();
    log(`pcb: ${pcbParts.length} footprints · placement-only (this skill never routes or pours)`);
    // partial-place notice (report 5.1): a hand-written pcb.place that covers
    // only SOME parts silently auto-places the rest — say so loudly
    const explicitCount = Object.keys(design.pcbSpec.place || {}).length;
    if (explicitCount > 0 && explicitCount < design.parts.length) {
      const autoIds = design.parts.filter((p) => !(design.pcbSpec.place || {})[p.id]).map((p) => p.id);
      log(`  pcb.place: ${explicitCount}/${design.parts.length} placed explicitly — auto-placed: ${autoIds.join(' ')}`);
    }
    log(`  rats: ${ratNets.length} net(s) to connect by hand in the client — ${ratNets.map(([n, c]) => `${n}(${c}p)`).join(' ') || 'none'}`);
  }

  // ---- client placement for system-library instances (2.x) -----------------
  // The official symbol/footprint documents are never downloaded or spliced:
  // the client places its symbols, then its own "schematic → PCB" update
  // (importChanges, forced) creates every footprint and links every pad net.
  // The planned positions are applied afterwards; validate/ERC/lint/DRC/
  // netcheck then read the client-saved project.
  const pcbPlan = [];
  let pcbImported = false;   // the client built the PCB from the schematic
  let schDrcResult = null;   // client schematic DRC (2.x, client builds only)
  if (doPcb) {
    const seenPcbRefs = new Set();
    for (const p of pcbParts) {
      const designator = p.part.multiUnitBase || p.part.id;
      if (seenPcbRefs.has(designator)) continue;
      seenPcbRefs.add(designator);
      pcbPlan.push({ designator, x: p.x, y: p.y, rotation: p.angle || 0 });
    }
  }
  if (librarySch.length) {
    if (rehearsal) {
      log(`library: ${librarySch.length} symbol(s) + PCB import would run through the client (skipped in --plan/--dry-run)`);
    } else {
      const CLI_LIB = require('./lib/cli-lib');
      log(`library: placing ${librarySch.length} symbol(s) and updating the PCB from the schematic through the EDA client`);
      let placed;
      try {
        placed = CLI_LIB.placeInstances(dir, {
          sch: librarySch,
          pcbPlan,
          schematicName: design.schematic
        });
      } catch (e) {
        die(`client placement failed — is the EDA client (V4.1.94+) running? ${e.message}`);
      }
      if (pcbPlan.length && !placed.imported) {
        die(`client PCB import failed — ${placed.importError || 'importChanges returned false'}`);
      }
      pcbImported = !!(pcbPlan.length && placed.imported);
      if (pcbPlan.length) {
        log(`  client: schematic netlist ${placed.schematicParts}/${pcbPlan.length} part(s); removed ${placed.removed} stale footprint(s), moved ${placed.moved}`);
        if (placed.missing && placed.missing.length) {
          log(`  client: import did not create ${placed.missing.length} part(s): ${placed.missing.slice(0, 8).join(' ')}${placed.missing.length > 8 ? ' …' : ''}`);
        }
      }
      const bad = [...((placed && placed.symbols) || []), ...((placed && placed.footprints) || [])].filter((x) => !x.ok);
      if (bad.length) {
        die(`client placement failed for ${bad.length} part(s): ${bad.slice(0, 8).map((b) => `${b.ref}${b.error ? ` (${b.error})` : ''}`).join(', ')}`);
      }
      // Schematic DRC: the client checks the finished sheet (unconnected pins,
      // near-but-not-connected points, off-grid net objects, …). Its report is
      // the repair list for the next design/layout iteration.
      try {
        schDrcResult = CLI_LIB.schDrc(dir);
      } catch (e) {
        if (!opts.quiet) console.log(`  note: schematic DRC skipped — ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------ validate
  if (!opts.design && !opts.gen) die('nothing to build: pass --design <file> or --gen <generator.js>');
  const report = {
    dir: requestedDir,
    design: design.file,
    name: design.name,
    schematic: {
      parts: placements.length,
      blocks: blocks.map((b) => b.title),
      ...routed.stats,
      layout: {
        strategy: best.kind,
        scale: best.scale,
        quality: {
          score: +best.quality.score.toFixed(3),
          areaNorm: +best.quality.areaNorm.toFixed(3),
          wireNorm: +best.quality.wireNorm.toFixed(3),
          bendNorm: +best.quality.bendNorm.toFixed(3),
          crossings: best.quality.wires.crossings,
          bends: best.quality.wires.bends,
          wireLength: Math.round(best.quality.wires.length),
          box: best.quality.box
        }
      }
    },
    pcb: {
      parts: pcbParts.length,
      mode: doPcb ? 'placed-only' : null,
      source: doPcb ? (pcbImported ? 'client-update' : 'skill-placement') : null,
      rats: ratNets.length
    },
    elapsed_ms: Date.now() - t0,
    generatedAt: new Date().toISOString(),
    issues: routed.issues
  };
  if (schDrcResult) {
    const vs = schDrcResult.violations || [];
    report.schDrc = {
      passed: !!schDrcResult.passed,
      counts: schDrcResult.counts || null,
      total: vs.length,
      violations: vs.slice(0, 80)
    };
  }

  // The staging area is authoring metadata: drop it once the project is built
  // and validated, so the deliverable is self-contained (cleanup.js does the
  // same thing by hand).
  try {
    if (!opts['keep-tmp']) fs.rmSync(path.join(dir, '.tmp'), { recursive: true, force: true });
  } catch (e) {
    // Windows file locks (EPERM/EBUSY) must not turn a finished build into a
    // failure — the staging dir is removable later with cleanup.js
    log(`  note: .tmp cleanup skipped (${e.code || e.message}) — run cleanup.js later`);
  }

  const { runValidate } = require('./lib/checks');
  const v = runValidate(dir);
  report.validate = v;

  const { runErc } = require('./lib/erc');
  const erc = runErc(dir, { design, pcb: doPcb });
  report.erc = erc;

  // Schematic ↔ PCB netlist comparison (netcheck): independent pin-by-pin
  // diff of both netlists — the explicit cross-check that the two documents
  // agree. Full detail in report.netcheck; `scripts/netcheck.js` re-runs it
  // standalone (e.g. after hand edits in the client).
  let netcheck = null;
  // A PCB the client built from the schematic (importChanges) is complete by
  // construction — the client's own update is the consistency proof. The
  // offline pin diff only runs for boards the skill placed itself.
  if (doPcb && !pcbImported) {
    const NC = require('./lib/netcheck');
    netcheck = NC.compare(require('./lib/netlist').projectNetlist(dir), D.multiUnitBaseOf(design.multiUnits));
    report.netcheck = { match: netcheck.match, summary: netcheck.summary, issues: netcheck.issues };
  }

  // Fifth gate: design intent (polarity, decoupling, declared pairs, ranges).
  // It fails the build like the others; --allow-intent skips it. Polarity
  // marks are checked even without an `expect` block — that is the promise in
  // docs/build.md, and the one gate that catches a reversed LED/diode.
  let intent = null;
  if (design.expect || design.parts.some((p) => p.polarity || p.roles)) {
    const { runIntent } = require('./lib/intent');
    intent = runIntent(design, { placedOnly: true });
    report.intent = intent;
  }

  const { lintProject } = require('./lib/lint');
  const lint = lintProject(dir);
  report.lint = lint;

  let drc = null;
  if (doPcb) {
    const { runDrc } = require('./lib/drc');
    const pcbDoc2 = project.requirePcb(design.pcb);
    const dr = design.pcbSpec.rules || {};
    drc = runDrc(project.pcbFile(pcbDoc2), {
      pourNet: (design.pcbSpec.pour && design.pcbSpec.pour.net) || 'GND',
      netWidths: design.netWidths || {},
      // The deliverable is placement-only by policy: D004/D006 (copper
      // promises) never judge it. The floors below still guard the placement
      // itself, and stay live when a client-authored board is re-checked.
      placedOnly: true,
      rules: {
        clearance: dr.clearance,
        minTrack: dr.trackWidth,
        edge: dr.edgeClearance,
        // DFM thresholds ride the same contract: a design may declare its fab
        // floor (minDrill/minRing/minAngle); undefined keys fall back to the
        // DRC defaults (runDrc strips them).
        minDrill: dr.minDrill,
        minRing: dr.minRing,
        minAngle: dr.minAngle
      }
    });
    report.drc = drc;
  }

  if (!opts.quiet) {
    // aggregate the informational notes that flood big boards (stub+label
    // fallbacks, flags parked on a pin): one count line each, full list in
    // report.issues
    const isNoise = (i) => /encoded as|placed on the pin/.test(i);
    const noise = routed.issues.filter(isNoise);
    const others = routed.issues.filter((i) => !isNoise(i));
    for (const i of others) console.log(`  ! ${i}`);
    if (noise.length) console.log(`  ! ${noise.length} informational note(s) (stub+label fallback / flag on pin — full list in the report)`);
    console.log(`validate: ${v.errors.length} errors, ${v.warnings.length} warnings`);
    for (const e of v.errors) console.log(`  ✗ ${e}`);
    for (const w of v.warnings) console.log(`  · ${w}`);
    for (const w of erc.warnings) console.log(`  erc warn ${w.id}: ${w.msg}${w.fix ? `\n      fix: ${w.fix}` : ''}`);
    for (const e of erc.errors) console.log(`  erc ${e.id}: ${e.msg}${e.fix ? `\n      fix: ${e.fix}` : ''}`);
    if (intent) {
      for (const w of intent.warnings) console.log(`  intent warn ${w.id}: ${w.msg}${w.fix ? `\n      fix: ${w.fix}` : ''}`);
      for (const e of intent.errors) console.log(`  intent ${e.id}: ${e.msg}${e.fix ? `\n      fix: ${e.fix}` : ''}`);
      if (intent.errors.length || intent.warnings.length) {
        console.log(`intent: ${intent.errors.length} error(s), ${intent.warnings.length} warning(s) over ${intent.checks.length} rule(s)`);
      }
    }
    for (const f of lint.findings) console.log(`  lint ${f.code}: ${f.msg}${f.fix ? `\n      fix: ${f.fix}` : ''}`);
    console.log(`lint score ${lint.score}/100 (${lint.errors} error(s), ${lint.warnings} warning(s))`);
    if (drc) {
      for (const f of drc.findings) console.log(`  drc ${f.code}: ${f.msg}${f.fix ? `\n      fix: ${f.fix}` : ''}`);
      console.log(`drc score ${drc.score}/100 (${drc.errors} error(s), ${drc.warnings} warning(s))`);
    }
    if (report.schDrc) {
      const c = report.schDrc.counts || {};
      console.log(`sch drc (client): ${c.fatalError || 0} fatal / ${c.error || 0} error / ${c.warn || 0} warn`);
      for (const v of report.schDrc.violations.slice(0, 20)) {
        const where = (v.primitives || [])
          .map((p) => (p.designator ? `${p.designator}${p.name ? `.${p.name}` : ''}` : (p.name || '')))
          .filter(Boolean)
          .join(', ');
        console.log(`  sch drc ${v.type || '?'} ${v.rule || ''}: ${v.net ? `[${v.net}] ` : ''}${where}${v.message ? ` ${v.message}` : ''}`);
      }
      if (report.schDrc.total > 20) console.log(`  … ${report.schDrc.total - 20} more in the report`);
    }
    if (netcheck) {
      console.log(netcheck.match
        ? `netcheck: OK — schematic ↔ PCB netlists match (${netcheck.summary.schematic.pins} pins)`
        : `netcheck: ${netcheck.issues.length} mismatch(es) — run scripts/netcheck.js --dir ${dir} for the full diff`);
    }
  }
  if (opts.digest) {
    // one-page snapshot: enough to resume a session (or hand off) without
    // re-reading build logs or the docs
    const signalNets = new Set();
    for (const p of design.parts) for (const n of Object.values(p.pins)) if (!/^(NC|DNC\d*)$/i.test(n)) signalNets.add(n);
    const pins = placements.reduce((n, pl) => n + pl.sym.pins.length, 0);
    console.log('— digest —');
    console.log(`工程 ${design.name} → ${requestedDir}`);
    console.log(`规模 ${design.parts.length} 器件 · ${signalNets.size} 信号网络 · ${pins} 引脚 · ${blocks.length} 模块 · ${design.sheets} 页`);
    console.log(`模块 ${blocks.map((b) => b.title).join(' | ')}`);
    console.log(`门禁 validate ${v.errors.length}/${v.warnings.length} · erc ${erc.errors.length}/${erc.warnings.length}`
      + `${intent ? ` · intent ${intent.errors.length}/${intent.warnings.length}` : ''}`
      + ` · lint ${lint.score} · drc ${drc ? drc.score : '-'}`
      + `${report.schDrc ? ` · sch drc ${report.schDrc.counts ? `${report.schDrc.counts.error || 0}E/${report.schDrc.counts.warn || 0}W` : '?'}` : ''}`
      + `${netcheck ? ` · netcheck ${netcheck.match ? 'OK' : `${netcheck.issues.length} 失配`}` : ''}`);
    if (ratNets.length) console.log(`布线交接 rats ${ratNets.length} 网络 → ${ratNets.slice(0, 12).map(([n, c]) => `${n}(${c}p)`).join(' ')}${ratNets.length > 12 ? ' …' : ''}`);
    console.log('— end digest —');
  }
  if (opts.report) {
    fs.writeFileSync(path.resolve(opts.report), JSON.stringify(report, null, 2), 'utf8');
  }
  if (v.errors.length) {
    console.error(`build finished with ${v.errors.length} format error(s)`);
    process.exit(1);
  }
  if (erc.errors.length && !opts['allow-erc']) {
    console.error(`build finished with ${erc.errors.length} ERC error(s) — fix the design or pass --allow-erc`);
    process.exit(1);
  }
  if (intent && intent.errors.length && !opts['allow-intent']) {
    console.error(`build finished with ${intent.errors.length} intent error(s) — the design contradicts its own "expect" block`);
    process.exit(1);
  }
  if (lint.errors && !opts['allow-lint']) {
    console.error(`build finished with ${lint.errors} layout error(s) — fix the layout or pass --allow-lint`);
    process.exit(1);
  }
  if (drc && drc.errors && !opts['allow-drc']) {
    console.error(`build finished with ${drc.errors} DRC error(s) — fix the design rules or pass --allow-drc`);
    process.exit(1);
  }
  const schDrcErrors = report.schDrc && report.schDrc.counts
    ? (report.schDrc.counts.fatalError || 0) + (report.schDrc.counts.error || 0)
    : 0;
  if (schDrcErrors && !opts['allow-sch-drc']) {
    console.error(`build finished with ${schDrcErrors} schematic DRC error(s) — fix the schematic or pass --allow-sch-drc`);
    process.exit(1);
  }
  const extra = [];
  if (erc.warnings.length) extra.push(`${erc.warnings.length} ERC warning(s)`);
  if (intent && intent.warnings.length) extra.push(`${intent.warnings.length} intent warning(s)`);
  if (drc && drc.warnings.length) extra.push(`${drc.warnings.length} DRC warning(s)`);
  const where = opts['dry-run']
    ? `${design.name} (dry run, nothing written)`
    : opts.plan
      ? `${design.name} → ${requestedDir} (plan only, nothing written)`
      : `${design.name}.eprj3 at ${dir}`;
  console.log(`${where} — ${placements.length} components, ${routed.stats.segments} wire segments, `
    + `lint ${lint.score}/100${drc ? `, drc ${drc.score}/100 (placed-only)` : ''}${extra.length ? `, ${extra.join(', ')}` : ''}.`);
  // --plan: show the REHEARSED board, not the declared one — a plan that
  // hides a board blow-up (S7) defeats its own purpose
  if (opts.plan) {
    const blown = design.boardDeclared
      && (design.board.width > declaredW * 1.5 || design.board.height > declaredH * 1.5);
    console.log(`  板框（演练）  ${design.board.width}×${design.board.height} mil`
      + (design.boardDeclared ? `（声明 ${declaredW}×${declaredH}）` : '（自动适配）')
      + (blown ? ' — ⚠ 超出声明 1.5×，请检查 pcb.place 或加大板框' : ''));
  }
}

main();
