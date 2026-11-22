#!/usr/bin/env node
'use strict';
/**
 * build.js — the declarative entry point.
 *
 * One command, one design file, one complete project:
 *
 *   node scripts/build.js --design design.json --dir <projectDir> [--force]
 *
 * Validates and emits an explicit schematic and PCB layout; it never chooses geometry.
 *
 * Re-running over an existing project requires --force, which deletes ONLY the
 * files this skill owns (index, sch/, pcb/, panel/, .tmp/).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const E = require('./lib/eprj3');
const G = require('./lib/geom');
const P = require('./lib/parts');
const D = require('./lib/design');
const Layout = require('./lib/authored-layout');
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
  { name: 'geometry', desc: 'print resolved symbol and footprint geometry as JSON; write no project', hasValue: false },
  { name: 'keep-tmp', desc: 'keep the .tmp staging area', hasValue: false },
  { name: 'keep-layout', desc: 'reuse existing PCB coordinates; supply explicit positions for new footprints and all intended copper', hasValue: false }
];

const SKILL_OWNED = ['sch', 'pcb', 'panel', '.tmp'];

/** Read the footprint positions of an existing PCB (designator → [x, y, angle]).
 *  Used by --keep-layout so a rebuild reuses the current board arrangement. */
function readExistingPlacements(projectDir) {
  const out = new Map();
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.epcb2$/i.test(e.name)) files.push(p);
    }
  };
  walk(path.join(projectDir, 'pcb'));
  for (const file of files) {
    const comps = new Map();
    const desig = new Map();
    let lines;
    try { lines = E.readLines(file); } catch { continue; }
    for (const line of lines) {
      const r = E.parseRecord(line);
      if (!r || !r.body) continue;
      if (r.type === 'COMPONENT') comps.set(r.id, { x: r.body.x, y: r.body.y, angle: r.body.angle });
      else if (r.type === 'ATTR' && r.body.key === 'Designator' && r.body.parentId) {
        desig.set(r.body.parentId, r.body.value);
      }
    }
    for (const [id, pos] of comps) {
      const ref = desig.get(id);
      if (ref && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        out.set(String(ref), [pos.x, pos.y, Number(pos.angle) || 0]);
      }
    }
  }
  return out;
}

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

function powerFlagKind(net) {
  const n = String(net).toUpperCase();
  if (/(^|[_-])(AGND|GNDA|ANALOG)/.test(n)) return 'AnalogGround';
  if (/(^|[_-])(PGND|GNDP|CHASSIS|SHIELD|EARTH)/.test(n)) return 'ProtectGround';
  if (/(^|[_-])(GND|VSS|0V)([_-]|$)/.test(n)) return 'Ground';
  return 'Power';
}

function makeLibrary(project, design) {
  const symbolCache = new Map();
  const footprintCache = new Map();
  const ctx = { ownerUuid: project.index.owner_uuid, client: project.client, ms: project.ms() };

  function symbolOf(part) {
    // system-library part resolved through the CLI: geometry drives the
    // layout; the client places the official symbol itself (no doc download)
    if (part.libraryEntry) {
      const e = part.libraryEntry;
      const key = `lib:${e.name}:${e.subPartName || ''}`;
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
      footprintCache.set(key, Object.assign(P.parseFootprintEntry(entry), { entry }));
    }
    return footprintCache.get(key);
  }

  return { symbolOf, footprintOf, symbolCache, footprintCache };
}

