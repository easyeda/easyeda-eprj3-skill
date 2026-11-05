'use strict';
/**
 * cli-lib.js — system-library geometry and instance placement through the CLI.
 *
 * 2.x rule: a library part is never downloaded as source text and spliced into
 * the project. The client owns the official symbol/footprint documents:
 *   - geometry for layout comes from lib_Symbol.getGeometry /
 *     lib_Footprint.getGeometry (structured, one call per part, made for
 *     external layout tools);
 *   - the INSTANCES are placed by the client itself:
 *       schematic  -> sch_SourcePrimitiveComponent.add
 *       PCB        -> pcb_Document.importChanges(schUuid, true): the client's
 *                     own "schematic → PCB" update creates every footprint and
 *                     links every pad net; the planned positions are then
 *                     applied with pcb_PrimitiveComponent.modify.
 *
 * The import is the same operation as the client's "导入更新" command, so the
 * resulting PCB netlist is complete by construction — no netlist comparison is
 * needed afterwards.
 *
 * Placement uses two headless sessions: one places the symbols (and saves), a
 * second reopens the project for the PCB import — the client only exposes
 * freshly placed primitives to its netlist engine after a reload. The DRC check
 * runs in its own session.
 */
const CLI = require('./cli');
const fs = require('fs');
const path = require('path');

const GEOMETRY_HELPER = `
async function try2(fn) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800)); }
  }
  throw last;
}
`;

// Shared readiness helpers: waitReady, pagesOf (schematic pages), pcbsOf (PCB
// documents). Every snippet that touches the editor waits for the project to
// load and polls the document tree until it is populated.
const READY_HELPER = `
async function waitReady() {
  try { await eda.dmt_Project.waitForReady(); } catch (e) { /* older builds */ }
}
async function pagesOf() {
  await waitReady();
  let p = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  for (let i = 0; i < 40 && (!Array.isArray(p) || !p.length); i += 1) { await new Promise((r) => setTimeout(r, 750)); p = await eda.dmt_Schematic.getAllSchematicPagesInfo(); }
  return p;
}
async function schsOf() {
  await waitReady();
  let s = await eda.dmt_Schematic.getAllSchematicsInfo();
  for (let i = 0; i < 40 && (!Array.isArray(s) || !s.length); i += 1) { await new Promise((r) => setTimeout(r, 750)); s = await eda.dmt_Schematic.getAllSchematicsInfo(); }
  return s;
}
async function pcbsOf() {
  await waitReady();
  let p = await eda.dmt_Pcb.getAllPcbsInfo();
  for (let i = 0; i < 40 && (!Array.isArray(p) || !p.length); i += 1) { await new Promise((r) => setTimeout(r, 750)); p = await eda.dmt_Pcb.getAllPcbsInfo(); }
  return p;
}
`;

/** Resolve device geometry for a batch of library references.
 *  requests: [{ key, name?, lcsc? }] -> [{key, name, uuid, libraryUuid,
 *  designator, symbol:{bbox,pins}, footprint:{bbox,pads}}] */
