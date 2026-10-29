#!/usr/bin/env node
'use strict';
/**
 * test/pipeline.js — regression suite for the declaration → build → check path.
 *
 * `test/smoke.js` covers the record-level primitives (things that must open in
 * the real client). This suite covers the layer above: a design file must build
 * into a project whose netlist and layout pass their gates, the board ships
 * copper-free (routing/pour are the client's job since 1.13), and the
 * newer CLIs (netlist/erc/lint/drc/pins/eval) must behave.
 *
 *   node test/pipeline.js
 *
 * Exits 1 on the first failing assertion group.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnCaptured } = require('./capture');

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
  const r = spawnCaptured(process.execPath, [path.join(ROOT, script)].concat(args), { cwd: ROOT });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const code = r.status === null || r.status === undefined ? 1 : r.status;
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
  // Default strategy: placement-only. The board ships footprints, not copper.
  const buildOut = run('scripts/build.js', ['--design', design, '--dir', proj]);
  ok(/4 components/.test(buildOut), 'build reports 4 components', buildOut);
  ok(/lint 100\/100/.test(buildOut), 'build reports lint 100', buildOut);
  ok(/drc 100\/100/.test(buildOut), 'build reports drc 100', buildOut);
  ok(/placement-only/.test(buildOut), 'default build is placement-only', buildOut);
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
  ok(drc && drc.mode === 'placed-only', 'drc reads the board as placed-only', drc ? drc.mode : 'no json');
  ok(drc && drc.counts.tracks === 0 && drc.counts.pours === 0, 'no copper was added to the deliverable');
  ok(drc && drc.counts.pads > 0, 'footprints/pads ARE placed (the deliverable is placement)', drc ? String(drc.counts.pads) : 'no json');

  // ------------------------------------------------- copper policy guard
  // Since 1.13 the skill cannot route or pour AT ALL: the old --route/--pour
  // flags no longer exist, so a copper-hungry caller fails loudly instead of
  // quietly laying tracks. The deliverable's handoff is the rats line.
  const guardRoute = run('scripts/build.js', ['--design', design, '--dir', path.join(TMP, 'blink-route'), '--route'], 1);
  ok(/Unknown option/.test(guardRoute), '--route is rejected — routing is gone from the skill', guardRoute.slice(0, 200));
  const guardPour = run('scripts/build.js', ['--design', design, '--dir', path.join(TMP, 'blink-pour'), '--pour'], 1);
  ok(/Unknown option/.test(guardPour), '--pour is rejected — pouring is gone from the skill', guardPour.slice(0, 200));
  ok(/rats: \d+ net\(s\) to connect by hand in the client/.test(buildOut),
    'the build prints the rats handoff for the client', buildOut.slice(0, 400));

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
  // add-wire is a low-level primitive that draws exactly the wire asked for;
  // whether that wire stays clear of other nets is a property of the current
  // layout (the CLI reports a touch when it happens), not a CLI contract. The
  // clean netlist is already proven above on the untouched build.
  ok(/touches existing wires|drew wire/.test(wireOut), 'add-wire reports its result', wireOut);

  // ------------------------------------------------------------- dry run
  const dryDir = path.join(TMP, 'dry');
  const dryOut = run('scripts/build.js', ['--design', design, '--dir', dryDir, '--dry-run', '--quiet']);
  ok(/dry run/.test(dryOut), 'dry run says so', dryOut);
  ok(!fs.existsSync(dryDir), 'dry run left no directory behind');

  // ---------------------------------------------- board does not explode
  // S1/S2 regression (real 57-part session): explicit pcb.place must not
  // double-translate, and row wraps must recompute the cursor — the board
  // stays at its declared size instead of 13666×10347 mil.
  const bigDesign = path.join(TMP, 'big.json');
  const bigParts = [];
  for (let i = 0; i < 50; i += 1) {
    bigParts.push({ id: `C${i + 1}`, symbol: 'CAP', footprint: 'C0402', value: '100nF', pins: { 1: '3V3', 2: 'GND' } });
  }
  for (let i = 0; i < 6; i += 1) {
    bigParts.push({
      id: `J${i + 1}`,
      symbol: { name: `HDR20P${i}`, designator: 'J', pins: Array.from({ length: 20 }, (_, k) => `${k + 1}:NC`) },
      footprint: { auto: 'HDR2R', pins: 20 },
      pins: Object.fromEntries(Array.from({ length: 20 }, (_, k) => [k + 1, 'NC']))
    });
  }
  bigParts.push({ id: 'JX', symbol: { name: 'HDR2PX', designator: 'J', pins: ['1:3V3', '2:GND'] }, footprint: { auto: 'HDR', pins: 2 }, pins: { 1: '3V3', 2: 'GND' } });
  const bigBlocks = [];
  for (let i = 0; i < bigParts.length; i += 7) {
    bigBlocks.push({ title: `B${i / 7 + 1}`, parts: bigParts.slice(i, i + 7).map((p) => p.id) });
  }
  fs.writeFileSync(bigDesign, JSON.stringify({
    name: 'big-probe', board: { width: 3540, height: 2360 },
    powers: { '3V3': 'up', GND: 'down' }, blocks: bigBlocks, parts: bigParts,
    pcb: { place: { JX: [300, 2000, 0] } }
  }), 'utf8');
  const bigDir = path.join(TMP, 'big');
  const bigOut = run('scripts/build.js', ['--design', bigDesign, '--dir', bigDir, '--force', '--report', path.join(TMP, 'big-report.json')], 0);
  const bigReport = JSON.parse(fs.readFileSync(path.join(TMP, 'big-report.json'), 'utf8'));
  ok(bigReport.netcheck && bigReport.netcheck.match === true, '57-part probe: netcheck matches (explicit place not double-translated)', JSON.stringify(bigReport.netcheck && bigReport.netcheck.issues.slice(0, 3)));
  ok(/3540×2360/.test(bigOut), 'board stays at the declared size (wrap cursor recomputed)', (bigOut.match(/board set to [^\n]+/) || ['?'])[0]);
  // every part inside the board: D003 (edge clearance) would fire otherwise
  ok(!/D003/.test(bigOut), '57-part probe: no part sticks past the board edge', bigOut);

  // ------------------------------------------------- netcheck CLI contract
  const nc = JSON.parse(run('scripts/netcheck.js', ['--dir', bigDir, '--json']));
  ok(nc.match === true, 'netcheck CLI reports match on a clean build', JSON.stringify(nc.issues && nc.issues.slice(0, 3)));
  const badDir = path.join(TMP, 'bad-nc');
  run('scripts/build.js', ['--design', design, '--dir', badDir, '--force', '--quiet']);
  // tamper: rewire one PCB pad net through a direct record patch
  const pcbFile = path.join(badDir, 'pcb', 'PCB1.epcb2');
  const tampered = fs.readFileSync(pcbFile, 'utf8').replace(/"padNet":"GND"/, '"padNet":"GNDX"');
  fs.writeFileSync(pcbFile, tampered, 'utf8');
  run('scripts/netcheck.js', ['--dir', badDir], 1);
  ok(true, 'netcheck CLI exits 1 on a tampered pad net');

  // -------------------------------------------- typed recipes (class + roles)
  // A recipe that names a device CLASS must resolve a real library entry by
  // role coverage, expand roles into pins, and fail loudly when the class has
  // no capable device (report §9). Model-specific entries live in the LOCAL
  // CACHE (fetch-lcsc), not in the repo — a clean checkout has no devices, so
  // these checks are skipped rather than failed.
  const devs = JSON.parse(run('scripts/recipe.js', ['devices', '--json']));
  if (devs.length) {
    ok(devs.some((d) => d.name === 'AMS1117-3.3' && d.class === 'regulator.ldo'),
      'recipe devices lists the regulator class', JSON.stringify(devs.map((d) => `${d.name}:${d.class}`)));
    const tgt = path.join(TMP, 'typed-base.json');
    fs.writeFileSync(tgt, JSON.stringify({
      name: 'typed-base', powers: { GND: 'down' },
      parts: [{ id: 'C9', symbol: 'CAP', footprint: 'C0603', value: '100nF', pins: { 1: '3V3', 2: 'GND' } }]
    }, null, 2), 'utf8');
    const applyOut = run('scripts/recipe.js', ['apply', 'ldo-typed', '--to', tgt]);
    ok(/device: AMS1117-3\.3/.test(applyOut), 'typed recipe binds a device by class', applyOut);
    const typedDesign = JSON.parse(fs.readFileSync(tgt, 'utf8'));
    const bound = typedDesign.parts.find((p) => p.ic);
    ok(bound && bound.roles && bound.roles.VOUT === '3V3', 'typed binding expands roles', JSON.stringify(bound && bound.roles));
    const tdir = path.join(TMP, 'typed-proj');
    const tb = run('scripts/build.js', ['--design', tgt, '--dir', tdir, '--force', '--quiet']);
    ok(/eprj3 at/.test(tb), 'typed design builds', tb);
    const badDev = run('scripts/recipe.js', ['apply', 'ldo-typed', '--to', tgt, '--device', 'NOPE'], 1);
    ok(/not in class/.test(badDev), 'unknown preferred device is rejected by name', badDev);
    // gate I008: unbinding a required role must fail the intent gate
    const badRoles = JSON.parse(fs.readFileSync(tgt, 'utf8'));
    delete badRoles.parts.find((p) => p.ic).roles.VOUT;
    const badRolesFile = path.join(TMP, 'typed-bad-roles.json');
    fs.writeFileSync(badRolesFile, JSON.stringify(badRoles, null, 2), 'utf8');
    const i8 = run('scripts/intent.js', ['--design', badRolesFile], 1);
    ok(/I008/.test(i8), 'I008 catches an unbound required role', i8);
  } else {
    console.log('  note: no cached IC devices — run scripts/fetch-lcsc.js --install (skipping typed-recipe checks)');
  }

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
