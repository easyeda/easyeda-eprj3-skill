#!/usr/bin/env node
// audit3d.js — export the PCB STEP and run a true 3D component-vs-component
// collision audit. This complements 2D DRC: a board can pass DRC and still
// have a connector body intersect a tall part (easyeda-api-skill#30).
//
//   node scripts/audit3d.js --dir <project> [--pcb <title|file>] [--strict] [--json]
//
// Requires the EasyEDA Pro CLI (V4.1.94+) and FreeCAD's `freecadcmd` in PATH
// (or --freecad <path>). Writes <project>/.tmp/audit3d/{board.step,pads.json,report.json}.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CLI = require('./lib/cli');

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');
const STRICT = ARGS.includes('--strict');
function argValue(name) {
  const i = ARGS.indexOf(name);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : null;
}
const DIR = argValue('--dir');
const PCB_ARG = argValue('--pcb');
const FREECAD_ARG = argValue('--freecad');
const OUT_DIR = path.resolve(argValue('--out-dir') || (DIR ? path.join(DIR, '.tmp', 'audit3d') : '.tmp/audit3d'));

function findPcb() {
  if (PCB_ARG) {
    let p = PCB_ARG;
    if (!p.toLowerCase().endsWith('.epcb2') && DIR) p = path.join(DIR, 'pcb', p + '.epcb2');
    if (!path.isAbsolute(p)) p = path.resolve(p);
    if (!fs.existsSync(p)) throw new Error(`PCB file not found: ${p}`);
    return p;
  }
  if (!DIR) throw new Error('usage: node scripts/audit3d.js --dir <project> [--pcb <title|file>] [--strict] [--json]');
  const pcbDir = path.join(DIR, 'pcb');
  if (!fs.existsSync(pcbDir)) throw new Error(`no pcb/ directory in ${DIR}`);
  const files = fs.readdirSync(pcbDir).filter((f) => f.toLowerCase().endsWith('.epcb2'));
  if (files.length === 1) return path.join(pcbDir, files[0]);
  if (!files.length) throw new Error(`no .epcb2 file in ${pcbDir}`);
  throw new Error(`multiple PCBs in ${pcbDir}; choose one with --pcb <title>: ${files.join(', ')}`);
}
function findFreecad() {
  const names = FREECAD_ARG ? [FREECAD_ARG] : [process.env.FREECADCMD, 'freecadcmd', 'FreeCADCmd'].filter(Boolean);
  for (const n of names) {
    const r = spawnSync(n, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (!r.error) return n;
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      if (!/^FreeCAD/i.test(d)) continue;
      for (const exe of ['freecadcmd.exe', 'FreeCADCmd.exe']) {
        const p = path.join(root, d, 'bin', exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

(async () => {
  let PCB_FILE;
  try { PCB_FILE = findPcb(); } catch (e) { console.error('audit3d: ' + e.message); process.exit(2); }
  const pcbTitle = path.basename(PCB_FILE, path.extname(PCB_FILE));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stepFile = path.join(OUT_DIR, 'board.step');
  const padsFile = path.join(OUT_DIR, 'pads.json');
  const reportFile = path.join(OUT_DIR, 'report.json');

  const info = CLI.requireCli({});
  const session = CLI.openProject(info.bin, DIR || path.dirname(path.dirname(PCB_FILE)), { timeout: 180000 });
  let result;
  try {
    result = CLI.invoke(info.bin, session, `
      try { await eda.dmt_Project.waitForReady(); } catch (e) {}
      let pcbs = [];
      for (let i = 0; i < 60; i++) { pcbs = await eda.dmt_Pcb.getAllPcbsInfo(); if (pcbs && pcbs.length) break; await new Promise(x => setTimeout(x, 750)); }
      const pcb = (pcbs || []).find(p => p.name === ${JSON.stringify(pcbTitle)}) || (pcbs || [])[0];
      if (!pcb) throw new Error('no PCB in project');
      await eda.dmt_EditorControl.openDocument(pcb.uuid);
      await new Promise(x => setTimeout(x, 1500));
      const comps = await eda.pcb_PrimitiveComponent.getAll();
      const rows = [];
      for (const c of comps) {
        const d = c.getState_Designator() || null;
        const pins = await c.getAllPins();
        const ps = (pins || []).map(p => ({ x: p.getState_X(), y: p.getState_Y() })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        let xmin=null,xmax=null,ymin=null,ymax=null;
        for (const p of ps) { xmin = xmin===null?p.x:Math.min(xmin,p.x); xmax = xmax===null?p.x:Math.max(xmax,p.x); ymin = ymin===null?p.y:Math.min(ymin,p.y); ymax = ymax===null?p.y:Math.max(ymax,p.y); }
        rows.push({ d, x: c.getState_X(), y: c.getState_Y(), rot: c.getState_Rotation(), fp: (c.getState_Footprint()||{}).name||null, npads: ps.length, xmin, xmax, ymin, ymax });
      }
      const f = await eda.pcb_ManufactureData.get3DFile('audit3d', 'step', ['Component Model'], 'Outfit', true);
      if (!f) throw new Error('get3DFile returned nothing');
      const ok = await eda.sys_FileSystem.saveFileToFileSystem(${JSON.stringify(stepFile)}, f);
      if (!ok) throw new Error('could not write STEP');
      return { pcb: pcb.name, rows };
    `, 420000);
    fs.writeFileSync(padsFile, JSON.stringify({ rows: result.rows }, null, 1));
    console.error(`audit3d: ${result.pcb}: ${result.rows.length} components, STEP ${stepFile}`);
  } finally {
    try { CLI.closeSession(info.bin, session); } catch (e) {}
  }

  const freecad = findFreecad();
  if (!freecad) {
    console.error('audit3d: FreeCAD freecadcmd not found; STEP and pads are written. Install FreeCAD or pass --freecad <path>.');
    console.error(`  ${stepFile}\n  ${padsFile}`);
    process.exit(2);
  }
  const py = path.join(__dirname, 'audit3d.py');
  const r = spawnSync(freecad, [py], {
    encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AUDIT3D_STEP: stepFile, AUDIT3D_PADS: padsFile, AUDIT3D_REPORT: reportFile, AUDIT3D_STRICT: STRICT ? '1' : '0' },
  });
  if (r.error) { console.error('audit3d: ' + r.error.message); process.exit(2); }
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(reportFile, 'utf8')).summary; } catch (e) {}
  if (!summary) {
    console.error((r.stderr || r.stdout || '').trim() || 'audit3d: FreeCAD produced no report');
    process.exit(r.status == null ? 2 : r.status);
  }
  if (JSON_OUT) console.log(JSON.stringify(summary));
  else {
    console.log(`audit3d: ${summary.matched}/${summary.components} components matched, ${summary.missing.length} missing, ${summary.exact.length} exact intersections`);
    for (const x of summary.exact) console.log(`  INTERSECTION ${x.a} <-> ${x.b}: ${x.vol} mm3 (${x.n} solid pair${x.n === 1 ? '' : 's'})`);
    for (const d of summary.missing) console.log(`  NO 3D SOLID ${d}`);
    if (summary.height_out.length) console.log(`  height anomalies: ${JSON.stringify(summary.height_out)}`);
    if (summary.out_of_board.length) console.log(`  out of board: ${JSON.stringify(summary.out_of_board)}`);
    console.log(`  report: ${reportFile}`);
  }
  process.exit(summary.ok ? 0 : 1);
})().catch((e) => { console.error('audit3d: ' + (e && e.message || e)); process.exit(2); });