function resolveDevices(requests, opts) {
  const info = CLI.requireCli(opts);
  const session = CLI.openProject(info.bin, null);
  try {
    const code = `
${GEOMETRY_HELPER}
const sys = await eda.lib_LibrariesList.getSystemLibraryUuid();
await eda.lib_LibrariesList.getAllLibrariesList().catch(() => {});
try { await eda.lib_Device.searchByProperties({ supplierId: 'C7950' }, sys, undefined, undefined, 1, 1); } catch (e) { /* warm-up */ }
const reqs = __CLI__.args.reqs;
const out = [];
for (const r of reqs) {
  let items = [];
  if (r.lcsc) items = await try2(() => eda.lib_Device.searchByProperties({ supplierId: r.lcsc }, sys, undefined, undefined, 5, 1));
  if ((!items || !items.length) && r.name) items = await try2(() => eda.lib_Device.search(r.name, sys, undefined, undefined, 10, 1));
  const exact = (items || []).find((x) => String(x.name || '').toLowerCase() === String(r.name || '').toLowerCase());
  const d = exact || (items && items[0]) || null;
  if (!d) { out.push({ key: r.key, error: 'not found', name: r.name || r.lcsc }); continue; }
  const symUuid = (d.symbol && d.symbol.uuid) || d.symbolUuid;
  const fpUuid = (d.footprint && d.footprint.uuid) || d.footprintUuid;
  const sym = symUuid ? await try2(() => eda.lib_Symbol.getGeometry(symUuid, sys)) : null;
  const fp = fpUuid ? await try2(() => eda.lib_Footprint.getGeometry(fpUuid, sys)) : null;
  out.push({
    key: r.key,
    name: d.name,
    uuid: d.uuid,
    libraryUuid: sys,
    designator: (d.otherProperty && d.otherProperty.Designator) || 'U?',
    supplierId: (d.otherProperty && d.otherProperty['Supplier Part']) || d.supplierId || null,
    symbolName: d.symbolName || (d.symbol && d.symbol.name) || null,
    footprintName: d.footprintName || (d.footprint && d.footprint.name) || null,
    symbol: sym,
    footprint: fp
  });
}
return out;
`;
    return CLI.invoke(info.bin, session, code, { args: { reqs: requests }, timeout: Number((opts && opts.timeout) || 180000) });
  } finally {
    CLI.closeSession(info.bin, session);
  }
}

/** Split a plan into invocations small enough for a Windows command line
 *  (`--args` travels as an argument; large boards exceed ~32 KB). */
function chunkBySize(items, budget) {
  const out = [];
  let cur = [];
  let len = 2;
  for (const it of items || []) {
    const s = JSON.stringify(it).length;
    if (cur.length && len + s > budget) { out.push(cur); cur = []; len = 2; }
    cur.push(it);
    len += s + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

// A record whose body is empty carries no data, except NET: the file format
// keeps one empty NET record as a placeholder.
const SHELL_TYPES = new Set(['COMPONENT', 'ATTR', 'PAD_NET', 'RULE_SELECTOR']);

/** Drop the empty COMPONENT / ATTR / PAD_NET / RULE_SELECTOR records the
 *  client leaves behind when it deletes footprints on a schematic → PCB
 *  import (4.1.94). They are invisible in the editor but the netlist reader
 *  still counts their pads, so a stale PAD_NET turns into phantom pins.
 *  Returns the number of records removed. */
function stripEmptyShells(projectDir) {
  let removed = 0;
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) { visit(file); continue; }
      if (!/\.epcb2$/i.test(ent.name)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      const kept = [];
      for (const line of lines) {
        const sep = line.indexOf('||');
        if (sep > 0) {
          let head = null;
          try { head = JSON.parse(line.slice(0, sep)); } catch (e) { /* not a record head */ }
          const body = line.slice(sep + 2);
          if (head && SHELL_TYPES.has(head.type) && /^(\{\})?\|*$/.test(body)) {
            removed += 1;
            continue;
          }
        }
        kept.push(line);
      }
      if (kept.length !== lines.length) {
        fs.writeFileSync(file, kept.join('\n'), 'utf8');
      }
    }
  };
  visit(projectDir);
  return removed;
}

/** Rewrite the BOARD_OUTLINE rectangle in the project's main PCB document.
 *  Used after the client's auto layout when its arrangement needs more room
 *  than the planned outline (the engine may park a part just outside the
 *  board, which the DRC's edge rule rejects). Returns the number of files
 *  changed. */
function resizeBoardOutline(projectDir, rect) {
  let changed = 0;
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) { visit(file); continue; }
      if (!/\.epcb2$/i.test(ent.name)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      let hit = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const sep = line.indexOf('||');
        if (sep <= 0) continue;
        let head;
        try { head = JSON.parse(line.slice(0, sep)); } catch (e) { continue; }
        if (!head || head.type !== 'POLY') continue;
        let body;
        try { body = JSON.parse(line.slice(sep + 2).replace(/\|+$/, '')); } catch (e) { continue; }
        if (!body || body.polyType !== 'BOARD_OUTLINE') continue;
        body.path = ['R', rect.x, rect.y + rect.h, rect.w, rect.h, 0, 0];
        lines[i] = line.slice(0, sep + 2) + JSON.stringify(body) + '|';
        hit = true;
      }
      if (hit) {
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
        changed += 1;
      }
    }
  };
  visit(projectDir);
  return changed;
}

