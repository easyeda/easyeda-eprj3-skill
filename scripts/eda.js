#!/usr/bin/env node
'use strict';
/**
 * eda.js — the 2.x CLI-first toolbox.
 *
 * Every command opens the project in the LCEDA Pro / EasyEDA Pro client
 * (headless), runs client-side source/auto APIs inside the editor command
 * space, and prints one JSON envelope. The model calls these scripts; it does
 * not write JS itself.
 *
 *   node scripts/eda.js doctor
 *   node scripts/eda.js search --q "ESP32-S3" [--limit 10] [--page 1]
 *   node scripts/eda.js search --lcsc C2913202
 *   node scripts/eda.js netlist --dir <project> --out netlist.json
 *   node scripts/eda.js check-net --dir <project> [--out diff.json]
 *   node scripts/eda.js screenshot --dir <project> --out <dir> [--doc sch|pcb] [--page 1]
 *   node scripts/eda.js pcb --dir <project> [--clear] [--layout] [--route] [--no-save] [--timeout 900000]
 *   node scripts/eda.js pour --dir <project> --net GND --outline x1,y1,x2,y2 (PCB data units, mil) [--layers 1,2] [--no-save]
 *
 * Requires the client V4.1.94+ (source APIs 4.1.83+). `--cli <path>` overrides
 * discovery; `LCEDA_PRO_CLI` / `EASYEDA_PRO_CLI` env vars also work.
 */
const fs = require('fs');
const path = require('path');
const CLI = require('./lib/cli');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

function fail(code, message, extra) {
  process.stdout.write(`${JSON.stringify(Object.assign({ ok: false, error: { code, message } }, extra || {}), null, 2)}\n`);
  process.exitCode = 1;
}

