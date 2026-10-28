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
const FA = require('./lib/fp-auto');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory to create', required: true },
  { name: 'design', desc: 'design.json file', required: true },
  { name: 'force', desc: 'overwrite an existing project (deletes skill-owned files only)', hasValue: false },
  { name: 'schematic-only', desc: 'skip the PCB entirely', hasValue: false },
  { name: 'allow-erc', desc: 'do not fail the build on ERC errors', hasValue: false },
  { name: 'allow-intent', desc: 'do not fail the build on design-intent errors', hasValue: false },
  { name: 'allow-lint', desc: 'do not fail the build on layout errors', hasValue: false },
  { name: 'allow-drc', desc: 'do not fail the build on DRC errors', hasValue: false },
  { name: 'dry-run', desc: 'build into a throwaway directory, report, then delete it', hasValue: false },
  { name: 'report', desc: 'write the machine-readable build report to this file' },
  { name: 'plan', desc: 'print what would be built (parts, nets, rules, intent gate) and write nothing', hasValue: false },
  { name: 'quiet', desc: 'only print the final summary line', hasValue: false },
  { name: 'no-tidy', desc: 'keep declared rotations (skip the sch-tidy orientation pass)', hasValue: false },
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
  const design = D.readDesign(path.resolve(opts.design));
  const declaredW = design.board.width;   // declared size, for the --plan blow-up check
  const declaredH = design.board.height;
  const doPcb = !opts['schematic-only'] && !design.skipPcb;
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
  // one sheet document per page: page 1 keeps the declared sheet name,
  // pages 2+ are P2/P3/…
  const sheetDocs = new Map();
  for (let s = 1; s <= design.sheets; s += 1) {
    sheetDocs.set(s, project.ensureSheetDocument(design.schematic, s === 1 ? design.sheet : `P${s}`));
  }
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
    console.log(`  规模  ${design.parts.length} parts · ${nets.length} nets · ${(design.blocks || []).length} blocks · ${design.sheets} 原理图页`);
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
  // Two-pass layout: pass 1 places everything, sch-tidy decides each symbol's
  // rotation from the net geometry (the human way — AI supplies rough
  // positions, the algorithm finishes orientation), pass 2 re-lays-out with
  // the improved rotations. --no-tidy keeps the declared rotations.
  let { placements, blocks } = D.layoutSchematic(design, lib);
  if (!opts['no-tidy']) {
    const T = require('./lib/sch-tidy');
    const tidy = T.tidyRotations(design, lib, placements);
    if (tidy.rotated.length) {
      ({ placements, blocks } = D.layoutSchematic(design, lib));
      log(`sch-tidy: rotated ${tidy.rotated.length} part(s) onto their signal axes (${tidy.rotated.slice(0, 8).join(' ')}${tidy.rotated.length > 8 ? ' …' : ''})`);
    }
  }
  const routed = R.routeSchematic(design, placements);

  // one emitter per sheet; blocks/components/flags/ports/wires land on the
  // sheet their block was assigned to
  const emitters = new Map();
  for (let s = 1; s <= design.sheets; s += 1) emitters.set(s, new Emitter(sheetDocs.get(s).file));

  // block frames first (lowest z, so components draw on top) + the block's
  // one-line functional description under its title
  for (const b of blocks) {
    const em = emitters.get(b.sheet);
    em.addLines([E.schRectLine({
      x1: b.rect.x1, y1: b.rect.y1, x2: b.rect.x2, y2: b.rect.y2,
      zIndex: em.nextZ(), ticketBase: em.nextTicket()
    })]);
    em.addLines([E.schTextLine({
      x: b.rect.x1 + 10, y: b.rect.y2 - 30,
      value: b.title, fontSize: 14,
      zIndex: em.nextZ(), ticketBase: em.nextTicket()
    })]);
    if (b.desc) {
      em.addLines([E.schTextLine({
        x: b.rect.x1 + 10, y: b.rect.y2 - 48,
        value: b.desc, fontSize: 9,
        zIndex: em.nextZ(), ticketBase: em.nextTicket()
      })]);
    }
  }

  for (const pl of placements) placeSchematicComponent(emitters.get(pl.sheet || 1), project, pl, lib);

  const powerEntries = new Map();
  for (const flag of routed.flags) {
    if (!powerEntries.has(flag.net)) {
      const entry = require('./lib/entries').buildPowerEntry(project, flag.net, flag.style);
      project.saveLibrary(entry);
      powerEntries.set(flag.net, entry);
    }
    placePowerFlag(emitters.get(flag.sheet || 1), project, flag, powerEntries.get(flag.net));
  }

  // cross-sheet nets: a net port on each sheet it touches (netlist merges
  // port names globally, so both sides connect without wires)
  const portEntries = new Map();
  for (const port of routed.ports) {
    if (!portEntries.has(port.net)) {
      const entry = require('./lib/entries').buildPortEntry(project, port.net, `PORT_${port.net}`);
      project.saveLibrary(entry);
      portEntries.set(port.net, entry);
    }
    placeNetPort(emitters.get(port.sheet || 1), project, port, portEntries.get(port.net));
  }

  for (const w of routed.wires) {
    const em = emitters.get(w.sheet || 1);
    const block = E.wireBlock({
      segs: w.segs.map((s) => ({ startX: s.x1, startY: s.y1, endX: s.x2, endY: s.y2 })),
      net: w.net,
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
  let ratNets = [];
  if (doPcb) {
    const { planPcb } = require('./lib/pcb-plan');
    // Board size settles here: an explicit `board` is honoured as a floor and
    // grown if the placer needs more; an UNDECLARED board shrinks/grows to
    // exactly fit the parts (required already carries the edge margin), so a
    // 3-part board no longer ships on a 1600×1000 mil blank. Iterates because
    // resizing the board can re-trigger row wrapping, which changes `required`
    // again; it stabilises after at most a couple of rounds.
    const MIN_W = 400;
    const MIN_H = 300;
    let plan = planPcb(design, lib, placements);
    for (let round = 0; round < 4; round += 1) {
      const targetW = Math.max(design.boardDeclared ? design.board.width : 0, plan.required.width, MIN_W);
      const targetH = Math.max(design.boardDeclared ? design.board.height : 0, plan.required.height, MIN_H);
      if (targetW === design.board.width && targetH === design.board.height) break;
      log(`board set to ${targetW}×${targetH} mil to fit ${design.parts.length} parts`
        + (design.boardDeclared ? ' (declared size kept as a floor)' : ' (auto-fit)'));
      design.board.width = targetW;
      design.board.height = targetH;
      E.updateRecord(pcbDoc.file,
        (r) => r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE',
        (r) => { r.body.path = E.rectPath(0, 0, targetW, targetH); });
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
    log(`  rats: ${ratNets.length} net(s) to connect by hand in the client — ${ratNets.map(([n, c]) => `${n}(${c}p)`).join(' ') || 'none'}`);
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
    pcb: { parts: pcbParts.length, mode: doPcb ? 'placed-only' : null, rats: ratNets.length },
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

  // Schematic ↔ PCB netlist comparison (netcheck): independent pin-by-pin
  // diff of both netlists — the explicit cross-check that the two documents
  // agree. Full detail in report.netcheck; `scripts/netcheck.js` re-runs it
  // standalone (e.g. after hand edits in the client).
  let netcheck = null;
  if (doPcb) {
    const NC = require('./lib/netcheck');
    netcheck = NC.compare(require('./lib/netlist').projectNetlist(dir));
    report.netcheck = { match: netcheck.match, summary: netcheck.summary, issues: netcheck.issues };
  }

  // Fifth gate: design intent (polarity, decoupling, declared pairs, ranges).
  // It fails the build like the others; --allow-intent skips it. Polarity
  // marks are checked even without an `expect` block — that is the promise in
  // docs/build.md, and the one gate that catches a reversed LED/diode.
  let intent = null;
  if (design.expect || design.parts.some((p) => p.polarity)) {
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
    if (netcheck) {
      console.log(netcheck.match
        ? `netcheck: OK — schematic ↔ PCB netlists match (${netcheck.summary.schematic.pins} pins)`
        : `netcheck: ${netcheck.issues.length} mismatch(es) — run scripts/netcheck.js --dir ${dir} for the full diff`);
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