/** Place library instances in an EXISTING project (already on disk).
 *  - symbols: sch_SourcePrimitiveComponent.add, per size-bounded batch;
 *  - PCB: importChanges(force) once, then planned positions per batch. */
function placeInstances(projectDir, placement, opts) {
  const info = CLI.requireCli(opts);
  const results = {
    symbols: [],
    flags: [],
    wires: [],
    footprints: [],
    imported: false,
    importError: null,
    schematicParts: 0,
    removed: 0,
    missing: [],
    moved: 0,
    shellsRemoved: 0,
    batches: 0,
    layout: null
  };
  const timeout = Number((opts && opts.timeout) || 600000);

  // Phase 1 — place the official symbols and draw the wiring through the
  // source API, then save. The client only exposes these source edits to its
  // netlist engine after the project is (re)loaded, so the PCB import gets a
  // fresh session in phase 2.
  if ((placement.sch || []).length || (placement.flagPlan || []).length
    || (placement.wirePlan || []).length) {
    const session = CLI.openProject(info.bin, projectDir);
    try {
      for (const chunk of chunkBySize(placement.sch || [], 9000)) {
        const res = CLI.invoke(info.bin, session, PLACE_SYMBOLS, {
          args: { plan: { sch: chunk } },
          timeout
        });
        results.symbols.push(...((res && res.symbols) || []));
        results.batches += 1;
      }
      // flags and ports first: they name the nets the wires connect to
      for (const chunk of chunkBySize(placement.flagPlan || [], 9000)) {
        const fl = CLI.invoke(info.bin, session, ADD_FLAGS, {
          args: { plan: { schematicName: placement.schematicName, flags: chunk } },
          timeout
        });
        results.flags.push(...((fl && fl.flags) || []));
        results.batches += 1;
      }
      for (const chunk of chunkBySize(placement.wirePlan || [], 9000)) {
        const wr = CLI.invoke(info.bin, session, DRAW_WIRES, {
          args: { plan: { schematicName: placement.schematicName, wires: chunk } },
          timeout
        });
        results.wires.push(...((wr && wr.wires) || []));
        results.batches += 1;
      }
    } finally {
      CLI.closeSession(info.bin, session);
    }
  }

  // Phase 2 — let the client build the PCB from the schematic and apply the
  // planned positions.
  if ((placement.pcbPlan || []).length) {
    const session = CLI.openProject(info.bin, projectDir);
    try {
      if ((placement.pcbPlan || []).length) {
        const imp = CLI.invoke(info.bin, session, IMPORT_PCB, {
        args: {
          plan: {
            schematicName: placement.schematicName,
            designators: placement.pcbPlan.map((p) => p.designator),
            expectedParts: placement.pcbPlan.length
          }
        },
        timeout
      });
      results.imported = !!(imp && imp.imported);
      results.importError = (imp && imp.importError) || null;
      results.schematicParts = (imp && imp.schematicParts) || 0;
      results.removed = (imp && imp.removed) || 0;
      results.missing = (imp && imp.missing) || [];
      results.batches += 1;

      for (const chunk of chunkBySize(placement.pcbPlan, 9000)) {
        const mv = CLI.invoke(info.bin, session, MOVE_FOOTPRINTS, {
          args: { moves: chunk },
          timeout
        });
        results.moved += (mv && mv.moved) || 0;
        results.footprints.push(...((mv && mv.footprints) || []));
        results.batches += 1;
      }
      // Client auto layout: the board outline exists and every footprint is
      // imported, so hand the board to the client's own layout engine (the
      // same command as the UI's "auto layout"). The planned positions above
      // stay as the fallback when the engine is missing or fails.
      if (placement.autoLayout) {
        try {
          results.layout = CLI.invoke(info.bin, session, AUTO_LAYOUT, { timeout });
        } catch (e) {
          results.layout = { ok: false, error: String(e && e.message || e) };
        }
        results.batches += 1;
      }
      }
    } finally {
      CLI.closeSession(info.bin, session);
    }
    // Safety net for the fallback path above (a pre-existing board whose
    // footprints had to be deleted): the client leaves empty shells behind.
    results.shellsRemoved = stripEmptyShells(projectDir);
  }
  return results;
}

