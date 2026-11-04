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
 *       PCB        -> pcb_PrimitiveComponent.create (+ modify for
 *                     designator/position, PCB_PrimitivePad.modify for nets)
 *   - wires/labels are drawn with the sch_SourcePrimitive* APIs.
 *
 * Everything runs inside one headless CLI session per batch.
 */
const CLI = require('./cli');

const GEOMETRY_HELPER = `
async function try2(fn) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800)); }
  }
  throw last;
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

/** Place library instances in an EXISTING project (already on disk).
 *  The plan travels through `--args`, and Windows caps a command line at
 *  ~32 KB, so large boards are split into size-bounded batches. */
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

function placeInstances(projectDir, placement, opts) {
  const info = CLI.requireCli(opts);
  const session = CLI.openProject(info.bin, projectDir);
  const results = { symbols: [], footprints: [], batches: 0 };
  try {
    const schChunks = chunkBySize(placement.sch || [], 9000);
    const pcbChunks = chunkBySize(placement.pcb || [], 9000);
    const batches = Math.max(schChunks.length, pcbChunks.length, 1);
    for (let i = 0; i < batches; i += 1) {
      const plan = { sch: schChunks[i] || [], pcb: pcbChunks[i] || [] };
      const res = CLI.invoke(info.bin, session, PLACE_SNIPPET, { args: { plan }, timeout: Number((opts && opts.timeout) || 600000) });
      results.symbols.push(...((res && res.symbols) || []));
      results.footprints.push(...((res && res.footprints) || []));
      results.batches += 1;
    }
    return results;
  } finally {
    CLI.closeSession(info.bin, session);
  }
}

const PLACE_SNIPPET = `
${GEOMETRY_HELPER}
async function waitReady() {
  try { await eda.dmt_Project.waitForReady(); } catch (e) { /* older builds */ }
}
async function pagesOf() {
  await waitReady();
  let p = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  for (let i = 0; i < 40 && (!Array.isArray(p) || !p.length); i += 1) { await new Promise((r) => setTimeout(r, 750)); p = await eda.dmt_Schematic.getAllSchematicPagesInfo(); }
  return p;
}
async function pcbsOf() {
  await waitReady();
  let p = await eda.dmt_Pcb.getAllPcbsInfo();
  for (let i = 0; i < 40 && (!Array.isArray(p) || !p.length); i += 1) { await new Promise((r) => setTimeout(r, 750)); p = await eda.dmt_Pcb.getAllPcbsInfo(); }
  return p;
}
const plan = __CLI__.args.plan;
const out = { symbols: [], footprints: [] };

if ((plan.sch || []).length) {
  const pages = await pagesOf();
  const schs = await eda.dmt_Schematic.getAllSchematicsInfo();
  const projectId = schs[0].parentProjectUuid;
  const sys = await eda.lib_LibrariesList.getSystemLibraryUuid();
  for (const s of plan.sch) {
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
}

if ((plan.pcb || []).length) {
  const pcbs = await pcbsOf();
  await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
  await new Promise((r) => setTimeout(r, 1500));
  const sys = await eda.lib_LibrariesList.getSystemLibraryUuid();
  for (const p of plan.pcb) {
    try {
      const comp = await eda.pcb_PrimitiveComponent.create({ libraryUuid: p.libraryUuid || sys, uuid: p.deviceUuid }, 1, p.x, p.y, p.rotation || 0, false);
      const id = comp && comp.getState_PrimitiveId && comp.getState_PrimitiveId();
      if (id && (p.designator || p.name)) {
        await eda.pcb_PrimitiveComponent.modify(id, { designator: p.designator || null });
      }
      let pins = [];
      try { pins = (await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || []; } catch (e) { /* no pad list */ }
      for (const pad of pins) {
        const num = pad.getState_PadNumber ? String(pad.getState_PadNumber()) : null;
        const net = num && p.nets ? p.nets[num] : null;
        const pid = pad.getState_PrimitiveId ? pad.getState_PrimitiveId() : null;
        if (pid && net) { try { await eda.pcb_PrimitivePad.modify(pid, { net }); } catch (e) { /* keep going */ } }
      }
      out.footprints.push({ ref: p.designator, ok: !!id, id });
    } catch (e) {
      out.footprints.push({ ref: p.designator, ok: false, error: String(e && e.message || e) });
    }
  }
  await eda.pcb_Document.save();
}

await eda.sch_Document.save().catch(() => {});
return out;
`;

module.exports = { resolveDevices, placeInstances };