function print(value, extra) {
  process.stdout.write(`${JSON.stringify(Object.assign({ ok: true, value }, extra || {}), null, 2)}\n`);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Run the command with an open session; always closes the session. */
function withProject(args, fn) {
  const info = CLI.requireCli({ cli: args.cli });
  const dir = args.dir;
  if (!dir) throw new Error('--dir <project folder> is required');
  const session = CLI.openProject(info.bin, dir);
  try {
    return fn(info, session);
  } finally {
    if (!args.keep) CLI.closeSession(info.bin, session);
  }
}

// ------------------------------------------------------------------ snippets
const READY_HELPER = `
async function waitReady() {
  try { await eda.dmt_Project.waitForReady(); } catch (e) { /* older builds */ }
}
async function pagesOf() {
  await waitReady();
  let pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  for (let i = 0; i < 40 && (!Array.isArray(pages) || pages.length === 0); i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  }
  if (!Array.isArray(pages) || !pages.length) throw new Error('schematic pages unavailable (project not loaded?)');
  return pages;
}
async function pcbsOf() {
  await waitReady();
  let pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
  for (let i = 0; i < 40 && (!Array.isArray(pcbs) || pcbs.length === 0); i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
  }
  if (!Array.isArray(pcbs) || !pcbs.length) throw new Error('PCB list unavailable (project not loaded?)');
  return pcbs;
}
`;

const OPEN_ALL_PAGES = `
${READY_HELPER}
const pages = await pagesOf();
const opened = [];
for (const p of pages) {
  const tab = await eda.dmt_EditorControl.openDocument(p.uuid);
  opened.push({ name: p.name, uuid: p.uuid, tab });
  await new Promise((r) => setTimeout(r, 600));
}
return { pages: pages.map((p) => ({ name: p.name, uuid: p.uuid, parent: p.parentSchematicUuid })), opened };
`;

function b64Tail(varName) {
  return `
const __buf = new Uint8Array(await ${varName}.arrayBuffer());
let __bin = '';
const __CH = 0x8000;
for (let i = 0; i < __buf.length; i += __CH) {
  __bin += String.fromCharCode.apply(null, __buf.subarray(i, i + __CH));
}
return { name: ${varName}.name || null, size: ${varName}.size, base64: btoa(__bin) };
`;
}

function pageScreenshotSnippet(pageIndex) {
  return `
${READY_HELPER}
const pages = await pagesOf();
const p = pages[${pageIndex === null ? 0 : pageIndex}];
if (!p) throw new Error('no schematic page');
await eda.dmt_EditorControl.openDocument(p.uuid);
await new Promise((r) => setTimeout(r, 1200));
const f = await eda.sch_ManufactureData.getPngFile(p.name || 'page');
if (!f) throw new Error('getPngFile returned no file');
${b64Tail('f')}`;
}

function pcbScreenshotSnippet() {
  return `
${READY_HELPER}
const pcbs = await pcbsOf();
if (!pcbs.length) throw new Error('no PCB in this project');
const tab = await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 1200));
try { await eda.pcb_Document.zoomToBoardOutline(); } catch (e) { /* keep current view */ }
await new Promise((r) => setTimeout(r, 900));
const img = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tab);
if (!img) throw new Error('getCurrentRenderedAreaImage returned nothing');
${b64Tail('img')}`;
}

// ------------------------------------------------------------------- netlist
function refKey(ref) {
  const m = /^([A-Za-z_]+)(\d+)/.exec(ref || '');
  return m ? [m[1], Number(m[2]), ref] : [ref || '', 0, ref || ''];
}

function simplifyNetlist(raw) {
  const parts = [];
  const nets = new Map();
  const byRef = new Map();
  for (const [uid, c] of Object.entries((raw && raw.components) || {})) {
    const p = c.props || {};
    const ref = p.Designator || p['Designator'] || null;
    if (!ref) continue;
    let part = byRef.get(ref);
    if (!part) {
      part = {
        ref,
        name: p.Name || null,
        device: p.DeviceName || null,
        footprint: p.FootprintName || null,
        pins: {}
      };
      byRef.set(ref, part);
      parts.push(part);
    } else if (!part.name && p.Name) {
      part.name = p.Name;
    }
    for (const [num, pin] of Object.entries(c.pinInfoMap || {})) {
      const net = pin.net || '';
      part.pins[num] = net;
      if (!net) continue;
      if (!nets.has(net)) nets.set(net, []);
      nets.get(net).push(`${ref}.${num}`);
    }
    void uid;
  }
  parts.sort((a, b) => {
    const ka = refKey(a.ref); const kb = refKey(b.ref);
    return ka[0] === kb[0] ? (ka[1] - kb[1]) : (ka[0] < kb[0] ? -1 : 1);
  });
  const netOut = {};
  for (const name of [...nets.keys()].sort()) netOut[name] = nets.get(name).sort();
  return {
    version: raw && raw.version ? raw.version : null,
    projectId: raw && raw.projectId ? raw.projectId : null,
    parts,
    nets: netOut,
    stats: {
      parts: parts.length,
      pins: parts.reduce((n, p) => n + Object.keys(p.pins).length, 0),
      nets: Object.keys(netOut).length
    }
  };
}

// ------------------------------------------------------------------ commands
function cmdDoctor(args) {
  const bin = CLI.findCli(args.cli);
  if (!bin) return fail('CLI_NOT_FOUND', 'LCEDA Pro / EasyEDA Pro CLI not found. Install V4.1.94+ or set LCEDA_PRO_CLI.');
  const info = CLI.versionOf(bin);
  const doc = CLI.run(bin, ['doctor'], { timeout: 30000 });
  const ok = CLI.atLeast(info.version, args['min-version'] || CLI.MIN_VERSION);
  const value = {
    bin,
    version: info.version,
    rawVersion: info.raw,
    connected: !!(doc && doc.value && doc.value.connected),
    minVersion: args['min-version'] || CLI.MIN_VERSION,
    ok
  };
  if (!ok) return fail('CLI_VERSION_TOO_OLD', `client ${info.version || '(unknown)'} is below ${value.minVersion}`, { value });
  print(value);
}

function cmdSearch(args) {
  const info = CLI.requireCli({ cli: args.cli });
  const session = CLI.openProject(info.bin, args.dir || null);
  try {
    const limit = Number(args.limit) || 10;
    const page = Number(args['page']) || 1;
    const code = `
const sys = await eda.lib_LibrariesList.getSystemLibraryUuid();
// the library index initialises lazily: the first fuzzy search in a fresh
// session throws ("reading 'type' of null") and the next attempt succeeds.
// Warm it with a cheap property lookup, then retry the real query twice.
try { await eda.lib_LibrariesList.getAllLibrariesList(); } catch (e) { /* warm-up */ }
try { await eda.lib_Device.searchByProperties({ supplierId: 'C7950' }, sys, undefined, undefined, 1, 1); } catch (e) { /* warm-up */ }
async function try2(fn) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800)); }
  }
  throw last;
}
const pick = (d) => ({
  name: d.name,
  uuid: d.uuid,
  libraryUuid: d.libraryUuid || sys,
  supplierId: (d.otherProperty && d.otherProperty['Supplier Part']) || d.supplierId || null,
  manufacturer: (d.otherProperty && d.otherProperty.Manufacturer) || d.manufacturer || null,
  manufacturerPart: (d.otherProperty && d.otherProperty['Manufacturer Part']) || d.manufacturerId || null,
  symbolName: d.symbolName || (d.symbol && d.symbol.name) || null,
  footprintName: d.footprintName || (d.footprint && d.footprint.name) || null,
  description: d.description || ''
});
let items = [];
${args.lcsc
    ? `items = await try2(() => eda.lib_Device.searchByProperties({ supplierId: ${JSON.stringify(String(args.lcsc))} }, sys, undefined, undefined, ${limit}, 1));
if (!items.length) { const r = await try2(() => eda.lib_Device.getByLcscIds(${JSON.stringify(String(args.lcsc))}, sys, true)); items = Array.isArray(r) ? r : (r ? [r] : []); }`
    : `if (!${JSON.stringify(String(args.q || ''))}) throw new Error('--q <keyword> or --lcsc <Cxxxx> is required');
items = await try2(() => eda.lib_Device.search(${JSON.stringify(String(args.q || ''))}, sys, undefined, undefined, ${limit}, ${page}));`}
return { library: sys, count: items.length, items: items.map(pick) };
`;
    print(CLI.invoke(info.bin, session, code, { timeout: 60000 }));
  } finally {
    if (!args.keep) CLI.closeSession(info.bin, session);
  }
}

function cmdNetlist(args) {
  withProject(args, (info, session) => {
    CLI.invoke(info.bin, session, OPEN_ALL_PAGES, { timeout: 120000 });
    const code = `
${READY_HELPER}
const pages = await pagesOf();
if (!pages.length) throw new Error('project has no schematic page');
await eda.dmt_EditorControl.openDocument(pages[pages.length - 1].uuid);
await new Promise((r) => setTimeout(r, 800));
let f = null;
for (let i = 0; i < 6 && !f; i += 1) {
  try { f = await eda.sch_ManufactureData.getNetlistFile('netlist', 'JLCEDA'); } catch (e) { /* retry */ }
  if (!f) await new Promise((r) => setTimeout(r, 800));
}
if (!f) throw new Error('getNetlistFile returned nothing');
return { name: f.name, size: f.size, text: await f.text() };
`;
    const res = CLI.invoke(info.bin, session, code, { timeout: 180000 });
    let raw;
    try { raw = JSON.parse(res.text); } catch (e) {
      throw new Error(`netlist export is not JSON: ${String(res.text).slice(0, 200)}`);
    }
    const simple = simplifyNetlist(raw);
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(simple, null, 2)}\n`);
    }
    print(Object.assign({ out: args.out ? path.resolve(args.out) : null }, simple.stats));
  });
}

function cmdScreenshot(args) {
  withProject(args, (info, session) => {
    const outDir = path.resolve(args.out || path.join(args.dir, 'screenshots'));
    const doc = args.doc || 'sch';
    const written = [];
    if (doc === 'pcb') {
      const r = CLI.invoke(info.bin, session, pcbScreenshotSnippet(), { timeout: 120000 });
      const file = path.join(outDir, 'pcb.png');
      CLI.writeBase64(file, r.base64);
      written.push({ file, size: r.size });
    } else if (args.page) {
      const r = CLI.invoke(info.bin, session, pageScreenshotSnippet(Number(args.page) - 1), { timeout: 120000 });
      const file = path.join(outDir, `sch-${args.page}.png`);
      CLI.writeBase64(file, r.base64);
      written.push({ file, size: r.size });
    } else {
      const pages = CLI.invoke(info.bin, session,
        `${READY_HELPER}
const pages = await pagesOf(); return pages.map((p) => ({ name: p.name }));`,
        { timeout: 60000 });
      for (let i = 0; i < pages.length; i += 1) {
        const r = CLI.invoke(info.bin, session, pageScreenshotSnippet(i), { timeout: 120000 });
        const safe = String(pages[i].name || `page-${i + 1}`).replace(/[\\/:*?"<>|]+/g, '_');
        const file = path.join(outDir, `${safe}.png`);
        CLI.writeBase64(file, r.base64);
        written.push({ file, size: r.size });
      }
    }
    print({ dir: outDir, files: written });
  });
}

function cmdPcb(args) {
  withProject(args, (info, session) => {
    const timeout = Number(args.timeout) || 900000;
    const code = `
${READY_HELPER}
const pcbs = await pcbsOf();
if (!pcbs.length) throw new Error('no PCB in this project');
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 1200));
const out = { pcb: pcbs[0].name, cleared: false, layout: null, route: null, saved: false };
if (${!!args.clear}) { try { await eda.pcb_Document.clearRouting(); out.cleared = true; } catch (e) { out.clearErr = String(e && e.message || e); } }
if (${!!args.layout}) { try { out.layout = await eda.pcb_Document.autoLayout(); } catch (e) { out.layoutErr = String(e && e.message || e); } }
if (${!!args.route}) { try { out.route = await eda.pcb_Document.autoRouting(); } catch (e) { out.routeErr = String(e && e.message || e); } }
if (${!args['no-save']}) { await eda.pcb_Document.save(); out.saved = true; }
return out;
`;
    print(CLI.invoke(info.bin, session, code, { timeout }));
  });
}

function cmdPour(args) {
  withProject(args, (info, session) => {
    const net = args.net;
    if (!net) throw new Error('--net <name> is required');
    const box = String(args.outline || '').split(',').map(Number);
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) {
      throw new Error('--outline x1,y1,x2,y2 is required (PCB data units, mil in EasyEDA Pro)');
    }
    const layers = String(args.layers || '1,2').split(',').map(Number).filter((n) => Number.isFinite(n));
    const name = args.name || `${net} pour`;
    const code = `
${READY_HELPER}
const pcbs = await pcbsOf();
if (!pcbs.length) throw new Error('no PCB in this project');
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 1500));
const x1 = ${box[0]}, y1 = ${box[1]}, x2 = ${box[2]}, y2 = ${box[3]};
const w = x2 - x1, h = y2 - y1;
const out = { pours: [], saved: false };
for (const layer of ${JSON.stringify(layers)}) {
  const poly = eda.pcb_MathPolygon.createPolygon(['R', Math.min(x1, x2), Math.min(y1, y2), Math.abs(w), Math.abs(h), 0, 0]);
  const p = await eda.pcb_PrimitivePour.create(${JSON.stringify(net)}, layer, poly, 'solid', false, ${JSON.stringify(name)}, 5, 10, false);
  const id = p && p.getState_PrimitiveId && p.getState_PrimitiveId();
  const rec = { layer, id, filled: false };
  // a pour border alone is not copper: rebuildCopperRegion() computes the fill
  try {
    await new Promise((r) => setTimeout(r, 600));
    const border = await eda.pcb_PrimitivePour.get(id);
    const poured = border && border.rebuildCopperRegion ? await border.rebuildCopperRegion() : null;
    rec.filled = !!poured;
    if (poured && poured.getState_PrimitiveId) rec.pouredId = poured.getState_PrimitiveId();
  } catch (e) { rec.fillErr = String(e && e.message || e); }
  out.pours.push(rec);
}
if (${!args['no-save']}) { await eda.pcb_Document.save(); out.saved = true; }
return out;
`;
    print(CLI.invoke(info.bin, session, code, { timeout: Number(args.timeout) || 300000 }));
  });
}

function cmdCheckNet(args) {
  withProject(args, (info, session) => {
    const code = `
