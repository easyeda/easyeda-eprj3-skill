#!/usr/bin/env node
'use strict';
/**
 * test/pipeline.js — regression suite for the declaration → build → check path.
 *
 * `test/smoke.js` covers the record-level primitives (things that must open in
 * the real client). This suite covers the layer above: a design file must build
 * into a project whose netlist, layout and copper all pass their gates, and the
 * newer CLIs (netlist/erc/lint/drc/pins/render/eval) must behave.
 *
 *   node test/pipeline.js
 *
 * Exits 1 on the first failing assertion group.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `eprj3-pipeline-${process.pid}`);
let failures = 0;
let checks = 0;

function ok(cond, name, detail) {
  checks += 1;
  if (cond) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(script, args, expect = 0) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, script)].concat(args), {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? 1 : e.status;
  }
  if (code !== expect) {
    failures += 1;
    console.error(`FAIL ${script} ${args.join(' ')} exited ${code} (want ${expect})\n${out.slice(0, 1200)}`);
  }
  checks += 1;
  return out;
}

function json(script, args) {
  const out = run(script, args);
  const startObj = out.indexOf('{');
  const startArr = out.indexOf('[');
  const start = [startObj, startArr].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return null;
  const end = Math.max(out.lastIndexOf('}'), out.lastIndexOf(']'));
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const design = path.join(ROOT, 'examples', 'designs', 'blink.json');
  const proj = path.join(TMP, 'blink');

  // ---------------------------------------------------------------- build
  const buildOut = run('scripts/build.js', ['--design', design, '--dir', proj]);
  ok(/4 components/.test(buildOut), 'build reports 4 components', buildOut);
  ok(/lint 100\/100/.test(buildOut), 'build reports lint 100', buildOut);
  ok(/drc 100\/100/.test(buildOut), 'build reports drc 100', buildOut);
  ok(fs.existsSync(proj), 'project directory exists');
  ok(!fs.existsSync(path.join(proj, '.tmp')), 'temp staging removed from the finished project');

  // ---------------------------------------------------------------- gates
  const v = run('scripts/validate.js', ['--dir', proj, '--json']);
  const vj = JSON.parse(v.slice(v.indexOf('{'), v.lastIndexOf('}') + 1));
  ok(vj.errors.length === 0, 'validate has no errors', JSON.stringify(vj.errors));

  const erc = json('scripts/erc.js', ['--dir', proj, '--design', design, '--json']);
  ok(erc && erc.errors.length === 0, 'erc has no errors', erc ? JSON.stringify(erc.errors) : 'no json');

  const lint = json('scripts/lint-layout.js', ['--dir', proj, '--json']);
  ok(lint && lint.errors === 0, 'layout lint has no errors');
  ok(lint && lint.score === 100, 'layout score is 100');

  const drc = json('scripts/drc.js', ['--dir', proj, '--json']);
  ok(drc && drc.errors === 0, 'drc has no errors', drc ? JSON.stringify(drc.findings.filter((f) => f.level === 'error')) : 'no json');
  ok(drc && drc.counts.pours >= 2, 'two copper pours exist');
  ok(drc && drc.counts.vias > 10, 'stitching vias were added');

  // -------------------------------------------------------------- netlist
  const nl = json('scripts/netlist.js', ['--dir', proj, '--json']);
  ok(nl && nl.length === 1, 'one sheet in the netlist');
  const nets = nl ? nl[0].nets : [];
  const names = nets.map((n) => n.name).sort();
  ok(names.join(',') === 'GND,LED_A,VCC,V_LED', 'netlist has exactly the 4 expected nets', names.join(','));
  const vled = nets.find((n) => n.name === 'V_LED');
  ok(vled && vled.pins.length === 3, 'V_LED connects 3 pins', JSON.stringify(vled));
  ok(nl && nl[0].unconnected.length === 0, 'no unconnected pins');

  // ------------------------------------------------------------- pins CLI
  const pinsOut = run('scripts/pins.js', ['--dir', proj]);
  ok(/R1\.2/.test(pinsOut), 'pins lists R1.2', pinsOut);
  const pinsJson = JSON.parse(run('scripts/pins.js', ['--dir', proj, '--json']));
  ok(pinsJson.length >= 8, 'pins lists at least 8 component pins', String(pinsJson.length));

  // -------------------------------------------------- wire by pin reference
  const wireOut = run('scripts/add-wire.js', ['--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1',
    '--from', 'R1.2', '--to', 'D2.1', '--net', 'LED_A']);
  ok(/R1\.2 → D2\.1/.test(wireOut), 'add-wire resolved pin references', wireOut);
  const erc2 = json('scripts/erc.js', ['--dir', proj, '--design', design, '--json']);
  ok(erc2 && erc2.errors.length === 0, 'netlist still correct after pin-reference wiring');

  // -------------------------------------------------------------- render
  const renderOut = run('scripts/render.js', ['--dir', proj]);
  ok(/\.svg/.test(renderOut), 'render wrote an SVG', renderOut);
  const svgFile = path.join(proj, 'preview', 'Schematic1_P1.svg');
  ok(fs.existsSync(svgFile), 'SVG preview exists');
  const svg = fs.readFileSync(svgFile, 'utf8');
  ok(/^<svg /.test(svg) && /<\/svg>$/.test(svg.trim()), 'SVG is well formed');
  ok((svg.match(/<line /g) || []).length > 5, 'SVG contains wires');

  // ------------------------------------------------------------- dry run
  const dryDir = path.join(TMP, 'dry');
  const dryOut = run('scripts/build.js', ['--design', design, '--dir', dryDir, '--dry-run', '--quiet']);
  ok(/dry run/.test(dryOut), 'dry run says so', dryOut);
  ok(!fs.existsSync(dryDir), 'dry run left no directory behind');

  // --------------------------------------------------- error handling path
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({
    name: 'bad',
    parts: [{ id: 'U1', symbol: { name: 'X', pins: ['1:A', '2:B'] }, footprint: 'R0603', pins: { 1: 'A' } }]
  }), 'utf8');
  const badOut = run('scripts/build.js', ['--design', bad, '--dir', path.join(TMP, 'bad')], 1);
  ok(/E001|unconnected|ERC error/i.test(badOut), 'design with a floating pin is rejected', badOut);

  // ------------------------------------------------------------- summary
  console.log(`\n${checks - failures}/${checks} pipeline checks passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures) process.exit(1);
}

main();
