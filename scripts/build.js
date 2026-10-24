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
 * every net (wire / L / Z / stub+label / power flag), annotates the blocks,
 * places the footprints on the PCB and — with --route — routes and pours it.
 * Then it validates and reports, so an agent gets the same information a human
 * reviewer would.
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
const R = require('./lib/route');
const FA = require('./lib/fp-auto');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory to create', required: true },
  { name: 'design', desc: 'design.json file', required: true },
  { name: 'force', desc: 'overwrite an existing project (deletes skill-owned files only)', hasValue: false },
  { name: 'schematic-only', desc: 'skip the PCB entirely', hasValue: false },
  { name: 'route', desc: 'opt-in: run the maze router after placement (off by default — the shipped strategy is placement-only)', hasValue: false },
  { name: 'pour', desc: 'opt-in: add the copper pour + stitching fence (off by default; needs --route to also route the non-poured nets)', hasValue: false },
  { name: 'no-route', desc: 'legacy no-op — routing is off by default now', hasValue: false },
  { name: 'no-pour', desc: 'legacy no-op — pouring is off by default now', hasValue: false },
  { name: 'allow-erc', desc: 'do not fail the build on ERC errors', hasValue: false },
  { name: 'allow-intent', desc: 'do not fail the build on design-intent errors', hasValue: false },
  { name: 'allow-lint', desc: 'do not fail the build on layout errors', hasValue: false },
  { name: 'allow-drc', desc: 'do not fail the build on DRC errors', hasValue: false },
  { name: 'dry-run', desc: 'build into a throwaway directory, report, then delete it', hasValue: false },
  { name: 'report', desc: 'write the machine-readable build report to this file' },
  { name: 'plan', desc: 'print what would be built (parts, nets, rules, intent gate) and write nothing', hasValue: false },
  { name: 'quiet', desc: 'only print the final summary line', hasValue: false },
  { name: 'keep-tmp', desc: 'keep the .tmp staging area (normally removed after a clean build)', hasValue: false }
];

const SKILL_OWNED = ['sch', 'pcb', 'panel', '.tmp'];