const DRAW_WIRES = `
${READY_HELPER}
const plan = __CLI__.args.plan;
const schs = await schsOf();
const projectId = schs[0].parentProjectUuid;
const sch = schs.find((x) => x.name === plan.schematicName) || schs[0];
const out = { wires: [] };
for (const w of plan.wires || []) {
  for (const pts of w.chains || []) {
    const line = [];
    for (let i = 0; i + 1 < pts.length; i += 2) line.push([pts[i], pts[i + 1]]);
    if (line.length < 2) continue;
    try {
      const opts = { projectId, schematicName: sch.name, pageName: w.pageName, line };
      if (w.net) opts.net = w.net;
      const r = await eda.sch_SourcePrimitiveWire.add(opts);
      out.wires.push({ net: w.net, ok: !!(r && r.ok !== false), id: r && r.value && r.value.primitiveId });
      if (!r || r.ok === false) out.wires[out.wires.length - 1].error = r && r.error;
    } catch (e) {
      out.wires.push({ net: w.net, ok: false, error: String(e && e.message || e) });
    }
  }
}
await eda.sch_Document.save().catch(() => {});
return out;
`;

const ADD_FLAGS = `
${READY_HELPER}
const plan = __CLI__.args.plan;
const schs = await schsOf();
const projectId = schs[0].parentProjectUuid;
const sch = schs.find((x) => x.name === plan.schematicName) || schs[0];
const out = { flags: [] };
for (const f of plan.flags || []) {
  try {
    const r = await eda.sch_SourcePrimitiveComponent.addNetFlag({
      projectId,
      schematicName: sch.name,
      pageName: f.pageName,
      type: f.type || 'Power',
      net: f.net,
      x: f.x,
      y: f.y,
      rotation: f.rotation || 0
    });
    out.flags.push({ net: f.net, ok: !!(r && r.ok !== false), id: r && r.value && r.value.primitiveId });
    if (!r || r.ok === false) out.flags[out.flags.length - 1].error = r && r.error;
  } catch (e) {
    out.flags.push({ net: f.net, ok: false, error: String(e && e.message || e) });
  }
}
await eda.sch_Document.save().catch(() => {});
return out;
`;

const PLACE_SYMBOLS = `
${READY_HELPER}
const plan = __CLI__.args.plan;
const out = { symbols: [] };
const pages = await pagesOf();
const schs = await schsOf();
const projectId = schs[0].parentProjectUuid;
const sys = await eda.lib_LibrariesList.getSystemLibraryUuid();
for (const s of plan.sch || []) {
  const page = pages.find((p) => p.name === s.pageName) || pages.find((p) => (p.parentSchematicUuid || '') === s.schematicUuid) || pages[0];
  const sch = schs.find((x) => x.name === s.schematicName) || schs[0];
  try {
    const r = await eda.sch_SourcePrimitiveComponent.add({
      projectId,
      schematicName: sch.name,
      pageName: page.name,
      libraryUuid: s.libraryUuid || sys,
      name: s.deviceName,
      x: s.x, y: s.y,
      designator: s.designator,
      rotation: s.rotation || 0
    });
    out.symbols.push({ ref: s.designator, ok: !!(r && r.ok !== false), id: r && r.primitiveId });
    if (!r || r.ok === false) out.symbols[out.symbols.length - 1].error = r && r.error;
  } catch (e) {
    out.symbols.push({ ref: s.designator, ok: false, error: String(e && e.message || e) });
  }
}
// the import reads the schematic source: persist the symbols first
await eda.sch_Document.save().catch(() => {});
return out;
`;