${READY_HELPER}
const pages = await pagesOf();
for (const p of pages) {
  await eda.dmt_EditorControl.openDocument(p.uuid);
  await new Promise((r) => setTimeout(r, 500));
}
await eda.dmt_EditorControl.openDocument(pages[pages.length - 1].uuid);
await new Promise((r) => setTimeout(r, 800));
async function netFile(fn) {
  let last;
  for (let i = 0; i < 6; i += 1) {
    try { const f = await fn(); if (f) return f; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (last) throw last;
  return null;
}
const sf = await netFile(() => eda.sch_ManufactureData.getNetlistFile('sch', 'JLCEDA'));
if (!sf) throw new Error('schematic netlist unavailable');
const schText = await sf.text();
const pcbs = await pcbsOf();
if (!pcbs.length) throw new Error('no PCB in this project');
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await new Promise((r) => setTimeout(r, 800));
const pf = await netFile(() => eda.pcb_ManufactureData.getNetlistFile('pcb', 'JLCEDA'));
if (!pf) throw new Error('PCB netlist unavailable');
return { schText, pcbText: await pf.text() };
`;
    const res = CLI.invoke(info.bin, session, code, { timeout: Number(args.timeout) || 300000 });
    const sch = simplifyNetlist(JSON.parse(res.schText));
    const pcb = simplifyNetlist(JSON.parse(res.pcbText));
    const mapOf = (s) => {
      const m = new Map();
      for (const p of s.parts) for (const [num, net] of Object.entries(p.pins)) m.set(`${p.ref}.${num}`, net || '');
      return m;
    };
    const a = mapOf(sch);
    const b = mapOf(pcb);
    const keys = new Set([...a.keys(), ...b.keys()]);
    const missing = [];   // on the schematic, absent on the PCB
    const extra = [];     // on the PCB, absent on the schematic
    const differ = [];
    for (const k of [...keys].sort()) {
      if (!b.has(k)) { missing.push(k); continue; }
      if (!a.has(k)) { extra.push(k); continue; }
      if (a.get(k) !== b.get(k)) differ.push({ pin: k, schematic: a.get(k), pcb: b.get(k) });
    }
    const match = missing.length === 0 && extra.length === 0 && differ.length === 0;
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(path.resolve(args.out), `${JSON.stringify({ match, summary: { schematic: sch.stats, pcb: pcb.stats }, missing, extra, differ }, null, 2)}\n`);
    }
    print({
      match,
      schematic: sch.stats,
      pcb: pcb.stats,
      missingPins: missing.length,
      extraPins: extra.length,
      netDiffs: differ.length,
      sample: { missing: missing.slice(0, 5), extra: extra.slice(0, 5), differ: differ.slice(0, 5) },
      out: args.out ? path.resolve(args.out) : null
    });
    if (!match) process.exitCode = 1;
  });
}

// --------------------------------------------------------------------- main
const COMMANDS = {
  doctor: cmdDoctor,
  search: cmdSearch,
  netlist: cmdNetlist,
  'check-net': cmdCheckNet,
  screenshot: cmdScreenshot,
  pcb: cmdPcb,
  pour: cmdPour
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || !COMMANDS[cmd]) {
    process.stderr.write(`usage: node scripts/eda.js <${Object.keys(COMMANDS).join('|')}> [options]\n`);
    process.exitCode = 2;
    return;
  }
  try {
    COMMANDS[cmd](args);
  } catch (e) {
    fail(e.code || 'EDA_CLI_ERROR', String(e && e.message || e), e.version ? { version: e.version } : undefined);
  }
}

main();