// Orientation of a two-pin symbol from its actual pin tips: stacked along Y
// means the part is vertical and its designator/name rows belong BESIDE the
// body (the bbox aspect alone misreads small bodies like a rotated CAP).
function twoPinIsVertical(sym, rotation) {
  const pins = (sym && sym.pins) || [];
  if (pins.length !== 2) return undefined;
  const a = G.rotate(pins[0].x, pins[0].y, rotation || 0);
  const b = G.rotate(pins[1].x, pins[1].y, rotation || 0);
  return Math.abs(a.y - b.y) > Math.abs(a.x - b.x);
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
  // Body-only extent (no pin tips, no label band): the designator/name rows
  // are placed from THIS box, so a rotated two-pin part gets its labels beside
  // the body instead of at the far pin tips (the "labels fly away" defect).
  let bodyExtent = null;
  if (sym && sym.bbox) {
    const b = sym.bbox;
    const pts = [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]].map(([cx, cy]) => {
      const r = G.rotate(cx, cy, pl.rotation || 0);
      return { x: pl.x + r.x, y: pl.y + r.y };
    });
    bodyExtent = G.bboxOfPoints(pts);
  }
  const block = E.schComponentBlock({
    compId: E.randId(),
    partId: sym.partId,
    x: pl.x, y: pl.y, rotation: pl.rotation || 0,
    extent: pl.extent,
    bodyExtent,
    pinCount: (sym.pins || []).length,
    twoPinVertical: twoPinIsVertical(sym, pl.rotation),
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

function placePcbComponent(em, project, design, pl, lib, opts) {
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
  // The embedded symbol / footprint / device DOCUMENTS are always needed: the
  // client's schematic → PCB import resolves the inline parts through them.
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
    net: Layout.isNC(netsByNum[p.num]) ? '' : netsByNum[p.num] || ''
  }));
  const result = {
    blockPads: pads,
    geoPads: placed.map((p) => ({ ref: part.id, num: p.num, net: netsByNum[p.num] || '', x: p.x, y: p.y, w: p.w, h: p.h })),
    x: px, y: py, angle: angle || 0
  };
  // Client builds leave the instance to `importChanges`: writing it here and
  // deleting it before the import leaves empty COMPONENT / PAD_NET shells in
  // the client-saved PCB (4.1.94), which netcheck then reads as extra pads.
  if (opts && opts.docsOnly) return result;
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
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('build.js [options]', SCHEMA,
      'Build an .eprj3 project from explicit schematic and PCB geometry, or inspect the resolved library with --geometry.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const requestedDir = path.resolve(opts.dir);
  const rehearsal = !!(opts['dry-run'] || opts.plan);
  // Design source: a plain design.json (--design) or a generator module
  // (--gen board.gen.js exporting (A) => design, see lib/authoring.js) — big
  // boards are authored as a short generator, never as thousands of JSON lines
  // and never as an agent-invented temp script.
  if (!!opts.design === !!opts.gen) die('pass exactly one of --design or --gen');
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
  const t0 = Date.now();                  // report.elapsed_ms
  const doPcb = !opts['schematic-only'] && !design.skipPcb;

  if (opts['keep-layout']) {
    if (!doPcb) die('--keep-layout needs the PCB (drop --schematic-only)');
    const existing = readExistingPlacements(requestedDir);
    if (!existing.size) {
      die(`--keep-layout: no footprint positions found in ${requestedDir} — build the project once, then rebuild with --keep-layout`);
    }
    const place = { ...design.pcbSpec.place };
    for (const p of design.parts) {
      const ref = p.multiUnitBase || p.id;
      if (existing.has(ref)) place[ref] = existing.get(ref);
    }
    design.pcbSpec = { ...design.pcbSpec, place };
  }
  if (!doPcb) design.skipPcb = true;

  // ---- system-library devices, resolved through the client CLI (2.x) -------
  // No local cache and no document download: the client returns the device
  // geometry (layout) and later places the official symbol/footprint instances
  // itself. See lib/cli-lib.js.
  const libRefs = design.parts.filter((p) => p.libraryRef);
  if (libRefs.length) {
    const CLI_LIB = require('./lib/cli-lib');
    const uniq = new Map();
    const libraryKey = (r) => JSON.stringify([r.name, r.lcsc, r.subPartName]);
    for (const p of libRefs) uniq.set(libraryKey(p.libraryRef), p.libraryRef);
    let resolved;
    try {
      resolved = CLI_LIB.resolveDevices([...uniq].map(([key, r]) => ({ key, name: r.name, lcsc: r.lcsc || undefined, subPartName: r.subPartName })));
    } catch (e) {
      die(`resolving system-library device(s) needs the LCEDA/EasyEDA Pro CLI (V4.1.94+): ${e.message}`);
    }
    const byKey = new Map((resolved || []).map((e) => [e.key, e]));
    for (const p of libRefs) {
      const e = byKey.get(libraryKey(p.libraryRef));
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
  const log = (msg) => { if (!opts.quiet) console.log(msg); };

  // Resolve library and validate authored geometry before touching the output.
  const sourceProject = new E.Project(requestedDir);
  sourceProject.index = { owner_uuid: E.uuid32() };
  const lib = makeLibrary(sourceProject, design);
  const check = D.validateDesign(design, lib);
  if (check.errors.length) {
    console.error('design errors:');
    for (const e of check.errors) console.error(`  ✗ ${e}`);
    process.exit(2);
  }
  if (opts.geometry) {
    console.log(JSON.stringify(Layout.geometry(design, lib, doPcb), null, 2));
    return;
  }
  const { placements, blocks, routed } = Layout.schematic(design, lib);
  const pcbLayout = doPcb ? Layout.pcb(design, lib) : null;
  const pcbMode = pcbLayout?.mode ?? null;
  const usesClient = placements.some((p) => p.part.libraryEntry);
  const clientBuild = !rehearsal && usesClient;
  if (opts.plan && usesClient) {
    console.log(`Plan: ${design.name} — ${placements.length} symbols, ${routed.stats.segments} wire segments, ${pcbLayout?.tracks.length ?? 0} copper segments. Client import and gates not run.`);
    return;
  }
  if (opts['dry-run'] && usesClient) die('client-library projects support --plan; real client import and verification require an actual build');
  const dir = rehearsal ? fs.mkdtempSync(path.join(os.tmpdir(), 'eprj3-preview-')) : requestedDir;
  if (rehearsal) process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (!opts.force) die(`${dir} is not empty — pass --force to rebuild it`);
    safeClean(dir);
  }
  const project = E.Project.create(dir, design.name);
  project.ensureBoard();
  const pcbDoc = doPcb ? project.ensurePcbDocument(design.pcb, {
    outline: E.rectPath(0, 0, design.board.width, design.board.height)
  }) : null;
  if (pcbLayout) {
    const layers = E.readLines(pcbDoc.file).map((line) => {
      const r = E.parseRecord(line);
      if (r?.type !== 'LAYER' || !pcbLayout.copperLayers.has(r.body.layerId) || r.body.use) return line;
      return E.formatRecord(r.head, { ...r.body, use: true, show: true });
    });
    E.writeLines(pcbDoc.file, layers);
  }
  log(`created ${design.name} at ${dir}`);
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
    console.log(doPcb ? `  PCB ${design.board.width}×${design.board.height} mil · ${pcbMode}` : '  Schematic only');
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

  // Emit the exact drawing coordinates; size the page decoration around them.
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
      || (design.blocks.find((b) => b.sheet === s)?.title || `P${s}`);
    // a title becomes a FILE name — strip path-hostile characters and cap the
    // length; a repeated title gets the page number appended to stay unique
    sheetTitle = String(sheetTitle).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 40) || `P${s}`;
    if (usedSheetTitles.has(sheetTitle)) sheetTitle = `${sheetTitle} ${s}`;
    usedSheetTitles.add(sheetTitle);
    sheetTitleBySheet.set(s, sheetTitle);
    let x2 = 0, y2 = 0;
    for (const bl of sheetBlocks) { x2 = Math.max(x2, bl.rect.x2); y2 = Math.max(y2, bl.rect.y2); }
    for (const p of sheetPls) { const e = p.extent; x2 = Math.max(x2, e.x2); y2 = Math.max(y2, e.y2); }
    for (const w of routed.wires.filter((w) => w.sheet === s)) for (const seg of w.segs) {
      x2 = Math.max(x2, seg.x1, seg.x2); y2 = Math.max(y2, seg.y1, seg.y2);
    }
    for (const t of [...routed.flags, ...routed.ports].filter((t) => t.sheet === s)) {
      x2 = Math.max(x2, t.x); y2 = Math.max(y2, t.y);
    }
    const needW = Math.ceil(Math.max(0, x2) + 60);
    const needH = Math.ceil(Math.max(0, y2) + 60 + (design.frame?.titleBlock === true ? 100 : 0));
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
  }

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
        subPartName: pl.part.libraryEntry.subPartName,
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
  const flagPlan = [];
  for (const flag of routed.flags) {
    if (clientBuild) {
      flagPlan.push({
        pageName: sheetTitleBySheet.get(flag.sheet || 1) || `P${flag.sheet || 1}`,
        net: flag.net,
        x: flag.x,
        y: flag.y,
        type: flag.style === 'down' && powerFlagKind(flag.net) === 'Power' ? 'Ground' : powerFlagKind(flag.net),
        rotation: flag.rot
      });
      continue;
    }
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

  const wirePlan = [];
  for (const w of routed.wires) {
    const em = emitters.get(w.sheet);
    if (clientBuild) {
      const [first] = w.segs;
      wirePlan.push({
        pageName: sheetTitleBySheet.get(w.sheet), net: w.net, hideLabel: !w.label,
        chains: [[first.x1, first.y1, ...w.segs.flatMap((seg) => [seg.x2, seg.y2])]]
      });
      continue;
    }
    const block = E.wireBlock({
      segs: w.segs.map((s) => ({ startX: s.x1, startY: s.y1, endX: s.x2, endY: s.y2 })),
      net: w.net,
      netVisible: w.label,
      zIndex: em.nextZ(),
      ticketBase: em.nextTicket() - 1
    });
    em.addLines(block.lines);
    em.t = block.nextTicket + 1;
  }

  for (const em of emitters.values()) em.flush();
  project.save();
  log(`schematic: ${placements.length} parts in ${blocks.length} blocks across ${design.sheets} sheet(s)`
    + `, ${routed.stats.segments} wire segments, ${routed.stats.flags} power flags, ${routed.stats.ports} net ports`);

  // ------------------------------------------------------------ pcb
  const pcbParts = [];
  const pcbGeoPads = [];
  const bom = [];          // per-designator device/footprint for project-report.md
  let ratNets = [];
  if (doPcb) {
    const placementPlan = pcbLayout.placements;
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
        bom.push({
          ref: designator,
          device: pl.part.ic || pl.part.name || null,
          value: pl.part.value || null,
          footprint: (fp && fp.name) || null,
          lcsc: (pl.part.libraryRef && pl.part.libraryRef.lcsc) || null
        });
        continue;
      }
      const placed = placePcbComponent(pcbEm, project, design, pl, lib, { docsOnly: clientBuild });
      if (placed) {
        pcbParts.push(Object.assign({ part: pl.part }, placed));
        pcbGeoPads.push(...placed.geoPads);
        const fp = lib.footprintOf(pl.part);
        bom.push({
          ref: pl.part.multiUnitBase || pl.part.id,
          device: pl.part.ic || pl.part.name || null,
          value: pl.part.value || null,
          footprint: (fp && fp.name) || null,
          lcsc: null
        });
      }
    }

    pcbEm.flush();
    project.save();
  }

  // Attribute rows (designator/name) for every placement. Client builds apply
  // these through sch_SourcePrimitiveComponent.updateAttribute — the source
  // API — so the positions match the authored records exactly and also cover
  // the symbols the client placed itself (an "ic" part has no authored ATTR).
  const attrPlan = [];
  {
    const seenAttr = new Set();
    for (const pl of placements) {
      const ref = pl.part.multiUnitBase || pl.part.id;
      const sheet = pl.sheet || 1;
      const pageName = sheetTitleBySheet.get(sheet);
      if (!pageName) continue;
      const sym = lib.symbolOf(pl.part);
      const b = sym && sym.bbox;
      let body = null;
      if (b) {
        const pts = [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]].map(([cx, cy]) => {
          const r = G.rotate(cx, cy, pl.rotation || 0);
          return { x: pl.x + r.x, y: pl.y + r.y };
        });
        body = G.bboxOfPoints(pts);
      }
      const rows = E.attrRows(body, ((sym && sym.pins) || []).length <= 2, pl.x, pl.y,
        twoPinIsVertical(sym, pl.rotation));
      for (const key of ['Designator', 'Name']) {
        const k = `${pageName}|${ref}|${key}`;
        if (seenAttr.has(k)) continue;
        seenAttr.add(k);
        attrPlan.push({ pageName, designator: ref, key, x: rows[key].x, y: rows[key].y });
      }
    }
  }

  // NC pins get a real no-connect marker through the client API (the source
  // records cannot express it): design pin → net "NC"/"DNCn" → component pin.
  const ncPlan = [];
  {
    const byKey = new Map();
    for (const pl of placements) {
      const ref = pl.part.multiUnitBase || pl.part.id;
      const pageName = sheetTitleBySheet.get(pl.sheet || 1);
      if (!pageName) continue;
      const pins = Object.entries(pl.part.pins || {})
        .filter(([, n]) => Layout.isNC(n))
        .map(([num]) => String(num));
      if (!pins.length) continue;
      const k = `${pageName}|${ref}`;
      if (!byKey.has(k)) byKey.set(k, { pageName, designator: ref, pins: [] });
      byKey.get(k).pins.push(...pins);
    }
    for (const it of byKey.values()) {
      it.pins = [...new Set(it.pins)];
      ncPlan.push(it);
    }
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
    const CLI_LIB = require('./lib/cli-lib');
    log(`library: placing ${librarySch.length} symbol(s) and updating the PCB from the schematic through the EDA client (headless — no window opens)`);
    let placed;
    try {
      placed = CLI_LIB.placeInstances(dir, {
        sch: librarySch,
        flagPlan,
        wirePlan,
        pcbPlan,
        attrPlan,
        ncPlan,
        schematicName: design.schematic
      });
    } catch (e) {
      die(`client placement failed — is the EDA client (V4.1.94+) running? ${e.message}`);
    }
    if (pcbPlan.length && !placed.imported) {
      die(`client PCB import failed — ${placed.importError || 'importChanges returned false'}`
        + ` (schematic ${placed.schematicParts}/${pcbPlan.length} part(s), ${placed.wires.length} wire chain(s) drawn, ${placed.removed} stale footprint(s) removed)`);
    }
    if (pcbPlan.length && placed.imported && placed.importEmpty) {
      die(`client PCB import created 0 footprint(s): ${placed.importEmpty}`
        + ` — schematic netlist ${placed.schematicParts}/${pcbPlan.length} part(s); check that every placed component is a device with a footprint`);
    }
    pcbImported = !!(pcbPlan.length && placed.imported);
    if (pcbPlan.length) {
      log(`  client: schematic netlist ${placed.schematicParts}/${pcbPlan.length} part(s); removed ${placed.removed} stale footprint(s), moved ${placed.moved}`);
      if (placed.missing && placed.missing.length) {
        die(`client import did not create ${placed.missing.length} part(s): ${placed.missing.slice(0, 8).join(' ')}${placed.missing.length > 8 ? ' …' : ''}`);
      }
    }
    if (placed.flags && placed.flags.length) {
      log(`  client: placed ${placed.flags.length} power flag(s) through the source API`);
    }
    if (placed.wires && placed.wires.length) {
      log(`  client: drew ${placed.wires.length} wire chain(s) through the source API`);
    }
    if (placed.attrs && placed.attrs.length) {
      const badRows = placed.attrs.filter((a) => !a.ok);
      log(`  client: placed ${placed.attrs.length - badRows.length}/${placed.attrs.length} designator/name row(s) via updateAttribute`);
      if (badRows.length) {
        log(`  client: ${badRows.length} row(s) kept their authored position (${badRows.slice(0, 4).map((b) => `${b.ref}.${b.key}`).join(', ')}${badRows.length > 4 ? ' …' : ''})`);
      }
    }
    if (placed.nc && (placed.nc.marked.length || placed.nc.failed.length)) {
      log(`  client: marked ${placed.nc.marked.length} NC pin(s) no-connect`);
      if (placed.nc.failed.length) {
        log(`  client: ${placed.nc.failed.length} NC pin(s) not marked (${placed.nc.failed.slice(0, 4).map((b) => `${b.ref}.${b.pin || '?'}`).join(', ')}${placed.nc.failed.length > 4 ? ' …' : ''})`);
      }
    }
    const bad = [
      ...((placed && placed.symbols) || []),
      ...((placed && placed.flags) || []),
      ...((placed && placed.wires) || []),
      ...((placed && placed.footprints) || [])
    ].filter((x) => !x.ok);
    if (bad.length) {
      die(`client placement failed for ${bad.length} item(s): ${bad.slice(0, 8).map((b) => `${b.ref || b.net}${b.error ? ` (${b.error})` : ''}`).join(', ')}`);
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

  if (pcbLayout) {
    // Client import must finish before copper is written, or it can overwrite it.
    const em = new Emitter(pcbDoc.file);
    for (const track of pcbLayout.tracks) em.addLines([E.pcbTrackLine({ ...track, ticketBase: em.nextTicket() })]);
    for (const via of pcbLayout.vias) em.addLines([E.pcbViaLine({ ...via, ticketBase: em.nextTicket() })]);
    em.flush();
    const nets = new Set(pcbGeoPads.map((p) => p.net).filter((n) => n && !Layout.isNC(n)));
    if (nets.size) E.ensurePcbNets(pcbDoc.file, [...nets]);
    log(`pcb: ${pcbParts.length} footprints · ${pcbLayout.tracks.length} copper segments · ${pcbLayout.vias.length} vias (${pcbMode})`);
  }

  const report = {
    dir: requestedDir,
    design: design.file,
    name: design.name,
    schematic: {
      parts: placements.length,
      blocks: blocks.map((b) => b.title),
      wiring: 'ai-authored',
      ...routed.stats,
      layout: { strategy: 'ai-authored' }
    },
    pcb: {
      parts: pcbParts.length,
      mode: pcbMode,
      source: doPcb ? (pcbImported ? 'client-update' : 'record-emitter') : null,
      layout: doPcb ? 'ai-authored' : null,
      tracks: pcbLayout?.tracks.length ?? 0,
      vias: pcbLayout?.vias.length ?? 0,
      board: doPcb ? { width: design.board.width, height: design.board.height } : null,
      rats: ratNets.length
    },
    bom: bom.length ? bom : null,
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
  // agree. It also runs on client-imported boards: with the empty-shell fix
  // the PAD_NET records are exactly the real pads, so the diff is meaningful
  // (and catches an import that silently dropped a part). Full detail in
  // report.netcheck; `scripts/netcheck.js` re-runs it standalone.
  let netcheck = null;
  if (doPcb) {
    const NC = require('./lib/netcheck');
    netcheck = NC.compare(require('./lib/netlist').projectNetlist(dir), D.multiUnitBaseOf(design.multiUnits), D.noConnectPins(design));
    report.netcheck = { match: netcheck.match, summary: netcheck.summary, issues: netcheck.issues };
  }

  const audit = require('./lib/audit').buildPackage(dir, design);
  report.audit = audit.mechanical;

  // Fifth gate: design intent (polarity, decoupling, declared pairs, ranges).
  // It fails the build like the others; --allow-intent skips it. Polarity
  // marks are checked even without an `expect` block — that is the promise in
  // docs/build.md, and the one gate that catches a reversed LED/diode.
  let intent = null;
  if (design.expect || design.parts.some((p) => p.polarity || p.roles)) {
    const { runIntent } = require('./lib/intent');
    intent = runIntent(design, { placedOnly: pcbMode !== 'routed' });
    report.intent = intent;
  }

  const { lintProject } = require('./lib/lint');
  const lint = lintProject(dir);
  report.lint = lint;

  let drc = null;
  if (doPcb) {
    const { runDrc } = require('./lib/drc');
    const dr = design.pcbSpec.rules || {};
    // the plane net follows the design's declared ground, not a hardcoded GND
    // (VSS / PGND / 0V boards never got the missing-pour hint before)
    const pourNet = (Object.entries(design.powers || {}).find(([, dir]) => dir === 'down') || [])[0] || 'GND';
    drc = runDrc(pcbDoc.file, {
      netWidths: design.netWidths || {},
      noConnect: D.noConnectPins(design),
      placedOnly: pcbMode === 'placed-only',
      pourNet,
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
    ratNets = drc.findings.filter((f) => f.code === 'D004').map((f) => [f.net, f.pads]);
    if (pcbMode === 'placed-only') {
      const counts = new Map();
      for (const p of pcbGeoPads) if (p.net && !Layout.isNC(p.net)) counts.set(p.net, (counts.get(p.net) || 0) + 1);
      ratNets = [...counts].filter(([, n]) => n > 1);
    }
    report.pcb.rats = ratNets.length;
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
    if (ratNets.length) console.log(`待布线网络 rats ${ratNets.length} 网络 → ${ratNets.slice(0, 12).map(([n, c]) => c ? `${n}(${c}p)` : n).join(' ')}${ratNets.length > 12 ? ' …' : ''}`);
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
  if (!report.audit.ok) die('built schematic does not match the declared circuit; see audit in the build report');
  if (netcheck && !netcheck.match) die('schematic and PCB netlists do not match; see netcheck or the build report');
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
    + `lint ${lint.score}/100${drc ? `, drc ${drc.score}/100 (${pcbMode})` : ''}${extra.length ? `, ${extra.join(', ')}` : ''}.`);
}

try { main(); } catch (e) {
  if (e instanceof D.DesignError) die(e.message);
  else throw e;
}