const IMPORT_PCB = `
${READY_HELPER}
const plan = __CLI__.args.plan;
const out = { imported: false, removed: 0, schematicParts: 0 };

// The import reads what the client has loaded, so make sure every schematic
// page is open and its netlist sees all components before asking for the
// update (freshly placed library symbols become visible asynchronously).
const pages = await pagesOf();
for (const p of pages) {
  await eda.dmt_EditorControl.openDocument(p.uuid);
  await new Promise((r) => setTimeout(r, 400));
}
if (pages.length) await eda.dmt_EditorControl.openDocument(pages[pages.length - 1].uuid);
await new Promise((r) => setTimeout(r, 900));
for (let i = 0; i < 20; i += 1) {
  try {
    const f = await eda.sch_ManufactureData.getNetlistFile('sch', 'JLCEDA');
    if (f) {
      const raw = JSON.parse(await f.text());
      const refs = new Set(Object.values(raw.components || {}).map((c) => c.props && c.props.Designator).filter(Boolean));
      out.schematicParts = refs.size;
      if (refs.size >= (plan.expectedParts || 0)) break;
    }
  } catch (e) { /* retry */ }
  await new Promise((r) => setTimeout(r, 700));
}

const pcbs = await pcbsOf();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 1500));
// Drop the skill's own footprint instances first: the import then takes its
// clean "create from schematic" path. (Updating the pre-placed instances in
// place leaves a few multi-part footprints out on 4.1.94.) PCB-only parts that
// are not in the schematic keep their instances.
const planned = new Set((plan.designators || []).map(String));
const comps = await eda.pcb_PrimitiveComponent.getAll();
const stale = comps
  .filter((c) => {
    const ref = c.getState_Designator ? c.getState_Designator() : null;
    return ref && planned.has(String(ref));
  })
  .map((c) => (c.getState_PrimitiveId ? c.getState_PrimitiveId() : null))
  .filter(Boolean);
if (stale.length) {
  await eda.pcb_PrimitiveComponent.delete(stale);
  out.removed = stale.length;
}
await eda.pcb_Document.save();
await new Promise((r) => setTimeout(r, 800));
const schs = await schsOf();
const sch = schs.find((x) => x.name === plan.schematicName) || schs[0];
try {
  out.imported = await eda.pcb_Document.importChanges(sch.uuid, true);
} catch (e) {
  out.importError = String(e && e.message || e);
}
await new Promise((r) => setTimeout(r, 1200));
// The import commits asynchronously inside the client: poll until every
// planned designator is visible (or give up after 20 s and report).
const deadline = Date.now() + 20000;
out.missing = [];
for (;;) {
  const all = await eda.pcb_PrimitiveComponent.getAll();
  const have = new Set(all.map((c) => (c.getState_Designator ? String(c.getState_Designator()) : '')).filter(Boolean));
  out.missing = (plan.designators || []).filter((d) => !have.has(String(d)));
  if (!out.missing.length || Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 600));
}
await eda.pcb_Document.save();
return out;
`;

const MOVE_FOOTPRINTS = `
${READY_HELPER}
const pcbs = await pcbsOf();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 800));
const comps = await eda.pcb_PrimitiveComponent.getAll();
const byRef = new Map();
for (const c of comps) {
  const ref = c.getState_Designator ? c.getState_Designator() : null;
  if (ref) byRef.set(String(ref), c);
}
const out = { moved: 0, footprints: [] };
for (const p of __CLI__.args.moves || []) {
  const c = byRef.get(String(p.designator));
  const id = c && c.getState_PrimitiveId ? c.getState_PrimitiveId() : null;
  if (!id) {
    out.footprints.push({ ref: p.designator, ok: false, error: 'not in the PCB after import' });
    continue;
  }
  try {
    await eda.pcb_PrimitiveComponent.modify(id, { x: p.x, y: p.y, rotation: p.rotation || 0 });
    out.moved += 1;
    out.footprints.push({ ref: p.designator, ok: true, id });
  } catch (e) {
    out.footprints.push({ ref: p.designator, ok: false, error: String(e && e.message || e) });
  }
}
await eda.pcb_Document.save();
return out;
`;

/** Run the client's PCB auto layout on an imported board.
 *  The footprint positions from the offline placer are the fallback: if the
 *  engine is unavailable or reports a failure the board keeps them. */
