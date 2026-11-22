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
  const schematicGap = run('missing-wire', (d) => { d.sch.wires.shift(); }, [], 1);
  assert.equal(schematicGap.report.audit.ok, false);
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
  console.log('PASS: AI-authored geometry, preview, rejection, routing connectivity, NC, and inner copper');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