function safeClean(dir) {
  const entries = fs.readdirSync(dir);
  const index = entries.find((e) => e.endsWith('.eprj3'));
  if (!index) {
    die(`refusing to --force: no .eprj3 index in ${dir} — that does not look like a project this skill created`);
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

function makeLibrary(project, design) {
  const symbolCache = new Map();
  const footprintCache = new Map();
  const ctx = { ownerUuid: project.index.owner_uuid, client: project.client, ms: project.ms() };

  function symbolOf(part) {
    if (typeof part.symbol === 'string') {
      const entry = project.loadLibrary(part.symbol);
      if (!entry) die(`part "${part.id}": symbol entry "${part.symbol}" not found (see scripts/load-library.js list)`);
      if (entry.kind === 'footprint') die(`part "${part.id}": "${part.symbol}" is a footprint, not a symbol`);
      if (!symbolCache.has(entry.name)) symbolCache.set(entry.name, P.parseSymbolEntry(entry));
      return Object.assign({ entry }, symbolCache.get(entry.name));
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

function placeSchematicComponent(em, project, pl, lib) {
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
  const deviceUuid = E.uuid16();
  const deviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: deviceTitle,
    designator: entry.designator || 'U?',
    symbolUuid: entry.symbolUuid,
    symbolName: entry.name,
    footprintUuid: fpEntry ? fpEntry.footprintUuid : undefined,
    footprintName: fpEntry ? fpEntry.name : undefined,
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
    x: pl.x, y: pl.y, rotation: pl.rotation || 0,
    zIndex: em.nextZ(),
    symbolUuid: entry.symbolUuid,
    deviceUuid,
    deviceName: deviceTitle,
    footprintUuid: fpEntry ? fpEntry.footprintUuid : null,
    refdes: pl.part.id,
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

function placePcbComponent(em, project, design, pl, lib) {
  const part = pl.part;
  const sym = lib.symbolOf(part);
  const fp = lib.footprintOf(part);
  if (!fp) return null;
  const fpEntry = fp.entry;
  const deviceUuid = E.uuid16();
  const deviceTitle = part.name || fpEntry.name;
  const deviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: deviceTitle,
    designator: sym.designator || 'U?',
    symbolUuid: sym.entry.symbolUuid,
    symbolName: sym.name,
    footprintUuid: fpEntry.footprintUuid,
    footprintName: fpEntry.name,
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
      'Build a complete .eprj3 project from a design.json (schematic + PCB, auto layout, auto routing).');
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
  const design = D.readDesign(path.resolve(opts.design));
  const doPcb = !opts['schematic-only'] && !design.skipPcb;
  // Strategy: ships placement-only. Routing and copper pour are opt-in flags
  // so the generated board is a clean starting point for a human, not finished
  // copper a human must first delete. The DRC knows the mode and does not flag
  // unrouted nets or a missing pour that were never promised.
  const doRoute = !!opts.route;
  const doPour = !!opts.pour;
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
  const sheetDoc = project.ensureSheetDocument(design.schematic, design.sheet);
  const pcbDoc = project.ensurePcbDocument(design.pcb, {
    outline: E.rectPath(0, 0, design.board.width, design.board.height)
  });
  log(`created ${design.name} at ${dir} (board ${design.board.width}×${design.board.height} mil)`);

  // ------------------------------------------------------------ library
  const lib = makeLibrary(project, design);
  const check = D.validateDesign(design, lib);
  if (check.errors.length) {
    console.error('design errors:');
    for (const e of check.errors) console.error(`  ✗ ${e}`);
    process.exit(2);
  }

  // ------------------------------------------------- plan gate (--plan)
  // What a human must be able to veto before anything is written: the power
  // chain, the net names, the rule set and the intent declarations. Printed
  // from the *validated* design, so it cannot disagree with the build.
  if (opts.plan) {
    const rules = design.pcbSpec.rules || {};
    const nets = [...new Set(design.parts.flatMap((p) => Object.values(p.pins || {})))].sort();
    console.log(`方案 ${design.name} → ${requestedDir}`);
    const copper = [];
    if (doRoute) copper.push('布线(--route)');
    if (doPour) copper.push(`铺铜 ${design.pcbSpec.pour && design.pcbSpec.pour.net || 'GND'}(--pour)`);
    console.log(`  板框  ${design.board.width}×${design.board.height} mil · `
      + `${doPcb ? (copper.length ? `铜皮: ${copper.join(' + ')}` : '只布局（默认不布线/不铺铜；可选 --route / --pour）') : '仅原理图 (--schematic-only)'}`);
    console.log(`  电源  ${Object.entries(design.powers).map(([n, s]) => `${n}${s === 'up' ? '↑' : '↓'}`).join(' ')}`);
    const widths = Object.entries(design.netWidths || {});
    if (widths.length) console.log(`  线宽  ${widths.map(([n, w]) => `${n}=${w}mil`).join(' ')}`);
    if (Object.keys(rules).length) console.log(`  规则  ${Object.entries(rules).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  规模  ${design.parts.length} parts · ${nets.length} nets · ${(design.blocks || []).length} blocks`);
    console.log(`  模块  ${(design.blocks || []).map((b) => b.title).join(' | ') || '(未分块)'}`);
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
  const { placements, blocks } = D.layoutSchematic(design, lib);
  const routed = R.routeSchematic(design, placements);
  const em = new Emitter(sheetDoc.file);

  // block frames first (lowest z, so components draw on top)
  for (const b of blocks) {
    em.addLines([E.schRectLine({
      x1: b.rect.x1, y1: b.rect.y1, x2: b.rect.x2, y2: b.rect.y2,
      zIndex: em.nextZ(), ticketBase: em.nextTicket()
    })]);
    em.addLines([E.schTextLine({
      x: b.rect.x1 + 10, y: b.rect.y2 - 30,
      value: b.title, fontSize: 14,
      zIndex: em.nextZ(), ticketBase: em.nextTicket()
    })]);
  }

  for (const pl of placements) placeSchematicComponent(em, project, pl, lib);

  const powerEntries = new Map();
  for (const flag of routed.flags) {
    if (!powerEntries.has(flag.net)) {
      const entry = require('./lib/entries').buildPowerEntry(project, flag.net, flag.style);
      project.saveLibrary(entry);
      powerEntries.set(flag.net, entry);
    }
    placePowerFlag(em, project, flag, powerEntries.get(flag.net));
  }

  for (const w of routed.wires) {
    const block = E.wireBlock({
      segs: w.segs.map((s) => ({ startX: s.x1, startY: s.y1, endX: s.x2, endY: s.y2 })),
      net: w.net,
      zIndex: em.nextZ(),
      ticketBase: em.nextTicket() - 1
    });
    em.addLines(block.lines);
    em.t = block.nextTicket + 1;
  }

  em.flush();
  project.save();
  log(`schematic: ${placements.length} parts in ${blocks.length} blocks, ${routed.stats.segments} wire segments, ${routed.stats.flags} power flags`);

  // ------------------------------------------------------------ pcb
  const pcbParts = [];
  const pcbGeoPads = [];
  let routing = null;
  let pourPlan = null;
  if (doPcb) {
    const { planPcb } = require('./lib/pcb-plan');
    let plan = planPcb(design, lib, placements);
    // The board must fit what the placer needs; grow it instead of dropping
    // parts on top of each other.
    if (plan.required.width > design.board.width || plan.required.height > design.board.height) {
      const newW = Math.max(design.board.width, plan.required.width);
      const newH = Math.max(design.board.height, plan.required.height);
      log(`board grown to ${newW}×${newH} mil to fit ${design.parts.length} parts`);
      design.board.width = newW;
      design.board.height = newH;
      E.updateRecord(pcbDoc.file,
        (r) => r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE',
        (r) => { r.body.path = E.rectPath(0, 0, newW, newH); });
      plan = planPcb(design, lib, placements);
    }
    const placementPlan = plan.placements;
    const pcbEm = new Emitter(pcbDoc.file);
    for (const pl of placementPlan) {
      const placed = placePcbComponent(pcbEm, project, design, pl, lib);
      if (placed) {
        pcbParts.push(Object.assign({ part: pl.part }, placed));
        pcbGeoPads.push(...placed.geoPads);
      }
    }

    const pcbCfg = design.pcbSpec || {};
    const rules = Object.assign({}, require('./lib/pcb-route').DEFAULT_RULES, pcbCfg.rules || {});
    const pourNet = (pcbCfg.pour && pcbCfg.pour.net) || 'GND';
    if (doRoute) {
      const { routePcb } = require('./lib/pcb-route');
      // The poured net is joined by the plane itself — routing it would only
      // lay copper that fights the pour.
      routing = routePcb({
        pads: pcbGeoPads,
        board: design.board,
        rules,
        netWidths: design.netWidths || {},
        skipNets: doPour ? [pourNet] : []
      });
      for (const t of routing.tracks) {
        pcbEm.addLines([E.pcbTrackLine({
          netName: t.net,
          layerId: t.layer + 1,
          startX: t.x1, startY: t.y1, endX: t.x2, endY: t.y2,
          width: t.width,
          ticketBase: pcbEm.nextTicket()
        })]);
      }
      for (const v of routing.vias) {
        pcbEm.addLines([E.pcbViaLine({
          netName: v.net, x: v.x, y: v.y,
          viaDiameter: v.diameter, holeDiameter: v.drill,
          ticketBase: pcbEm.nextTicket()
        })]);
      }
    }

    if (doPour) {
      const { planPours } = require('./lib/pour');
      pourPlan = planPours(design.board, {
        net: (pcbCfg.pour && pcbCfg.pour.net) || 'GND',
        clearance: rules.edgeClearance + 4,
        layers: rules.layers >= 2 ? [1, 2] : [1],
        stitch: pcbCfg.pour ? pcbCfg.pour.stitch !== false : true,
        viaDiameter: rules.viaDiameter,
        viaDrill: rules.viaDrill,
        viaClearance: rules.clearance,
        obstacles: {
          pads: pcbGeoPads,
          tracks: routing ? routing.tracks : [],
          vias: routing ? routing.vias : []
        }
      });
      let n = 0;
      for (const p of pourPlan.pours) {
        n += 1;
        pcbEm.addLines([E.pcbPourLine({
          netName: p.net,
          layerId: p.layer,
          name: `POUR${n}`,
          path: p.path,
          ticketBase: pcbEm.nextTicket()
        })]);
      }
      for (const v of pourPlan.vias) {
        pcbEm.addLines([E.pcbViaLine({
          netName: v.net, x: v.x, y: v.y,
          viaDiameter: v.width, holeDiameter: v.hole,
          ticketBase: pcbEm.nextTicket()
        })]);
      }
    }

    const nets = new Set();
    for (const p of pcbGeoPads) if (p.net) nets.add(p.net);
    if (pourPlan) for (const p of pourPlan.pours) nets.add(p.net);
    pcbEm.flush();
    if (nets.size) E.ensurePcbNets(pcbDoc.file, [...nets]);
    project.save();
    log(`pcb: ${pcbParts.length} footprints`
      + (routing ? `, ${routing.stats.tracks} tracks, ${routing.stats.vias} vias (${routing.stats.routedNets}/${routing.stats.nets} nets)` : '')
      + (pourPlan ? `, ${pourPlan.pours.length} pours, ${pourPlan.vias.length} stitching vias` : '')
      + (!routing && !pourPlan ? ' · placement-only (no routing/pour — add --route / --pour for copper)' : ''));
    for (const u of (routing ? routing.unrouted : [])) log(`  ! unrouted ${u}`);
    if (pourPlan) for (const n of pourPlan.notes) log(`  · pour: ${n}`);
  }

  // ------------------------------------------------------------ validate
  const report = {
    dir: requestedDir,
    design: design.file,
    name: design.name,
    schematic: {
      parts: placements.length,
      blocks: blocks.map((b) => b.title),
      ...routed.stats
    },
    pcb: { parts: pcbParts.length, mode: doPcb ? (doRoute || doPour ? 'copper' : 'placed-only') : null },
    issues: routed.issues
  };

  // The staging area is authoring metadata: drop it once the project is built
  // and validated, so the deliverable is self-contained (cleanup.js does the
  // same thing by hand).
  if (!opts['keep-tmp']) fs.rmSync(path.join(dir, '.tmp'), { recursive: true, force: true });

  const { runValidate } = require('./lib/checks');
  const v = runValidate(dir);
  report.validate = v;

  const { runErc } = require('./lib/erc');
  const erc = runErc(dir, { design, pcb: doPcb });
  report.erc = erc;

  // Fifth gate: design intent (polarity, decoupling, declared pairs, ranges).
  // It fails the build like the others; --allow-intent skips it.
  let intent = null;
  if (design.expect) {
    const { runIntent } = require('./lib/intent');
    intent = runIntent(design);
    report.intent = intent;
  }

  const { lintProject } = require('./lib/lint');
  const lint = lintProject(dir);
  report.lint = lint;

  let drc = null;
  if (doPcb) {
    const { runDrc } = require('./lib/drc');
    const pcbDoc2 = project.requirePcb(design.pcb);
    // Judge the copper against the SAME rules the router built it with — the
    // DRC's own defaults are only a fallback, not the design's contract.
    const dr = design.pcbSpec.rules || {};
    drc = runDrc(project.pcbFile(pcbDoc2), {
      pourNet: (design.pcbSpec.pour && design.pcbSpec.pour.net) || 'GND',
      netWidths: design.netWidths || {},
      // The mode is a fact, not a guess: this build either laid routing or it
      // did not. D004/D006 (connectivity + pour promises) only apply to a
      // routed board; judging a placement-only deliverable by them would flag
      // copper that was never promised.
      placedOnly: !doRoute,
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
    for (const i of routed.issues) console.log(`  ! ${i}`);
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
    + `lint ${lint.score}/100${drc ? `, drc ${drc.score}/100${doPcb && !doRoute && !doPour ? ' (placed-only)' : ''}` : ''}${extra.length ? `, ${extra.join(', ')}` : ''}.`);
}

main();