const AUTO_LAYOUT = `
${READY_HELPER}
const pcbs = await pcbsOf();
if (!pcbs.length) return { ok: false, error: 'no PCB in this project' };
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 1200));
const out = {
  pcb: pcbs[0].name, ok: false, started: false, durationMs: null,
  successComponents: null, totalComponents: null, failed: null,
  error: null, saved: false
};
const engine = eda.pcb_Document && eda.pcb_Document.autoLayout;
if (typeof engine !== 'function') {
  out.error = 'pcb_Document.autoLayout is not available in this client build';
  return out;
}
try {
  const r = await engine.call(eda.pcb_Document);
  out.started = true;
  if (r && typeof r === 'object') {
    out.ok = r.success !== false;
    if (!out.ok) out.error = 'auto layout reported failure';
    if (typeof r.duration === 'number') out.durationMs = r.duration;
    if (typeof r.successComponentsCount === 'number') out.successComponents = r.successComponentsCount;
    if (typeof r.totalComponentsCount === 'number') out.totalComponents = r.totalComponentsCount;
    if (Array.isArray(r.failedComponents)) out.failed = r.failedComponents.length;
  } else {
    out.ok = !!r;
  }
} catch (e) {
  out.error = String(e && e.message || e);
}
// the engine commits asynchronously; give it a moment before persisting
await new Promise((r) => setTimeout(r, 2000));
// read the arranged positions: the build grows the board outline when the
// engine's layout needs more room than the planned outline
try {
  const comps = await eda.pcb_PrimitiveComponent.getAll();
  out.components = comps.map((c) => ({
    designator: c.getState_Designator ? c.getState_Designator() : null,
    x: c.getState_X ? c.getState_X() : null,
    y: c.getState_Y ? c.getState_Y() : null,
    rotation: c.getState_Rotation ? c.getState_Rotation() : 0
  })).filter((c) => c.designator && typeof c.x === 'number' && typeof c.y === 'number');
} catch (e) { out.components = []; }
try { await eda.pcb_Document.save(); out.saved = true; } catch (e) { /* save error is not fatal */ }
return out;
`;

/** Run the client's schematic DRC on an existing project.
 *  Returns {passed, counts, violations} — violations keep rule / net / the
 *  primitives (designator, pin name, sheet) needed for a fix. */
function schDrc(projectDir, opts) {
  const info = CLI.requireCli(opts);
  const session = CLI.openProject(info.bin, projectDir);
  try {
    return CLI.invoke(info.bin, session, SCH_DRC, {
      timeout: Number((opts && opts.timeout) || 180000)
    });
  } finally {
    CLI.closeSession(info.bin, session);
  }
}

const SCH_DRC = `
${READY_HELPER}
const pages = await pagesOf();
for (const p of pages) {
  await eda.dmt_EditorControl.openDocument(p.uuid);
  await new Promise((r) => setTimeout(r, 300));
}
if (pages.length) await eda.dmt_EditorControl.openDocument(pages[pages.length - 1].uuid);
await new Promise((r) => setTimeout(r, 900));
let raw;
try {
  raw = await eda.sch_Drc.check(true, false, true);
} catch (e) {
  return { error: String(e && e.message || e) };
}
const arr = Array.isArray(raw) ? raw : [];
const counts = { fatalError: 0, error: 0, warn: 0 };
const violations = [];
for (const v of arr) {
  if (typeof v === 'string') {
    counts.error += 1;
    violations.push({ type: 'error', rule: null, net: null, message: v, primitives: [] });
    continue;
  }
  const type = v.type || 'error';
  counts[type] = (counts[type] || 0) + 1;
  violations.push({
    type,
    rule: v.rule || null,
    net: v.net || null,
    primitives: (v.primitives || []).map((p) => ({
      name: p.name || null,
      designator: p.designator || null,
      sheet: p.sheet || null,
      id: p.primitiveId || null
    }))
  });
}
return { passed: counts.fatalError === 0 && counts.error === 0, counts, violations };
`;

module.exports = { resolveDevices, placeInstances, schDrc, stripEmptyShells, resizeBoardOutline };

