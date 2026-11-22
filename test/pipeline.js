#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCaptured } = require('./capture');
const E = require('../scripts/lib/eprj3');

const root = path.join(__dirname, '..');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-resistor-link.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eprj3-authored-'));
function run(name, modify = () => {}, options = [], expected = 0) {
  const design = structuredClone(sample);
  modify(design);
  const file = path.join(tmp, `${name}.json`);
  const report = path.join(tmp, `${name}.report.json`);
  const dir = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(design));
  const r = spawnCaptured(process.execPath, [path.join(root, 'scripts/build.js'),
    '--design', file, '--dir', dir, '--report', report, ...options], { cwd: root });
  assert.equal(r.status, expected, `${name}\n${r.stdout}\n${r.stderr}`);
  return { dir, stdout: r.stdout, stderr: r.stderr,
    report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
}

try {
  const clean = run('routed');
  const records = (subfolder, suffix) => fs.readdirSync(path.join(clean.dir, subfolder), { recursive: true })
    .filter((name) => name.endsWith(suffix)).flatMap((name) => E.readRecords(path.join(clean.dir, subfolder, name)));
  const schematic = records('sch', '.esch2');
  const board = records('pcb', '.epcb2');
  assert.equal(clean.report.pcb.rats, 0);
  assert.equal(clean.report.pcb.mode, 'routed');
  assert.equal(clean.report.audit.ok, true);
  assert.deepEqual(clean.report.pcb.board, { width: 500, height: 350 });
  assert(schematic.some((r) => r.type === 'COMPONENT' && r.body.x === 300 && r.body.y === 300));
  assert(schematic.some((r) => r.type === 'LINE' && r.body.startX === 320 && r.body.endX === 580));
  assert(board.some((r) => r.type === 'COMPONENT' && r.body.x === 150 && r.body.y === 150));
  assert(board.some((r) => r.type === 'LINE' && r.body.layerId === 2 && r.body.netName === 'RETURN' && r.body.startX === 120.34));
  assert.equal(board.filter((r) => r.type === 'VIA').length, 2);

  const inspect = run('inspect', (d) => { delete d.sch; delete d.pcb.place; }, ['--geometry']);
  assert.equal(JSON.parse(inspect.stdout).parts[0].pins.find((p) => p.num === '2').at[0], 20);
  assert(!fs.existsSync(inspect.dir));
  // with sch.place present every pin also carries its absolute sheet position
  const geo = run('geometry', () => {}, ['--geometry']);
  const geoOut = JSON.parse(geo.stdout);
  assert.deepEqual(geoOut.parts.find((p) => p.ref === 'R1').pins.find((p) => p.num === '2').sheetAt, [320, 300]);
  assert.deepEqual(geoOut.parts.find((p) => p.ref === 'R2').pins.find((p) => p.num === '1').sheetAt, [580, 300]);
  assert(!fs.existsSync(geo.dir));
  const preview = run('preview', () => {}, ['--plan']);
  assert(!fs.existsSync(preview.dir));
  assert.equal(preview.report.pcb.rats, 0);

  const missing = run('missing', (d) => { delete d.sch.place.R2; }, [], 1);
  assert.match(missing.stderr, /sch\.place.*missing R2/);
  assert(!fs.existsSync(missing.dir));
  const noPcbPosition = run('missing-pcb-position', (d) => { delete d.pcb.place.R1; }, [], 1);
  assert.match(noPcbPosition.stderr, /pcb\.place.*missing R1/);
  assert(!fs.existsSync(noPcbPosition.dir));
  const touching = run('touching', (d) => { d.sch.wires[1].points[0] = [320, 300]; }, [], 1);
  assert.match(touching.stderr, /touches R1\.2/);
  // a one-mil miss must fail BEFORE writing, name the pin tip and the nearest
  // wire endpoint, and point at sch.wires (not at parts[].pins)
  const offPin = run('wire-off-pin', (d) => { d.sch.wires[0].points[0] = [321, 300]; }, [], 1);
  assert.match(offPin.stderr, /pin R1\.2 \(net "LINK"\).*321,300.*1\.0 mil/);
  assert.match(offPin.stderr, /sch\.wires/);
  assert.doesNotMatch(offPin.stderr, /parts\[\]\.pins/);
  assert(!fs.existsSync(offPin.dir));
  const schematicGap = run('missing-wire', (d) => { d.sch.wires.shift(); }, [], 1);
  assert.match(schematicGap.stderr, /pin R1\.2 \(net "LINK"\).*nearest endpoint/);
  // a named wire that ends in empty space is still a dangling end (L010)
  const dangling = run('dangling-wire', (d) => {
    d.sch.wires.push({ net: 'LINK', points: [[580, 300], [580, 340], [700, 340]] });
  });
  assert(dangling.report.lint.findings.some((f) => f.code === 'L010' && f.at === '700,340'));
  // a flag that is not on a wire endpoint fails before writing
  const floatFlag = run('floating-flag', (d) => {
    d.sch.flags = [{ net: 'RETURN', at: [900, 900], kind: 'down' }];
  }, [], 1);
  assert.match(floatFlag.stderr, /power flag "RETURN" at 900,900.*not on a wire endpoint/);
  // a net spanning pages needs a port/flag on every page — a wire name does not
  // cross pages
  const crossSheet = (d) => {
    d.sheets = 2;
    d.blocks = [{ title: 'A', sheet: 1, parts: ['R1'] }, { title: 'B', sheet: 2, parts: ['R2'] }];
    d.sch.wires = [
      { net: 'LINK', points: [[320, 300], [360, 300]], sheet: 1 },
      { net: 'LINK', points: [[580, 300], [540, 300]], sheet: 2 },
      { net: 'RETURN', points: [[280, 300], [240, 300]], sheet: 1 },
      { net: 'RETURN', points: [[620, 300], [660, 300]], sheet: 2 }
    ];
    d.sch.flags = [
      { net: 'RETURN', at: [240, 300], kind: 'down', sheet: 1 },
      { net: 'RETURN', at: [660, 300], kind: 'down', sheet: 2 }
    ];
  };
  const noPort = run('cross-sheet-no-port', crossSheet, [], 1);
  assert.match(noPort.stderr, /net "LINK" has pins on sheets 1, 2 but sheet 1 has no net port/);
  const withPort = run('cross-sheet-ports', (d) => {
    crossSheet(d);
    d.sch.ports = [
      { net: 'LINK', at: [360, 300], kind: 'BI', sheet: 1 },
      { net: 'LINK', at: [540, 300], kind: 'BI', sheet: 2 }
    ];
  });
  assert.equal(withPort.report.netcheck.match, true);
  const noVias = run('missing-vias', (d) => { d.pcb.vias = []; }, [], 1);
  assert(noVias.report.drc.findings.some((f) => f.code === 'D004' && f.net === 'RETURN'));
  const disconnected = run('separate-stubs', (d) => {
    d.pcb.tracks.splice(0, 1, { net: 'LINK', layer: 1, width: 10, points: [[179.66, 150], [220, 150]] },
      { net: 'LINK', layer: 1, width: 10, points: [[280, 150], [320.34, 150]] });
  }, [], 1);
  assert(disconnected.report.drc.findings.some((f) => f.code === 'D004' && f.net === 'LINK'));
  const emptyCopper = run('empty-copper', (d) => { d.pcb.tracks = []; d.pcb.vias = []; }, [], 1);
  assert.equal(emptyCopper.report.pcb.rats, 2);
  const draft = run('placement-draft', (d) => { d.pcb.mode = 'placed-only'; delete d.pcb.tracks; delete d.pcb.vias; });
  assert.equal(draft.report.pcb.rats, 2);
  const schematicOnly = run('schematic-only', (d) => { d.pcb = false; });
  assert.equal(schematicOnly.report.pcb.mode, null);
  assert(!fs.readdirSync(path.join(schematicOnly.dir, 'pcb')).some((name) => name.endsWith('.epcb2')));
  const unused = run('unused-pin', (d) => {
    d.parts[0].pins['1'] = 'NC';
    d.parts[1].pins['2'] = 'DNC1';
    d.sch.wires.pop();
    d.pcb.tracks = d.pcb.tracks.filter((t) => t.net === 'LINK');
    d.pcb.vias = [];
  });
  assert.equal(unused.report.audit.ok, true);
  assert.equal(unused.report.netcheck.match, true);
  assert(!unused.report.drc.findings.some((f) => f.code === 'D007'));
  const multilayer = run('inner-layer', (d) => { d.board.layers = 4; d.pcb.tracks[2].layer = 15; });
  const pcbFile = fs.readdirSync(path.join(multilayer.dir, 'pcb')).find((name) => name.endsWith('.epcb2'));
  assert(E.readRecords(path.join(multilayer.dir, 'pcb', pcbFile)).some((r) =>
    r.type === 'LAYER' && r.body.layerId === 15 && r.body.use === true));

  // DRC geometry truthfulness: a 90° pad swaps its world w/h, footprint body
  // extents follow, and pads of ONE footprint overlapping on different nets
  // are a short, not a land-pattern spacing quibble
  const DRC = require('../scripts/lib/drc');
  const rotated = run('rotated-pad', (d) => { d.pcb.place.R1 = [150, 150, 90]; }, [], 1);
  const rotFile = path.join(rotated.dir, 'pcb', pcbFile);
  const rotGeo = DRC.pcbGeometry(rotFile);
  const r1pad = rotGeo.pads.find((p) => p.ref === 'R1');
  assert(r1pad.w > r1pad.h, '90° pad world AABB swaps w/h');
  const r1fp = rotGeo.footprints.find((f) => f.ref === 'R1');
  assert(r1fp.rect.y2 - r1fp.rect.y1 > r1fp.rect.x2 - r1fp.rect.x1, 'footprint extent follows the 90° turn');
  const overlap = run('pad-overlap', (d) => {
    d.parts[0].footprint = { name: 'SHORTFP', designator: 'R', pads: [[1, -10, 0, 60, 60], [2, 10, 0, 60, 60]], outline: [-40, -30, 40, 30] };
  }, [], 1);
  assert(overlap.report.drc.findings.some((f) => f.code === 'D001' && /shorts the two nets/.test(f.msg)));

  // a pour counts as a connection only where its geometry covers same-net
  // pads on a compatible layer
  const noPour = run('pour-base', (d) => { d.pcb.tracks = d.pcb.tracks.filter((t) => t.net !== 'LINK'); }, [], 1);
  assert(noPour.report.drc.findings.some((f) => f.code === 'D004' && f.net === 'LINK'));
  const pourFile = path.join(noPour.dir, 'pcb', pcbFile);
  E.appendLines(pourFile, [E.formatRecord({ type: 'POUR', ticket: 990001, id: 'pourcoverage01' }, {
    partitionId: '', groupId: 0, netName: 'LINK', layerId: 1, width: 0.2, name: 'P', order: 0,
    path: [[100, 100, 'L', 400, 100, 'L', 400, 200, 'L', 100, 200]],
    pourType: { pourType: 'SOLID', fineness: 8 }, keepIsland: false, locked: true, zIndex: -1
  })]);
  assert(!DRC.runDrc(pourFile, {}).findings.some((f) => f.code === 'D004' && f.net === 'LINK'),
    'a covering pour joins its pads');
  E.appendLines(pourFile, [E.formatRecord({ type: 'POUR', ticket: 990002, id: 'pourwronglayer' }, {
    partitionId: '', groupId: 0, netName: 'RETURN', layerId: 1, width: 0.2, name: 'P2', order: 0,
    path: [[100, 100, 'L', 400, 100, 'L', 400, 200, 'L', 100, 200]],
    pourType: { pourType: 'SOLID', fineness: 8 }, keepIsland: false, locked: true, zIndex: -1
  })]);
  // RETURN pads sit on both layers with vias in between: a top pour over BOTH
  // via+pads keeps them grouped through layer 12 … assert the via/pad layering
  // rule by checking the pour over layer 1 does not fake a BOTTOM-only net
  const wrongLayer = DRC.runDrc(pourFile, {});
  assert(wrongLayer.findings.filter((f) => f.code === 'D004').every((f) => f.net === 'RETURN'),
    'only genuinely unrouted nets are reported');
  console.log('PASS: AI-authored geometry, preview, rejection, routing connectivity, NC, inner copper, DRC geometry');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
