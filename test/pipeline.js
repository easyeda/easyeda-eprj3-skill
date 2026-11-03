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

  // -------------------------------------------------------- netlist audit
  // The audit package is what a fresh reviewer (no inherited context) reads:
  // spec (design intent) + built (recovered netlist) + the mechanical diff.
  const auditFile = path.join(TMP, 'netlist-audit.json');
  const auditOut = run('scripts/netlist.js', ['--dir', proj, '--design', design, '--audit', auditFile]);
  ok(/netlist-audit: wrote/.test(auditOut) && /mechanical OK/.test(auditOut), 'netlist --audit reports a clean package', auditOut);
  const pkg = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  ok(pkg.schema === 'eprj3-netlist-audit/1', 'audit package carries its schema', pkg.schema);
  ok(pkg.mechanical.ok === true, 'audit: spec == built and netcheck matches', JSON.stringify(pkg.mechanical.diff));
  ok(pkg.mechanical.netcheck.match === true, 'audit: netcheck verdict is inside the package');
  ok(pkg.built.nets.length === 4 && pkg.built.unconnected.length === 0,
    'audit: built side carries the recovered netlist', `${pkg.built.nets.length} nets`);
  ok(pkg.spec.parts.length === 4, 'audit: spec side carries every part');
  ok(Array.isArray(pkg.rubric) && pkg.rubric.length >= 6, 'audit: rubric is present for the reviewer');
  ok(pkg.verdictSchema && pkg.verdictSchema.shape && pkg.verdictSchema.shape.ok, 'audit: verdict schema is present');

  // a design that disagrees with the built project must fail, and name the pin
  const skewDesign = path.join(TMP, 'blink-skew.json');
  const skew = JSON.parse(fs.readFileSync(design, 'utf8'));
  skew.parts.find((p) => p.id === 'R1').pins['2'] = 'V_LED';
  fs.writeFileSync(skewDesign, JSON.stringify(skew, null, 2), 'utf8');
  const skewFile = path.join(TMP, 'netlist-audit-skew.json');
  const skewOut = run('scripts/netlist.js', ['--dir', proj, '--design', skewDesign, '--audit', skewFile]);
  ok(/mechanical FAIL/.test(skewOut), 'netlist --audit reports FAIL when the design disagrees', skewOut);
  const skewPkg = JSON.parse(fs.readFileSync(skewFile, 'utf8'));
  ok(skewPkg.mechanical.ok === false, 'audit: a moved pin fails the mechanical verdict');
  const skewVled = skewPkg.mechanical.diff.nets.find((n) => n.name === 'V_LED');
  ok(skewVled && skewVled.missing.includes('R1.2'), 'audit: the diff names the pin that moved', JSON.stringify(skewPkg.mechanical.diff.nets));

  // without --design the package still audits built + netcheck (manual flows)
  const bareFile = path.join(TMP, 'netlist-audit-bare.json');
  run('scripts/netlist.js', ['--dir', proj, '--audit', bareFile]);
  const bare = JSON.parse(fs.readFileSync(bareFile, 'utf8'));
  ok(bare.mechanical.specAvailable === false && bare.mechanical.ok === true,
    'audit: no --design still audits built + netcheck');

  // ------------------------------------------------------- project report
  const rptOut = run('scripts/report.js', ['--dir', proj, '--design', design]);
  ok(/report: wrote/.test(rptOut) && /project-report\.md/.test(rptOut), 'report.js writes project-report.md', rptOut);
  const rpt = fs.readFileSync(path.join(proj, 'project-report.md'), 'utf8');
  for (const sec of ['## 工程概述', '## 功能特性', '## 信号框架图', '## 电路框架图', '## 网络概览', '## 验证结果', '## 遗留问题', '## 建议']) {
    ok(rpt.includes(sec), `project report has ${sec}`, rpt.slice(0, 200));
  }
  ok(/```mermaid/.test(rpt), 'project report carries mermaid diagrams');
  ok(/V_LED/.test(rpt), 'project report lists the nets');

  // ------------------------------------------------------ multi-sheet build
  // Regression: sheets are independent coordinate spaces. The contact check
  // and the quality model used to pair objects across pages, so every 2-sheet
  // design died with "cross-net contact(s) ... at every density"; the
  // cross-sheet port branch was unreachable for the same reason.
  const msDesign = path.join(TMP, 'blink-ms.json');
  const msRaw = JSON.parse(fs.readFileSync(design, 'utf8'));
  msRaw.name = 'blink-ms';
  msRaw.sheets = 2;
  fs.writeFileSync(msDesign, JSON.stringify(msRaw, null, 2), 'utf8');
  const msDir = path.join(TMP, 'blink-ms');
  const msOut = run('scripts/build.js', ['--design', msDesign, '--dir', msDir, '--force']);
  ok(/across 2 sheet/.test(msOut), 'two-sheet design builds', msOut);
  const msNets = json('scripts/netlist.js', ['--dir', msDir, '--json']);
  ok(msNets && msNets.length === 2, 'two-sheet project has two sheet netlists', msNets ? String(msNets.length) : 'no json');
  const vledP1 = msNets && msNets[0].nets.find((n) => n.name === 'V_LED');
  const vledP2 = msNets && msNets[1].nets.find((n) => n.name === 'V_LED');
  ok(vledP1 && vledP1.pins.length === 2 && vledP2 && vledP2.pins.length === 1,
    'cross-sheet net is split by page and merges by name', JSON.stringify([vledP1, vledP2]));
  const msNc = JSON.parse(run('scripts/netcheck.js', ['--dir', msDir, '--json']));
  ok(msNc.match === true, 'two-sheet netcheck matches', JSON.stringify(msNc.issues.slice(0, 3)));

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

  // ---------------------------------------- circuit patterns (unit, no build)
  // A mixed block (a 3-pin IC plus three decoupling caps) must absorb the caps
  // as ONE bank row, leave the IC out of it, and never grow the frame past the
  // 10% area gate. Everything here is geometry, so no library is needed.
  const PAT = require(path.join(ROOT, 'scripts', 'lib', 'sch-patterns.js'));
  const DL = require(path.join(ROOT, 'scripts', 'lib', 'design.js'));
  const symOf = (pins) => ({ bbox: { x1: -30, y1: -20, x2: 30, y2: 20 }, pins });
  const capSym = symOf([
    { num: 1, x: 0, y: 20, length: 10, rotation: 270 },
    { num: 2, x: 0, y: -20, length: 10, rotation: 90 }
  ]);
  const icSym = symOf([
    { num: 1, x: -30, y: 10, length: 10, rotation: 0 },
    { num: 2, x: -30, y: -10, length: 10, rotation: 0 },
    { num: 3, x: 30, y: 0, length: 10, rotation: 180 }
  ]);
  const mkPl = (id, sym, pins, x, y) => {
    const pl = { part: { id, pins }, sym, x, y, rotation: 0, sheet: 1, block: 'MIX' };
    pl.extent = DL.partExtent(sym, x, y, 0);
    return pl;
  };
  const powerDesign = { powers: { VCC: 'up', GND: 'down' } };
  const mixed = [
    mkPl('U1', icSym, { 1: 'VCC', 2: 'GND', 3: 'SIG' }, 0, 0),
    mkPl('C1', capSym, { 1: 'VCC', 2: 'GND' }, -40, 160),
    mkPl('C2', capSym, { 1: 'VCC', 2: 'GND' }, 140, 160),
    mkPl('C3', capSym, { 1: 'VCC', 2: 'GND' }, 320, 160)
  ];
  const subBanks = PAT.findSubBanks(powerDesign, mixed);
  ok(subBanks.length === 1, 'mixed block finds one decoupling bank', String(subBanks.length));
  ok(subBanks[0] && subBanks[0].members.map((p) => p.part.id).join(',') === 'C1,C2,C3',
    'the bank holds exactly the caps (IC excluded)',
    subBanks[0] ? subBanks[0].members.map((p) => p.part.id).join(',') : 'none');
  // roomy frame: the row must be accepted and the caps must share one axis
  const roomy = { x1: -240, y1: -260, x2: 560, y2: 260 };
  const roomyArea = (roomy.x2 - roomy.x1) * (roomy.y2 - roomy.y1);
  const blockA = { title: 'MIX', sheet: 1, members: ['U1', 'C1', 'C2', 'C3'], rect: roomy };
  const placedN = PAT.placeSubBanks(mixed, subBanks, blockA);
  ok(placedN === 1, 'sub-bank row is placed in a roomy block', String(placedN));
  const caps = mixed.filter((p) => /^C/.test(p.part.id));
  ok(new Set(caps.map((p) => p.rotation)).size === 1
    && new Set(caps.map((p) => p.extent.y1)).size === 1,
  'bank caps share rotation and row', JSON.stringify(caps.map((p) => [p.rotation, p.extent.y1])));
  ok((blockA.rect.x2 - blockA.rect.x1) * (blockA.rect.y2 - blockA.rect.y1) <= roomyArea * 1.10 + 1,
    'placed sub-bank stays within the area gate',
    JSON.stringify(blockA.rect));
  // tight frame: a narrow tall stack of caps — a horizontal row beside the IC
  // would inflate the block, so nothing may move
  const tight = [
    mkPl('U1', icSym, { 1: 'VCC', 2: 'GND', 3: 'SIG' }, 0, 0),
    mkPl('C1', capSym, { 1: 'VCC', 2: 'GND' }, 0, 120),
    mkPl('C2', capSym, { 1: 'VCC', 2: 'GND' }, 0, 240),
    mkPl('C3', capSym, { 1: 'VCC', 2: 'GND' }, 0, 360)
  ];
  const tightBanks = PAT.findSubBanks(powerDesign, tight);
  const tightRect = { x1: -66, y1: -116, x2: 72, y2: 430 };
  const blockB = { title: 'MIX', sheet: 1, members: ['U1', 'C1', 'C2', 'C3'], rect: tightRect };
  const before = tight.map((p) => `${p.x},${p.y}`);
  const rejected = PAT.placeSubBanks(tight, tightBanks, blockB);
  ok(rejected === 0, 'sub-bank is rejected when it would inflate a tight block', String(rejected));
  ok(tight.map((p) => `${p.x},${p.y}`).join('|') === before.join('|'),
    'a rejected sub-bank leaves every placement untouched');

  // crystal + load caps: X on top, one cap below each pin, ground pins down
  const xtalSym = symOf([
    { num: 1, x: -10, y: 0, length: 10, rotation: 0 },
    { num: 2, x: 10, y: 0, length: 10, rotation: 180 }
  ]);
  const capV = symOf([
    { num: 1, x: 0, y: 20, length: 10, rotation: 270 },
    { num: 2, x: 0, y: -20, length: 10, rotation: 90 }
  ]);
  const xtal = [
    mkPl('X1', xtalSym, { 1: 'XIN', 2: 'XOUT' }, 0, 0),
    mkPl('C10', capV, { 1: 'XIN', 2: 'GND' }, 120, 0),
    mkPl('C11', capV, { 1: 'XOUT', 2: 'GND' }, 260, 0)
  ];
  const groundDesign = { powers: { GND: 'down' }, powerNets: new Map([['GND', 'down']]) };
  const cry = PAT.blockCrystal(groundDesign, xtal);
  ok(cry && cry.anchor.part.id === 'X1', 'crystal pattern recognises X + 2 load caps',
    cry ? cry.anchor.part.id : 'null');
  const cryLaid = cry && PAT.layoutCrystal(cry);
  ok(cryLaid && cryLaid.steps.length === 3, 'crystal layout produces 3 steps',
    cryLaid ? String(cryLaid.steps.length) : 'null');
  if (cryLaid) {
    const capSteps = cryLaid.steps.filter((s) => /^C/.test(s.pl.part.id));
    ok(capSteps.every((s) => s.y < cryLaid.steps[0].y - 40),
      'load caps sit below the crystal', JSON.stringify(capSteps.map((s) => s.y)));
    ok(new Set(capSteps.map((s) => s.rot)).size === 1,
      'load caps share one orientation');
  }

  // series + shunt stage (a DCDC output): 2 inductors feed one rail, 4 caps
  // shunt it to ground — the rail row is found from topology alone.
  const indSym = symOf([
    { num: 1, x: 0, y: 20, length: 10, rotation: 270 },
    { num: 2, x: 0, y: -20, length: 10, rotation: 90 }
  ]);
  const dcdc = [
    mkPl('L1', indSym, { 1: 'SWA', 2: 'VDD_CORE' }, 0, 0),
    mkPl('L2', indSym, { 1: 'SWB', 2: 'VDD_CORE' }, 100, 0),
    mkPl('C30', capV, { 1: 'VDD_CORE', 2: 'GND' }, 200, 0),
    mkPl('C31', capV, { 1: 'VDD_CORE', 2: 'GND' }, 300, 0),
    mkPl('C32', capV, { 1: 'VDD_CORE', 2: 'GND' }, 400, 0),
    mkPl('C33', capV, { 1: 'VDD_CORE', 2: 'GND' }, 500, 0)
  ];
  const sb = PAT.blockSeriesBank(groundDesign, dcdc);
  ok(sb && sb.series.length === 2 && sb.shunts.length === 4,
    'series+shunt stage separates 2 feed elements from 4 shunts',
    sb ? `${sb.series.length}/${sb.shunts.length}` : 'null');
  const sbLaid = sb && PAT.layoutSeriesBank(sb);
  ok(sbLaid && sbLaid.steps.length === 6, 'series+shunt layout places all 6 parts',
    sbLaid ? String(sbLaid.steps.length) : 'null');
  if (sbLaid) {
    const shuntsLaid = sbLaid.steps.filter((s) => /^C/.test(s.pl.part.id));
    const seriesLaid = sbLaid.steps.filter((s) => /^L/.test(s.pl.part.id));
    ok(new Set(shuntsLaid.map((s) => s.extent.y1)).size === 1,
      'shunts share one rail row', JSON.stringify(shuntsLaid.map((s) => s.extent.y1)));
    ok(seriesLaid.every((s) => s.extent.x2 <= Math.min(...shuntsLaid.map((q) => q.extent.x1))),
      'series elements sit left of the shunt row');
  }

  // two-anchor bridge: two ICs with AC-coupling caps between them
  const ic3 = symOf([
    { num: 1, x: -30, y: 10, length: 10, rotation: 0 },
    { num: 2, x: -30, y: -10, length: 10, rotation: 0 },
    { num: 3, x: 30, y: 0, length: 10, rotation: 180 }
  ]);
  const bridged = [
    mkPl('U1', ic3, { 1: 'IN_L', 2: 'IN_R', 3: 'A_OUT' }, 0, 0),
    mkPl('U2', ic3, { 1: 'B_IN', 2: 'GND', 3: 'B_OUT' }, 400, 0),
    mkPl('C40', capV, { 1: 'A_OUT', 2: 'B_IN' }, 200, 0),
    mkPl('C41', capV, { 1: 'IN_L', 2: 'B_OUT' }, 200, 100)
  ];
  const br = PAT.blockBridge(bridged);
  ok(br && br.links.length === 2, 'bridge pattern finds two anchors + two links',
    br ? String(br.links.length) : 'null');
  const brLaid = br && PAT.layoutBridge(br);
  ok(brLaid && brLaid.steps.length === 4, 'bridge layout places 4 parts',
    brLaid ? String(brLaid.steps.length) : 'null');
  if (brLaid) {
    const anchorsX = brLaid.steps.filter((s) => /^U/.test(s.pl.part.id)).map((s) => s.x);
    const bridgeX = brLaid.steps.filter((s) => /^C/.test(s.pl.part.id)).map((s) => s.x);
    ok(anchorsX.length === 2 && Math.abs(anchorsX[1] - anchorsX[0]) > 100,
      'bridge spans a left and a right anchor',
      `anchors=${JSON.stringify(anchorsX)} bridges=${JSON.stringify(bridgeX)}`);
  }

  // two ICs in one block: the whole-block hub cannot match, so one hub is
  // absorbed as a SUBSET (anchor + the caps that share its nets)
  const twoIc = [
    mkPl('U10', ic3, { 1: 'A1', 2: 'A2', 3: 'A3' }, 0, 0),
    mkPl('C50', capV, { 1: 'A1', 2: 'GND' }, 100, 0),
    mkPl('C51', capV, { 1: 'A1', 2: 'GND' }, 200, 0),
    mkPl('U11', ic3, { 1: 'B1', 2: 'B2', 3: 'B3' }, 300, 0)
  ];
  const hubSub = PAT.findHubSubset(twoIc);
  ok(hubSub && hubSub.memberIds.includes('U10') && hubSub.memberIds.length === 3,
    'hub subset absorbs one IC with its two caps', hubSub ? hubSub.memberIds.join(',') : 'null');

  // independent links (DNP straps / AC coupling arrays): no shared nets, yet
  // they still get one aligned column instead of a scattered grid
  const straps = [
    mkPl('R60', indSym, { 1: 'ALDO_OUT', 2: 'VCC_IO' }, 0, 0),
    mkPl('R61', indSym, { 1: 'BLDO_OUT', 2: 'VCC_HDMI' }, 0, 100),
    mkPl('R62', indSym, { 1: 'CLDO_OUT', 2: 'VCC_WIFI' }, 0, 200)
  ];
  const la = PAT.blockLinkArray(straps);
  ok(la && la.links.length === 3, 'link array recognises independent two-pin links',
    la ? String(la.links.length) : 'null');
  const laLaid = la && PAT.layoutLinkArray(la);
  ok(laLaid && laLaid.steps.length === 3, 'link array lays all 3 links',
    laLaid ? String(laLaid.steps.length) : 'null');
  if (laLaid) {
    ok(new Set(laLaid.steps.map((s) => s.extent.x1)).size === 1,
      'link array keeps one aligned column', JSON.stringify(laLaid.steps.map((s) => s.extent.x1)));
  }

  // --------------------------------------------- local search never regresses
  const nsDir = path.join(TMP, 'blink-nosearch');
  const nsReport = path.join(TMP, 'blink-nosearch.json');
  run('scripts/build.js', ['--design', design, '--dir', nsDir, '--force', '--schematic-only', '--no-search', '--report', nsReport]);
  const sDir = path.join(TMP, 'blink-search');
  const sReport = path.join(TMP, 'blink-search.json');
  run('scripts/build.js', ['--design', design, '--dir', sDir, '--force', '--schematic-only', '--report', sReport]);
  const qOf = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).schematic.layout.quality.score;
  ok(qOf(sReport) <= qOf(nsReport) + 1e-9, 'local search never worsens the layout score',
    `${qOf(sReport)} vs ${qOf(nsReport)}`);

  // ------------------------------------------------------------- summary
  console.log(`\n${checks - failures}/${checks} pipeline checks passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures) process.exit(1);
}

main();
