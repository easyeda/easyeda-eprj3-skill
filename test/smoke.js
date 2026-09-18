#!/usr/bin/env node
'use strict';
/**
 * smoke.js — end-to-end regression test for the eprj3 skill scripts.
 *
 * Builds a complete project (temp library staging in <project>/.tmp/library,
 * preset-first placement on the schematic and PCB, wires, net label, tracks)
 * with the real scripts in a throwaway temp dir, then asserts the format
 * invariants derived from the official easyeda-pro-eprj3-format example:
 *   - folder layout: index + sch/<sch>/{P1.esch2,<sch>.ecfg,<sch>.evar} + pcb + panel
 *   - library docs embedded per-container; Device/Symbol/Footprint attr links resolve
 *   - COMPONENT head.id == body.id == ATTR.parentId
 *   - one WIRE + one LINE per segment; named wires carry a NET attr
 *   - PCB named NETs precede the first PAD_NET; PAD_NET ids reference COMPONENTs
 *   - tickets unique within every document
 *   - record round-trip survives '||' inside JSON string bodies
 *   - get-or-die paths fail instead of silently creating documents
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const E = require(path.join(SCRIPTS, 'lib', 'eprj3'));

let failures = 0;
let checks = 0;
function assert(cond, name, detail = '') {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function run(args, expectCode = 0) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
  if (expectCode !== null && r.status !== expectCode) {
    assert(false, `node ${path.basename(args[0])} ${args.slice(1, 3).join(' ')}`,
      `exit ${r.status} (expected ${expectCode})\n${(r.stdout || '') + (r.stderr || '')}`.trim());
  }
  return r;
}

// Split a container file into docs: [{docType, uuid, records}].
function docsOf(file) {
  const docs = [];
  let cur = null;
  for (const l of E.readLines(file)) {
    if (l.startsWith('{"type":"DOCHEAD"}')) {
      const r = E.parseRecord(l);
      cur = { docType: r.body.docType, uuid: r.body.uuid, records: [r] };
      docs.push(cur);
    } else if (cur) {
      const r = E.parseRecord(l);
      if (r) cur.records.push(r);
    }
  }
  return docs;
}

function mainDocs(file) {
  const docs = docsOf(file);
  return { docs, main: docs[docs.length - 1] };
}

function ticketUnique(doc, label) {
  const seen = new Set();
  const dupes = [];
  for (const r of doc.records) {
    if (typeof r.ticket === 'number') {
      if (seen.has(r.ticket)) dupes.push(r.ticket);
      seen.add(r.ticket);
    }
  }
  assert(dupes.length === 0, `${label}: tickets unique within the document`,
    `duplicates: ${dupes.join(', ')}`);
}

function ticketsIncrease(doc, label) {
  let last = 0;
  let ok = true;
  for (const r of doc.records) {
    if (typeof r.ticket === 'number') {
      if (r.ticket <= last) ok = false;
      last = r.ticket;
    }
  }
  assert(ok, `${label}: tickets increase in file order`);
}

// Real-client invariants (verified against a client-generated project):
// every DOCHEAD body carries the client id, and every ATTR/COMPONENT/WIRE/LINE
// record head carries an id the client uses to link attrs via parentId.
function realClientInvariants(dir, label) {
  const containers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(esch2|epcb2|epan2)$/.test(e.name)) containers.push(p);
    }
  };
  walk(dir);
  let noClient = 0, noId = 0;
  for (const f of containers) {
    for (const doc of docsOf(f)) {
      if (!doc.records[0].body.client) noClient++;
      for (const r of doc.records.slice(1)) {
        if (['ATTR', 'COMPONENT', 'WIRE', 'LINE'].includes(r.type) && !r.id) noId++;
      }
    }
  }
  assert(noClient === 0, `${label}: every doc DOCHEAD carries the project client`,
    `${noClient} docs missing client in ${containers.length} container files`);
  assert(noId === 0, `${label}: every ATTR/COMPONENT/WIRE/LINE head carries an id`,
    `${noId} id-less records in ${containers.length} container files`);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eprj3-smoke-'));
  const proj = path.join(tmp, 'blink');
  const j = (...p) => path.join(proj, ...p);

  try {
    // ---- init ----
    run([SCRIPTS + '/init.js', '--dir', proj, '--name', 'blink']);
    assert(fs.existsSync(j('blink.eprj3')), 'init creates the .eprj3 index');
    assert(fs.existsSync(j('sch', 'Schematic1', 'P1.esch2')), 'init creates the sheet document');
    assert(fs.existsSync(j('sch', 'Schematic1', 'Schematic1.ecfg')), 'init creates the 4-record .ecfg');
    assert(fs.readFileSync(j('sch', 'Schematic1', 'Schematic1.evar'), 'utf8') === '', 'init creates an empty .evar');
    assert(fs.existsSync(j('pcb', 'PCB1.epcb2')), 'init creates the PCB document');
    assert(!fs.existsSync(j('panel')), 'init does not create a panel unless asked');
    const idx = JSON.parse(fs.readFileSync(j('blink.eprj3'), 'utf8'));
    assert(idx.format === 'folder' && idx.profile && idx.profile.sheets && idx.profile.pcbs,
      'index is folder-format with profile maps');
    const rDup = run([SCRIPTS + '/init.js', '--dir', proj, '--name', 'blink'], null);
    assert(rDup.status !== 0, 'init refuses to overwrite an existing project', `exit ${rDup.status}`);

    // ---- optional panel (only when requested) ----
    const panelProj = path.join(tmp, 'withpanel');
    run([SCRIPTS + '/init.js', '--dir', panelProj, '--name', 'withpanel', '--panel']);
    assert(fs.existsSync(path.join(panelProj, 'panel', 'Panel1.epan2')), '--panel creates the panel document');
    const rValPanel = run([SCRIPTS + '/validate.js', '--dir', panelProj]);
    assert(rValPanel.status === 0, 'validate passes with a panel present', rValPanel.stdout);
    const panelPcb = mainDocs(path.join(panelProj, 'pcb', 'PCB1.epcb2'));
    const dfltOutline = panelPcb.main.records.find((r) => r.type === 'POLY' && r.body.polyType === 'BOARD_OUTLINE');
    assert(dfltOutline && JSON.stringify(dfltOutline.body.path) === '["R",0,3000,4000,3000,0,0]',
      'init board outline defaults to 4000x3000 mil anchored bottom-left');
    run([SCRIPTS + '/add-footprint.js', '--dir', panelProj, '--pcb', 'PCB1',
      '--symbol', 'RES', '--footprint', 'R0603', '--x', '1000', '--y', '1000', '--refdes', 'R1']);
    const panelPcb2 = mainDocs(path.join(panelProj, 'pcb', 'PCB1.epcb2'));
    const ppComp = panelPcb2.main.records.find((r) => r.type === 'COMPONENT' && r.body.x === 1000);
    assert(ppComp && ppComp.body.angle === 0, 'add-footprint defaults to angle 0 without --angle');

    // ---- board size options ----
    const bigProj = path.join(tmp, 'bigboard');
    run([SCRIPTS + '/init.js', '--dir', bigProj, '--name', 'bigboard',
      '--board-w', '5000', '--board-h', '4000']);
    const bigPcb = mainDocs(path.join(bigProj, 'pcb', 'PCB1.epcb2'));
    const bigOutline = bigPcb.main.records.find((r) => r.type === 'POLY' && r.body.polyType === 'BOARD_OUTLINE');
    assert(bigOutline && JSON.stringify(bigOutline.body.path) === '["R",0,4000,5000,4000,0,0]',
      'init --board-w/--board-h size the board outline',
      bigOutline && JSON.stringify(bigOutline.body.path));

    // ---- temp symbol library (project .tmp staging) ----
    run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj, '--name', 'T_RES',
      '--designator', 'R', '--pins', '1;2']);
    const res = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'symbol', 'T_RES.json'), 'utf8'));
    assert(res.kind === 'symbol' && res.title === 'T_RES' && res.symbolDoc.length > 0,
      'generate-symbol stages a temp symbol entry (name = title)');
    assert(res.designator === 'R?', 'generate-symbol derives the designator R? from --designator R');
    assert(res.placement.symbolZ === res.placement.designatorZ + 1,
      'symbol placement zIndex = designatorZ + 1');
    assert(res.placement.nameZ < res.placement.designatorZ, 'Name attr zIndex precedes Designator');
    const resRecs = res.symbolDoc.map(E.parseRecord);
    assert(resRecs.filter((r) => r.type === 'PIN').length === 2, 'symbol doc has one PIN per declared pin');
    const rShadow = run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj,
      '--name', 'RES', '--pins', '1;2'], null);
    assert(rShadow.status !== 0 && /shadows a preset/.test(rShadow.stderr + rShadow.stdout),
      'generate-symbol rejects names shadowing a preset');

    // ---- pin layout: --pitch, explicit coordinates, guards ----
    run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj, '--name', 'T_IC4',
      '--designator', 'U', '--pins', '1:a;2:b;3:c;4:d', '--pitch', '20']);
    const ic4 = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'symbol', 'T_IC4.json'), 'utf8'));
    const ic4Pins = ic4.symbolDoc.map(E.parseRecord).filter((r) => r.type === 'PIN');
    const ic4Rect = ic4.symbolDoc.map(E.parseRecord).find((r) => r.type === 'RECT');
    assert(ic4Pins.some((p) => Math.abs(p.body.y) === 10)
      && ic4Rect && ic4Rect.body.dotY2 === 20 && ic4Rect.body.dotY1 === -20,
      'generate-symbol --pitch 20 spaces pins 20 mil and the body follows',
      JSON.stringify({ ys: ic4Pins.map((p) => p.body.y), rect: ic4Rect && [ic4Rect.body.dotY1, ic4Rect.body.dotY2] }));
    run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj, '--name', 'T_EXPL',
      '--designator', 'U', '--pins', '1:IN:-30:0:0;2:OUT:30:0:180;3:CLK:-30:15:0;4:RST:30:15:180']);
    const expl = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'symbol', 'T_EXPL.json'), 'utf8'));
    const explPins = expl.symbolDoc.map(E.parseRecord).filter((r) => r.type === 'PIN');
    const explRect = expl.symbolDoc.map(E.parseRecord).find((r) => r.type === 'RECT');
    assert(explPins.every((p) => Math.abs(p.body.x) === 30)
      && explRect && explRect.body.dotX1 === -20 && explRect.body.dotX2 === 20,
      'explicit pin coordinates survive into the doc and drive the body rect',
      JSON.stringify({ xs: explPins.map((p) => p.body.x), rect: explRect && [explRect.body.dotX1, explRect.body.dotX2] }));
    const rMixed = run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj,
      '--name', 'T_MIX', '--pins', '1:a;2:b:30:0:180'], null);
    assert(rMixed.status !== 0 && /mixes auto and explicit/.test(rMixed.stderr + rMixed.stdout),
      'generate-symbol rejects mixing auto and explicit pins');
    const rVert = run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj,
      '--name', 'T_VERT', '--pins', '1:a:0:-20:270'], null);
    assert(rVert.status !== 0 && /only 0 \(left\) or 180/.test(rVert.stderr + rVert.stdout),
      'generate-symbol rejects explicit vertical pins (no real-client sample)');

    // ---- temp footprint library ----
    run([SCRIPTS + '/generate-footprint.js', 'from-pads', '--dir', proj, '--name', 'T_FP0402',
      '--designator', 'R',
      '--pads', '1:-16.54:0:31.5:35.43;2:16.54:0:31.5:35.43',
      '--outline', 'R,-27.56,-19.69,55.12,39.37', '--silk', 'rect,-27.56,-19.69,27.56,19.69']);
    const fp = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'footprint', 'T_FP0402.json'), 'utf8'));
    assert(fp.kind === 'footprint' && fp.title === 'T_FP0402' && fp.footprintElems.pads.length === 2,
      'generate-footprint stages a temp footprint entry with pad elements');
    const fpRecs = fp.footprintDoc.map(E.parseRecord);
    const pad1 = fpRecs.find((r) => r.type === 'PAD' && r.body && r.body.num === '1');
    assert(pad1 && pad1.body.hole === null && pad1.body.defaultPad.padType === 'RECT',
      'footprint doc has an SMD RECT PAD record for pad 1');
    const silk = fpRecs.find((r) => r.type === 'POLY' && r.body && r.body.layerId === 3
      && typeof r.body.path[0] === 'number');
    assert(silk && silk.body.path[0] === -27.56 && silk.body.path[2] === 'L' && silk.body.layerId === 3,
      'silk POLY path uses the [x0,y0,"L",...] encoding on layer 3',
      JSON.stringify(silk && silk.body.path));
    const outline48 = fpRecs.find((r) => r.type === 'POLY' && r.body && r.body.layerId === 48);
    assert(outline48 && outline48.body.path[0] === -27.56 && outline48.body.path[2] === 'L',
      'footprint outline emits explicit polyline corners (real docs never use rect paths)');
    run([SCRIPTS + '/generate-footprint.js', 'from-pads', '--dir', proj, '--name', 'T_TH',
      '--designator', 'U', '--pads', '1:-50:0:60:60:36;2:50:0:60:60:36',
      '--outline', 'R,-80,-40,160,80']);
    const thFp = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'footprint', 'T_TH.json'), 'utf8'));
    const thPad = thFp.footprintDoc.map(E.parseRecord).find((r) => r.type === 'PAD' && r.body.num === '1');
    assert(thPad && thPad.body.hole && thPad.body.hole.holeType === 'ROUND'
      && thPad.body.hole.width === 36 && thPad.body.layerId === 12
      && thPad.body.defaultPad.padType === 'ELLIPSE',
      'pad spec with drill emits ROUND hole + ELLIPSE pad on MULTI layer (official example shape)',
      thPad && JSON.stringify({ hole: thPad.body.hole, layerId: thPad.body.layerId }));
    const rHoleBad = run([SCRIPTS + '/generate-footprint.js', 'from-pads', '--dir', proj,
      '--name', 'T_BAD', '--pads', '1:0:0:10:10:36'], null);
    assert(rHoleBad.status !== 0 && /drill/.test(rHoleBad.stderr + rHoleBad.stdout),
      'generate-footprint rejects a drill larger than its copper pad');

    // ---- temp power/port staging via load-library ----
    run([SCRIPTS + '/load-library.js', 'power', '--dir', proj, '--net', 'T_PWR']);
    const pwr = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'symbol', 'T_PWR.json'), 'utf8'));
    const pwrMeta = pwr.powerDeviceDoc.map(E.parseRecord).find((r) => r.type === 'META');
    assert(pwr.kind === 'power' && pwr.net === 'T_PWR' && pwr.style === 'up'
      && pwrMeta.body.attributes.Designator === undefined,
      'power entry stages with net/style and no Designator key');
    assert(pwrMeta.body.attributes['Global Net Name'] === 'T_PWR',
      'power device META carries Global Net Name');
    const rPwrShadow = run([SCRIPTS + '/load-library.js', 'power', '--dir', proj, '--net', 'VCC'], null);
    assert(rPwrShadow.status !== 0 && /shadows a preset/.test(rPwrShadow.stderr + rPwrShadow.stdout),
      'power staging rejects nets shadowing a preset name');

    run([SCRIPTS + '/load-library.js', 'port', '--dir', proj, '--net', 'SIG', '--name', 'PORT_SIG']);
    const port = JSON.parse(fs.readFileSync(j('.tmp', 'library', 'symbol', 'PORT_SIG.json'), 'utf8'));
    const portSymMeta = port.portSymbolDoc.map(E.parseRecord).find((r) => r.type === 'META');
    assert(port.kind === 'port' && port.net === 'SIG' && portSymMeta.body.docType === 19
      && portSymMeta.body.title === 'PORT_SIG',
      'port entry stages a docType-19 NetPort symbol titled PORT_SIG');
    assert(port.portSymbolDoc.some((l) => l.includes('"type":"RECT"') && l.includes('"dotX1":5')),
      'port symbol doc draws the rectangle body');
    const portDevMeta = port.portDeviceDoc.map(E.parseRecord).find((r) => r.type === 'META');
    assert(portDevMeta.body.attributes.Designator === undefined
      && portDevMeta.body.attributes['Global Net Name'] === 'SIG',
      'port device META has no Designator and carries Global Net Name');

    // ---- two-tier listing / show / remove ----
    const rList = run([SCRIPTS + '/load-library.js', 'list', '--dir', proj]);
    assert(/preset +RES/.test(rList.stdout) && /tmp +T_RES/.test(rList.stdout),
      'load-library list marks preset vs tmp entries');
    const rShow = run([SCRIPTS + '/load-library.js', 'show', '--name', 'RES']);
    assert(/"kind": "symbol"/.test(rShow.stdout), 'show resolves preset entries by name');
    const rRmPreset = run([SCRIPTS + '/load-library.js', 'remove', '--name', 'RES', '--dir', proj], null);
    assert(rRmPreset.status !== 0 && /not removable/.test(rRmPreset.stderr + rRmPreset.stdout),
      'remove refuses preset entries');
    run([SCRIPTS + '/load-library.js', 'remove', '--name', 'PORT_SIG', '--dir', proj]);
    assert(!fs.existsSync(j('.tmp', 'library', 'symbol', 'PORT_SIG.json')), 'remove deletes temp entries');
    run([SCRIPTS + '/load-library.js', 'port', '--dir', proj, '--net', 'SIG', '--name', 'PORT_SIG']);

    // ---- schematic placement: preset-first ----
    const presetRes = JSON.parse(fs.readFileSync(path.join(E.LIBRARY_DIR, 'symbol', 'RES.json'), 'utf8'));
    const presetR0603 = JSON.parse(fs.readFileSync(path.join(E.LIBRARY_DIR, 'footprint', 'R0603.json'), 'utf8'));
    run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--symbol', 'RES', '--footprint', 'R0603', '--x', '300', '--y', '-440',
      '--rotation', '90', '--refdes', 'R1']);
    const sch = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    const symUuids = new Set(sch.docs.filter((d) => d.docType === 'SYMBOL').map((d) => d.uuid));
    assert(symUuids.has(presetRes.symbolUuid), 'add-symbol embeds the preset SYMBOL doc');
    assert(sch.docs.some((d) => d.docType === 'FOOTPRINT' && d.uuid === presetR0603.footprintUuid),
      'paired preset FOOTPRINT doc is embedded');
    const client = E.Project.load(proj).client;
    assert(sch.docs.find((d) => d.uuid === presetRes.symbolUuid).records[0].body.client === client,
      'embedded preset docs are rewritten to the project client');
    const devMetaRec = sch.docs.filter((d) => d.docType === 'DEVICE')
      .map((d) => d.records.find((r) => r.type === 'META'))
      .find((m) => m && m.body.attributes && m.body.attributes.Footprint === presetR0603.footprintUuid);
    assert(devMetaRec && devMetaRec.body.title === 'R0603' && devMetaRec.body.attributes.Designator === 'R?',
      'device doc is composed on the fly (title = footprint name, designator R?)');
    const devUuid = sch.docs.find((d) => d.docType === 'DEVICE' && d.records.includes(devMetaRec)).uuid;
    // locate the component by its DeviceName uuid (the first COMPONENT in the
    // main doc is the A4 frame)
    const comp = sch.main.records.find((r) => r.type === 'COMPONENT' && r.body.attrs
      && r.body.attrs.DeviceName && JSON.parse(r.body.attrs.DeviceName).uuid === devUuid);
    assert(comp && comp.head.id, 'COMPONENT carries an id on the record head');
    const symAttr = sch.main.records.find((r) => r.type === 'ATTR' && r.body.key === 'Symbol' && r.body.parentId === comp.head.id);
    const devAttr = sch.main.records.find((r) => r.type === 'ATTR' && r.body.key === 'Device' && r.body.parentId === comp.head.id);
    assert(symAttr && symAttr.body.parentId === comp.head.id && symAttr.body.value === presetRes.symbolUuid,
      'Symbol attr links COMPONENT to the embedded SYMBOL doc');
    assert(devAttr && devAttr.body.parentId === comp.head.id && devAttr.body.value === devUuid,
      'Device attr links COMPONENT to the embedded DEVICE doc');
    const desig = sch.main.records.find((r) => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.parentId);
    assert(desig && desig.body.parentId === comp.head.id && desig.body.value === 'R1',
      'Designator attr parentId == COMPONENT id');
    ticketUnique(sch.main, 'P1.esch2 main doc');
    for (const d of sch.docs.slice(0, -1)) ticketUnique(d, `P1.esch2[${d.docType}]`);
    const rFpPair = run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1',
      '--sheet', 'P1', '--symbol', 'RES', '--footprint', 'VCC', '--x', '1', '--y', '1'], null);
    assert(rFpPair.status !== 0 && /footprint entry not found/.test(rFpPair.stderr + rFpPair.stdout),
      'add-symbol rejects a non-footprint --footprint pairing');

    // ---- temp-entry placement ----
    run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--symbol', 'T_RES', '--footprint', 'T_FP0402', '--x', '500', '--y', '-440']);
    const schT = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    assert(schT.docs.some((d) => d.docType === 'SYMBOL' && d.uuid === res.symbolUuid),
      'add-symbol resolves temp symbol entries');
    assert(schT.docs.some((d) => d.docType === 'FOOTPRINT' && d.uuid === fp.footprintUuid),
      'add-symbol resolves temp footprint entries');

    // ---- power / port placement (preset + temp) ----
    run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--symbol', 'VCC', '--x', '300', '--y', '-500']);
    run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--symbol', 'T_PWR', '--x', '300', '--y', '-560']);
    run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--symbol', 'PORT_IN', '--x', '460', '--y', '-440']);
    run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--symbol', 'PORT_SIG', '--x', '560', '--y', '-440']);
    const schP = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    // power component: DeviceName null, no pinClass keys; Global Net Name is a
    // standalone ATTR record (matches the example)
    const vccGnn = schP.main.records.find((a) => a.type === 'ATTR'
      && a.body.key === 'Global Net Name' && a.body.value === 'VCC');
    assert(vccGnn, 'preset power placement writes a Global Net Name attr');
    const pwrComp = schP.main.records.find((r) => r.type === 'COMPONENT' && r.head.id === vccGnn.body.parentId);
    assert(pwrComp && pwrComp.body.attrs.pinClass === undefined,
      'power COMPONENT omits pinClass keys (matches the example)');
    const tGnn = schP.main.records.some((a) => a.type === 'ATTR'
      && a.body.key === 'Global Net Name' && a.body.value === 'T_PWR');
    assert(tGnn, 'temp power placement writes its net');
    const portGnn = schP.main.records.find((a) => a.type === 'ATTR'
      && a.body.key === 'Global Net Name' && a.body.value === 'IN');
    assert(portGnn, 'preset port placement writes a Global Net Name attr');
    const portCompRec = schP.main.records.find((r) => r.type === 'COMPONENT' && r.head.id === portGnn.body.parentId);
    assert(portCompRec && portCompRec.body.attrs.DeviceName === null,
      'port COMPONENT carries DeviceName null like power symbols');
    const presetPort = JSON.parse(fs.readFileSync(path.join(E.LIBRARY_DIR, 'symbol', 'PORT_IN.json'), 'utf8'));
    const portSymAttr = schP.main.records.find((r) => r.type === 'ATTR'
      && r.body.key === 'Symbol' && r.body.parentId === portCompRec.head.id);
    assert(portSymAttr && portSymAttr.body.value === presetPort.symbolUuid,
      'port Symbol attr resolves to the preset docType-19 NetPort doc');
    assert(schP.main.records.some((a) => a.type === 'ATTR'
      && a.body.key === 'Global Net Name' && a.body.value === 'SIG'),
      'temp port placement writes its net');

    // ---- wires ----
    run([SCRIPTS + '/add-wire.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--segs', '300,-500,300,-460']);
    run([SCRIPTS + '/add-wire.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--segs', '300,-420,300,-380', '--net', 'SIG']);
    const sch2 = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    const wires = sch2.main.records.filter((r) => r.type === 'WIRE');
    const lines = sch2.main.records.filter((r) => r.type === 'LINE');
    assert(wires.length === 2 && lines.length === 2,
      'one WIRE + one LINE per wire', `wires=${wires.length} lines=${lines.length}`);
    assert(lines.every((l) => wires.some((w) => w.head.id === l.body.lineGroup)),
      'every LINE references its WIRE via lineGroup');
    const namedWireId = wires[1].head.id; // 2nd add-wire call got --net SIG
    for (const w of wires) {
      const hasNet = sch2.main.records.some((a) => a.type === 'ATTR' && a.body.parentId === w.head.id && a.body.key === 'NET');
      const named = w.head.id === namedWireId;
      assert(hasNet === named, `WIRE ${w.head.id} ${named ? 'carries' : 'omits'} a NET attr`);
    }
    const rBad = run([SCRIPTS + '/add-wire.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--segs', '1,foo,2,3'], null);
    assert(rBad.status !== 0, 'add-wire rejects non-numeric segments', `exit ${rBad.status}`);

    // ---- net label ----
    run([SCRIPTS + '/add-netlabel.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--net', 'SIG', '--at', '300,-400']);
    const netVals = sch2.main.records
      .filter((a) => a.type === 'ATTR' && a.body.key === 'NET' && a.body.parentId)
      .map((a) => a.body.value);
    assert(netVals.includes('SIG'), 'add-netlabel writes SIG into the wire NET attr');
    // label the wire that was drawn WITHOUT --net (no NET attr yet)
    run([SCRIPTS + '/add-netlabel.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--net', 'LBL1', '--at', '300,-480']);
    const schL = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    const unlabeledWire = schL.main.records.filter((r) => r.type === 'WIRE')[0];
    const lblAttr = schL.main.records.find((a) => a.type === 'ATTR' && a.body.key === 'NET'
      && a.body.parentId === unlabeledWire.head.id);
    assert(lblAttr && lblAttr.body.value === 'LBL1' && lblAttr.body.rotation === 90
      && lblAttr.body.valueVisible === true,
      'add-netlabel creates a NET attr (wireBlock shape) on an unlabeled wire');
    ticketsIncrease(schL.main, 'P1.esch2 after netlabel');

    // ---- text + shapes on the sheet ----
    run([SCRIPTS + '/add-text.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--value', '5V rail', '--x', '300', '--y', '-300', '--size', '10']);
    run([SCRIPTS + '/add-shape.js', 'rect', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--x1', '200', '--y1', '-200', '--x2', '400', '--y2', '-300']);
    run([SCRIPTS + '/add-shape.js', 'poly', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--pts', '200,-200,300,-100,400,-200', '--closed']);
    run([SCRIPTS + '/add-shape.js', 'circle', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--cx', '300', '--cy', '-250', '--r', '50']);
    run([SCRIPTS + '/add-shape.js', 'ellipse', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--cx', '300', '--cy', '-250', '--rx', '80', '--ry', '40']);
    run([SCRIPTS + '/add-shape.js', 'arc', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--start', '200,-200', '--mid', '300,-300', '--end', '400,-200']);
    run([SCRIPTS + '/add-shape.js', 'bezier', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
      '--pts', '200,-200,250,-100,350,-100,400,-200']);
    const schS = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    const text = schS.main.records.find((r) => r.type === 'TEXT' && r.body.value === '5V rail');
    assert(text && text.body.fontSize === 10 && typeof text.body.zIndex === 'number',
      'add-text writes a sheet TEXT record with value/size/zIndex');
    const srect = schS.main.records.find((r) => r.type === 'RECT' && r.body.dotX1 === 200);
    assert(srect && srect.body.partId === undefined && srect.body.strokeStyle === 'SOLID',
      'sheet RECT drops partId and uses string stroke enums (example shape)');
    const spoly = schS.main.records.find((r) => r.type === 'POLY' && r.body.closed === true);
    assert(spoly && spoly.body.points.length === 3 && spoly.body.points[0].x === 200,
      'sheet POLY uses point objects with closed flag');
    for (const t of ['CIRCLE', 'ELLIPSE', 'ARC', 'BEZIER']) {
      assert(schS.main.records.some((r) => r.type === t), `sheet ${t} record present`);
    }
    ticketsIncrease(schS.main, 'P1.esch2 main doc');

    // ---- refdes ----
    run([SCRIPTS + '/set-refdes.js', 'renumber', '--dir', proj, '--sch', 'Schematic1',
      '--sheet', 'P1', '--prefix', 'R']);
    const sch3 = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    assert(sch3.main.records.some((r) => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'R1'),
      'set-refdes renumber assigns R1');
    const rGhost = run([SCRIPTS + '/set-refdes.js', 'set', '--dir', proj, '--sch', 'NoSuch',
      '--sheet', 'P1', '--designator', 'R1', '--value', 'R9'], null);
    assert(rGhost.status !== 0, 'set-refdes fails on unknown schematic instead of creating one', `exit ${rGhost.status}`);
    // embedded SYMBOL docs still carry their "R?" placeholder attrs; `set`
    // must be main-doc scoped and refuse to rename them
    const rPlace = run([SCRIPTS + '/set-refdes.js', 'set', '--dir', proj, '--sch', 'Schematic1',
      '--sheet', 'P1', '--designator', 'R?', '--value', 'RZ'], null);
    assert(rPlace.status !== 0, 'set-refdes set ignores embedded symbol placeholder attrs', `exit ${rPlace.status}`);
    const schP2 = mainDocs(j('sch', 'Schematic1', 'P1.esch2'));
    assert(schP2.main.records.some((r) => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'R1'),
      'placeholder guard did not disturb the renamed component');

    // ---- PCB placement (preset symbol + footprint) ----
    run([SCRIPTS + '/add-footprint.js', '--dir', proj, '--pcb', 'PCB1',
      '--symbol', 'RES', '--footprint', 'R0603',
      '--x', '300', '--y', '300', '--angle', '90', '--refdes', 'R1', '--nets', '1:VCC,2:SIG']);
    const pcb1 = mainDocs(j('pcb', 'PCB1.epcb2'));
    const fpUuids = new Set(pcb1.docs.filter((d) => d.docType === 'FOOTPRINT').map((d) => d.uuid));
    assert(fpUuids.has(presetR0603.footprintUuid), 'add-footprint embeds the preset FOOTPRINT doc');
    assert(pcb1.docs.some((d) => d.docType === 'SYMBOL' && d.uuid === presetRes.symbolUuid),
      'add-footprint embeds the paired symbol entry SYMBOL doc');
    const pcbDevMeta = pcb1.docs.filter((d) => d.docType === 'DEVICE')
      .map((d) => d.records.find((r) => r.type === 'META'))
      .find((m) => m && m.body.attributes && m.body.attributes.Footprint === presetR0603.footprintUuid);
    assert(pcbDevMeta && pcbDevMeta.body.title === 'R0603', 'PCB device doc composed with the footprint title');
    const pcomp = pcb1.main.records.find((r) => r.type === 'COMPONENT');
    assert(pcomp && pcomp.head.id, 'PCB COMPONENT carries an id on the record head');
    assert(pcb1.main.records.some((r) => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'R1'),
      'PCB Designator attr carries the refdes');
    const padNets = pcb1.main.records.filter((r) => r.type === 'PAD_NET');
    assert(padNets.length === 2 && padNets.every((r) => JSON.parse(r.id)[1] === pcomp.head.id),
      'PAD_NET ids reference the COMPONENT id');
    const firstPadNet = pcb1.main.records.findIndex((r) => r.type === 'PAD_NET');
    const namedNets = pcb1.main.records.filter((r) => r.type === 'NET' && r.id !== '["NET",""]');
    assert(namedNets.length === 2 &&
      pcb1.main.records.findIndex((r) => r.type === 'NET' && r.id !== '["NET",""]') < firstPadNet,
      'named NETs inserted after the empty NET and before the first PAD_NET');
    const netNameSet = new Set(namedNets.map((r) => JSON.parse(r.id)[1]));
    assert(['VCC', 'SIG'].every((n) => netNameSet.has(n)), 'VCC/SIG NET records created');
    const emptyNet = pcb1.main.records.find((r) => r.type === 'NET' && r.id === '["NET",""]');
    assert(emptyNet, 'empty NET record preserved');
    // set-refdes `set` must work on the PCB main doc too (rename back after)
    run([SCRIPTS + '/set-refdes.js', 'set', '--dir', proj, '--pcb', 'PCB1',
      '--designator', 'R1', '--value', 'R7']);
    const pcbR7 = mainDocs(j('pcb', 'PCB1.epcb2'));
    assert(pcbR7.main.records.some((r) => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'R7'),
      'set-refdes set renames the PCB Designator attr');
    run([SCRIPTS + '/set-refdes.js', 'set', '--dir', proj, '--pcb', 'PCB1',
      '--designator', 'R7', '--value', 'R1']);

    // ---- tracks ----
    run([SCRIPTS + '/add-track.js', '--dir', proj, '--pcb', 'PCB1', '--net', 'SIG',
      '--layer', '1', '--width', '10', '--x1', '300', '--y1', '316.54', '--x2', '450', '--y2', '316.54']);
    const pcb2 = mainDocs(j('pcb', 'PCB1.epcb2'));
    const track = pcb2.main.records.find((r) => r.type === 'LINE' && r.body && r.body.netName === 'SIG');
    assert(track && track.body.startX === 300 && track.body.layerId === 1,
      'add-track writes a LINE with netName/layerId/coords');
    ticketUnique(pcb2.main, 'PCB1.epcb2 main doc');

    // ---- PCB text / shapes / via / pour ----
    run([SCRIPTS + '/add-pcb-text.js', '--dir', proj, '--pcb', 'PCB1', '--value', 'REV A',
      '--x', '2000', '--y', '2800', '--layer', '3']);
    run([SCRIPTS + '/add-pcb-shape.js', 'rect', '--dir', proj, '--pcb', 'PCB1',
      '--x', '500', '--y', '500', '--w', '400', '--h', '300']);
    run([SCRIPTS + '/add-pcb-shape.js', 'poly', '--dir', proj, '--pcb', 'PCB1',
      '--pts', '500,500,900,500,700,800', '--closed']);
    run([SCRIPTS + '/add-pcb-shape.js', 'circle', '--dir', proj, '--pcb', 'PCB1',
      '--cx', '700', '--cy', '650', '--r', '100']);
    run([SCRIPTS + '/add-pcb-shape.js', 'arc', '--dir', proj, '--pcb', 'PCB1',
      '--x1', '500', '--y1', '500', '--x2', '900', '--y2', '500', '--angle', '90']);
    run([SCRIPTS + '/add-via.js', '--dir', proj, '--pcb', 'PCB1', '--x', '700', '--y', '316.54',
      '--net', 'SIG']);
    run([SCRIPTS + '/add-pour.js', 'rect', '--dir', proj, '--pcb', 'PCB1', '--net', 'GND',
      '--x', '100', '--y', '100', '--w', '3800', '--h', '2800']);
    run([SCRIPTS + '/add-pour.js', 'poly', '--dir', proj, '--pcb', 'PCB1', '--net', 'GND',
      '--layer', '2', '--pts', '100,100,3900,100,3900,2900,100,2900']);
    const pcb3 = mainDocs(j('pcb', 'PCB1.epcb2'));
    const str = pcb3.main.records.find((r) => r.type === 'STRING' && r.body.text === 'REV A');
    assert(str && str.body.layerId === 3 && str.body.fontFamily === 'default',
      'add-text writes a PCB STRING record with layer/font');
    const prect = pcb3.main.records.find((r) => r.type === 'POLY' && r.body.polyType === 'NORMAL'
      && Array.isArray(r.body.path) && r.body.path[0] === 'R');
    assert(prect && prect.body.path[1] === 500 && prect.body.path[2] === 800
      && prect.body.path[3] === 400 && prect.body.path[4] === 300 && prect.body.zIndex === -1,
      'PCB rect POLY anchors at min-x/max-y: ["R",500,800,400,300,0,0] for a rect at (500,500)');
    const ppoly = pcb3.main.records.find((r) => r.type === 'POLY' && Array.isArray(r.body.path)
      && r.body.path[2] === 'L');
    assert(ppoly && ppoly.body.path[0] === ppoly.body.path[ppoly.body.path.length - 2]
      && ppoly.body.path[1] === ppoly.body.path[ppoly.body.path.length - 1],
      'PCB poly POLY closes via appended first point');
    const pcircle = pcb3.main.records.find((r) => r.type === 'POLY' && Array.isArray(r.body.path)
      && r.body.path[0] === 'CIRCLE');
    assert(pcircle && pcircle.body.path[3] === 100, 'PCB circle POLY uses ["CIRCLE",cx,cy,r,isCCW]');
    const parc = pcb3.main.records.find((r) => r.type === 'ARC');
    assert(parc && parc.body.angle === 90 && parc.body.startX === 500,
      'PCB ARC record carries start/end/angle');
    const via = pcb3.main.records.find((r) => r.type === 'VIA');
    assert(via && via.body.netName === 'SIG' && via.body.viaDiameter === 24.0158
      && via.body.holeDiameter === 12.0078,
      'VIA record carries net + example-preference diameters');
    const pours = pcb3.main.records.filter((r) => r.type === 'POUR');
    assert(pours.length === 2 && pours.every((p) => p.body.netName === 'GND')
      && pours.every((p) => Array.isArray(p.body.path) && Array.isArray(p.body.path[0]))
      && pours[0].body.pourType.pourType === 'SOLID',
      'POUR records carry nested polygon paths + pourType object');
    assert(pours[0].body.name === 'POUR1' && pours[1].body.name === 'POUR2',
      'add-pour auto-assigns unique POURn names when --name is omitted',
      JSON.stringify(pours.map((p) => p.body.name)));
    const pcbNets = new Set(pcb3.main.records
      .filter((r) => r.type === 'NET' && r.id !== '["NET",""]')
      .map((r) => JSON.parse(r.id)[1]));
    assert(['VCC', 'SIG', 'GND'].every((n) => pcbNets.has(n)),
      'VIA/POUR nets (SIG/GND) registered as NET records');
    ticketsIncrease(pcb3.main, 'PCB1.epcb2 main doc');

    // ---- fill / region ----
    run([SCRIPTS + '/add-fill.js', 'rect', '--dir', proj, '--pcb', 'PCB1', '--net', 'GND',
      '--x', '100', '--y', '100', '--w', '400', '--h', '300']);
    run([SCRIPTS + '/add-fill.js', 'poly', '--dir', proj, '--pcb', 'PCB1',
      '--pts', '1000,1000,1400,1000,1400,1300']);
    run([SCRIPTS + '/add-region.js', 'rect', '--dir', proj, '--pcb', 'PCB1',
      '--prohibit', 'COMPONENT,TRACK', '--name', 'KEEP1', '--x', '200', '--y', '200', '--w', '300', '--h', '200']);
    const pcb4 = mainDocs(j('pcb', 'PCB1.epcb2'));
    const fills = pcb4.main.records.filter((r) => r.type === 'FILL');
    assert(fills.length === 2 && fills[0].body.netName === 'GND' && fills[1].body.netName === ''
      && fills.every((f) => f.body.fillStyle === 'SOLID' && f.body.partitionId === ''
        && f.body.isBridgingCopper === false && Array.isArray(f.body.path)
        && Array.isArray(f.body.path[0])),
      'FILL records carry nested paths + SOLID-only fillStyle');
    const region = pcb4.main.records.find((r) => r.type === 'REGION');
    assert(region && JSON.stringify(region.body.prohibitType) === '["COMPONENT","TRACK"]'
      && region.body.regionType === 'PROHIBIT'
      && region.body.name === 'KEEP1' && region.body.width === 1
      && Array.isArray(region.body.path) && Array.isArray(region.body.path[0]),
      'REGION record carries enum prohibitType + regionType + name + nested path');
    const rFillBad = run([SCRIPTS + '/add-fill.js', 'rect', '--dir', proj, '--pcb', 'PCB1',
      '--style', 'GRID', '--x', '0', '--y', '0', '--w', '10', '--h', '10'], 1);
    assert(/not sample-backed/.test(rFillBad.stderr + rFillBad.stdout),
      'add-fill rejects non-SOLID style');
    const rRegionBad = run([SCRIPTS + '/add-region.js', 'rect', '--dir', proj, '--pcb', 'PCB1',
      '--prohibit', 'BOGUS', '--x', '0', '--y', '0', '--w', '10', '--h', '10'], 1);
    assert(/unknown prohibitType/.test(rRegionBad.stderr + rRegionBad.stdout),
      'add-region rejects unknown prohibitType');
    ticketUnique(pcb4.main, 'PCB1.epcb2 main doc after fill/region');

    // ---- validate: clean + detects corruption ----
    const rVal = run([SCRIPTS + '/validate.js', '--dir', proj]);
    assert(/OK \(0 errors, 0 warning/.test(rVal.stdout),
      'validate reports 0 errors on the finished project', rVal.stdout.trim());
    realClientInvariants(proj, 'smoke project');
    const dirty = path.join(tmp, 'dirty');
    fs.cpSync(proj, dirty, { recursive: true });
    const dirtySheet = path.join(dirty, 'sch', 'Schematic1', 'P1.esch2');
    E.appendRecord(dirtySheet, 'LINE', { lineGroup: 'missing-wire' }, undefined, 'orphan1');
    const rDirty = run([SCRIPTS + '/validate.js', '--dir', dirty], 1);
    assert(/error/.test(rDirty.stderr + rDirty.stdout),
      'validate flags a LINE referencing a missing WIRE as an error');

    // ---- cleanup: drop the temp staging area, presets untouched ----
    run([SCRIPTS + '/cleanup.js', '--dir', proj]);
    assert(!fs.existsSync(j('.tmp')), 'cleanup removes the project .tmp staging area');
    run([SCRIPTS + '/cleanup.js', '--dir', proj]);
    const rVal2 = run([SCRIPTS + '/validate.js', '--dir', proj]);
    assert(/OK \(0 errors, 0 warning/.test(rVal2.stdout),
      'validate still OK after cleanup', rVal2.stdout.trim());
    assert(fs.existsSync(path.join(E.LIBRARY_DIR, 'symbol', 'RES.json')),
      'cleanup leaves preset templates untouched');

    // ---- record round-trip ----
    const rt = E.parseRecord(E.formatRecord({ type: 'TEXT', ticket: 1, id: 'x' }, { value: 'A||B' }));
    assert(rt && rt.body.value === 'A||B', "parse/format round-trip survives '||' inside JSON bodies");

    // ---- examples/blink itself validates ----
    const blinkDir = path.join(ROOT, 'examples', 'blink');
    if (fs.existsSync(blinkDir)) {
      const rBlink = run([SCRIPTS + '/validate.js', '--dir', blinkDir]);
      assert(/OK \(0 errors, 0 warning/.test(rBlink.stdout),
        'examples/blink passes validate', rBlink.stdout.trim());
      realClientInvariants(blinkDir, 'examples/blink');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main();
