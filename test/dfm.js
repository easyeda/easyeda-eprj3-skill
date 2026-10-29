#!/usr/bin/env node
'use strict';
/**
 * test/dfm.js — DFM rules D009–D012 of scripts/lib/drc.js.
 *
 *   node test/dfm.js
 *
 * The checker only needs the record shape, so most fixtures are synthetic
 * single-file PCB documents (PCB DOCHEAD + one component with a footprint +
 * the geometry under test). The last group is the regression contract: a real
 * blink build must gain ZERO DFM findings — the shipped footprints are SMD and
 * the default via is 24/12 mil, and every eval case keeps minDrc 100.
 *
 * Exits 1 when any assertion fails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnCaptured } = require('./capture');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `eprj3-dfm-${process.pid}`);
const { runDrc, RULES, DEFAULTS, pcbGeometry } = require(path.join(ROOT, 'scripts/lib/drc.js'));

let checks = 0;
let failures = 0;
function ok(cond, name, detail) {
  checks += 1;
  if (cond) return;
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${String(detail).slice(0, 800)}` : ''}`);
}

// ---------------------------------------------------------------- fixtures
// record line in the exact .epcb2 shape parseRecord expects
function rec(type, id, body) {
  return `${JSON.stringify({ type, ticket: 1, id })}||${JSON.stringify(body || {})}|`;
}
// docSplit matches the literal prefix — DOCHEAD heads carry no ticket/id
function docHead(docType, uuid) {
  return `{"type":"DOCHEAD"}||${JSON.stringify({ docType, uuid })}|`;
}

/**
 * PCB file: a 1000×1000 mil board with a GND pour (so D005/D006 stay quiet),
 * one unrotated top-side component `R1` carrying the given pads, and `lines`
 * (LINE / VIA / STRING records) inside the PCB document.
 */
function pcbFile(pads, lines) {
  fs.mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, `pcb-${Math.random().toString(36).slice(2, 8)}.epcb2`);
  const padRecs = pads.map((p, i) => rec('PAD', `e${i}`, {
    num: String(p.num),
    layerId: p.layer === undefined ? 1 : p.layer,
    centerX: p.x, centerY: p.y,
    hole: p.hole === undefined ? null : p.hole,
    defaultPad: { padType: 'RECT', width: p.w, height: p.h, radius: 0 }
  }));
  const text = [
    docHead('PCB', 'pcb1'),
    rec('COMPONENT', 'c1', { layerId: 1, x: 0, y: 0, angle: 0 }),
    rec('ATTR', 'a1', { parentId: 'c1', key: 'Footprint', value: 'fp1' }),
    rec('ATTR', 'a2', { parentId: 'c1', key: 'Designator', value: 'R1' }),
    rec('POUR', 'po1', { netName: 'GND', layerId: 1 }),
    rec('POLY', 'ol1', { polyType: 'BOARD_OUTLINE', path: ['R', 0, 1000, 1000, 1000] }),
    ...lines,
    docHead('FOOTPRINT', 'fp1'),
    ...padRecs
  ].join('\n') + '\n';
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

const via = (id, b) => rec('VIA', id, Object.assign({ netName: 'SIG', centerX: 700, centerY: 700, viaDiameter: 24, holeDiameter: 12 }, b));
const track = (id, b) => rec('LINE', id, Object.assign({ netName: 'SIG', layerId: 1, width: 8 }, b));
const str = (id, b) => rec('STRING', id, Object.assign({ fontSize: 60, angle: 0, origin: 'CENTER_MIDDLE' }, b));
const codes = (r) => r.findings.map((f) => f.code);
const forCode = (r, code) => r.findings.filter((f) => f.code === code);

// -------------------------------------------------------------------- main
function main() {
  fs.rmSync(TMP, { recursive: true, force: true });

  // ------------------------------------------------------------ rule table
  for (const code of ['D009', 'D010', 'D011', 'D012']) {
    const r = RULES[code];
    ok(!!r, `${code} is in the RULES table`, JSON.stringify(Object.keys(RULES)));
    ok(r && (r.level === 'error' || r.level === 'warn'), `${code} has a valid level`, r && r.level);
    ok(r && r.weight >= 2 && r.weight <= 6, `${code} weight is 2–6`, r && r.weight);
    ok(r && typeof r.text === 'string' && r.text.length > 0, `${code} has --rules text`);
  }
  ok(RULES.D009.level === 'error', 'D009 (min drill) is an error', RULES.D009.level);
  for (const code of ['D010', 'D011', 'D012']) {
    ok(RULES[code].level === 'warn', `${code} is a warning`, RULES[code].level);
  }
  ok(DEFAULTS.minDrill === 12, 'default minDrill is 12 mil (0.3 mm)', DEFAULTS.minDrill);
  ok(DEFAULTS.minRing === 4, 'default minRing is 4 mil (≈0.1 mm)', DEFAULTS.minRing);
  ok(DEFAULTS.minAngle === 45, 'default minAngle is 45°', DEFAULTS.minAngle);

  // ------------------------------------------------------------------ D009
  // via drill 8 < 12 → error; ring (24−8)/2 = 8 keeps D010 quiet.
  let f = pcbFile([], [via('v1', { holeDiameter: 8 })]);
  let r = runDrc(f, {});
  let d = forCode(r, 'D009')[0];
  ok(!!d && d.level === 'error', 'D009: sub-minimum via drill is an error', JSON.stringify(r.findings));
  ok(d && /drill/i.test(d.msg) && d.net === 'SIG', 'D009 msg names the drill and net', d && d.msg);
  ok(d && typeof d.fix === 'string' && /viaDrill/.test(d.fix), 'D009 fix names pcb.rules.viaDrill', d && d.fix);
  ok(!codes(r).includes('D010'), 'D009 fixture does not also fire D010', JSON.stringify(codes(r)));

  // exactly 12 mil is legal — the shipped default via sits right on the limit.
  f = pcbFile([], [via('v1', {})]);
  ok(!codes(runDrc(f, {})).includes('D009'), 'D009: a 12 mil drill passes', JSON.stringify(codes(runDrc(f, {}))));

  // through-hole pad drill 8 → error
  f = pcbFile([{ num: 1, x: 500, y: 500, w: 30, h: 40, hole: 8, layer: 12 }], []);
  r = runDrc(f, {});
  d = forCode(r, 'D009')[0];
  ok(!!d && /pad R1\.1/.test(d.msg), 'D009: sub-minimum pad drill is reported', JSON.stringify(r.findings));
  ok(d && typeof d.fix === 'string' && d.fix.length > 10, 'D009 pad finding carries a fix', d && d.fix);

  // threshold override through opts.rules
  f = pcbFile([], [via('v1', { holeDiameter: 10 })]);
  ok(!codes(runDrc(f, { rules: { minDrill: 10 } })).includes('D009'), 'D009 honours a relaxed minDrill');
  ok(codes(runDrc(f, { rules: { minDrill: 13 } })).includes('D009'), 'D009 honours a stricter minDrill');

  // ------------------------------------------------------------------ D010
  // outer 16, drill 12 → ring 2 < 4 → warn; drill is legal so D009 stays quiet.
  f = pcbFile([], [via('v1', { viaDiameter: 16 })]);
  r = runDrc(f, {});
  d = forCode(r, 'D010')[0];
  ok(!!d && d.level === 'warn', 'D010: thin via ring is a warning', JSON.stringify(r.findings));
  ok(d && /ring/i.test(d.msg) && typeof d.fix === 'string' && /viaDiameter/.test(d.fix), 'D010 fix names pcb.rules.viaDiameter', d && d.fix);
  ok(!codes(r).includes('D009'), 'D010 via fixture does not also fire D009', JSON.stringify(codes(r)));

  // the shipped 24/12 via → ring 6 → quiet
  f = pcbFile([], [via('v1', {})]);
  ok(!codes(runDrc(f, {})).includes('D010'), 'D010: default 24/12 via ring passes', JSON.stringify(codes(runDrc(f, {}))));

  // pad ring: copper 14, drill 12 → ring 1
  f = pcbFile([{ num: 1, x: 500, y: 500, w: 14, h: 14, hole: 12, layer: 12 }], []);
  r = runDrc(f, {});
  d = forCode(r, 'D010')[0];
  ok(!!d && /pad R1\.1/.test(d.msg), 'D010: thin pad ring is reported', JSON.stringify(r.findings));
  ok(d && typeof d.fix === 'string' && d.fix.length > 10, 'D010 pad finding carries a fix', d && d.fix);

  // ------------------------------------------------------------------ D011
  // top-silk text landing on a top-side pad.
  f = pcbFile([{ num: 1, x: 500, y: 500, w: 20, h: 20, layer: 1 }], [
    str('s1', { layerId: 3, x: 500, y: 500, text: 'R1' })
  ]);
  r = runDrc(f, {});
  d = forCode(r, 'D011')[0];
  ok(!!d && d.level === 'warn', 'D011: silk text over a pad is a warning', JSON.stringify(r.findings));
  ok(d && /pad R1\.1/.test(d.msg), 'D011 msg names the colliding pad', d && d.msg);
  ok(d && typeof d.fix === 'string' && /add-pcb-text/.test(d.fix), 'D011 fix points at the text tool', d && d.fix);

  // bottom silk does not reach a top pad
  f = pcbFile([{ num: 1, x: 500, y: 500, w: 20, h: 20, layer: 1 }], [
    str('s1', { layerId: 4, x: 500, y: 500, text: 'R1' })
  ]);
  ok(!codes(runDrc(f, {})).includes('D011'), 'D011: bottom silk ignores a top pad', JSON.stringify(codes(runDrc(f, {}))));

  // clear text stays silent
  f = pcbFile([{ num: 1, x: 500, y: 500, w: 20, h: 20, layer: 1 }], [
    str('s1', { layerId: 3, x: 850, y: 850, text: 'REV A' })
  ]);
  ok(!codes(runDrc(f, {})).includes('D011'), 'D011: silk in the clear is silent', JSON.stringify(codes(runDrc(f, {}))));

  // rotated long label: LEFT_BOTTOM at 90° runs straight over the pad
  f = pcbFile([{ num: 1, x: 500, y: 500, w: 20, h: 20, layer: 1 }], [
    str('s1', { layerId: 3, x: 500, y: 400, text: 'AAAAAAAAAAAAAAAAAAAAAAAA', fontSize: 45, angle: 90, origin: 'LEFT_BOTTOM' })
  ]);
  ok(codes(runDrc(f, {})).includes('D011'), 'D011: rotated silk text is measured', JSON.stringify(codes(runDrc(f, {}))));

  // one finding per string even when it covers several pads
  f = pcbFile([
    { num: 1, x: 500, y: 500, w: 20, h: 20, layer: 1 },
    { num: 2, x: 540, y: 500, w: 20, h: 20, layer: 1 }
  ], [str('s1', { layerId: 3, x: 520, y: 500, text: 'R1 R2' })]);
  ok(forCode(runDrc(f, {}), 'D011').length === 1, 'D011: reported once per text string', JSON.stringify(codes(runDrc(f, {}))));

  // ------------------------------------------------------------------ D012
  const acute = () => [
    track('t1', { startX: 200, startY: 200, endX: 400, endY: 200 }),
    track('t2', { startX: 200, startY: 200, endX: 390, endY: 230 })
  ];
  f = pcbFile([], acute());
  r = runDrc(f, {});
  d = forCode(r, 'D012')[0];
  ok(!!d && d.level === 'warn', 'D012: acute bend is a warning', JSON.stringify(r.findings));
  ok(d && d.net === 'SIG' && /bends \d+°/.test(d.msg), 'D012 msg carries the angle and net', d && d.msg);
  ok(d && typeof d.fix === 'string' && /45°/.test(d.fix), 'D012 fix suggests a 45° chamfer', d && d.fix);

  // a 90° corner is legal
  f = pcbFile([], [
    track('t1', { startX: 200, startY: 200, endX: 400, endY: 200 }),
    track('t2', { startX: 400, startY: 200, endX: 400, endY: 400 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: a 90° corner is legal', JSON.stringify(codes(runDrc(f, {}))));

  // exactly 45° (the shape the fix asks for) is legal
  f = pcbFile([], [
    track('t1', { startX: 300, startY: 300, endX: 500, endY: 300 }),
    track('t2', { startX: 300, startY: 300, endX: 400, endY: 200 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: a 45° chamfer is legal', JSON.stringify(codes(runDrc(f, {}))));

  // copper folded back on itself (0°) is an overlap, not a wedge — the router
  // emits these as pad stubs and the 17 eval cases would light up otherwise.
  f = pcbFile([], [
    track('t1', { startX: 200, startY: 200, endX: 500, endY: 200 }),
    track('t2', { startX: 500, startY: 200, endX: 490, endY: 200 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: 0° backtrack is not a wedge', JSON.stringify(codes(runDrc(f, {}))));

  // only same-net, same-layer segments are compared
  f = pcbFile([], [
    track('t1', { netName: 'A', startX: 200, startY: 200, endX: 400, endY: 200 }),
    track('t2', { netName: 'B', startX: 200, startY: 200, endX: 390, endY: 230 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: different nets are not compared', JSON.stringify(codes(runDrc(f, {}))));
  f = pcbFile([], [
    track('t1', { startX: 200, startY: 200, endX: 400, endY: 200 }),
    track('t2', { layerId: 2, startX: 200, startY: 200, endX: 390, endY: 230 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: different layers are not compared', JSON.stringify(codes(runDrc(f, {}))));

  // segments that merely CROSS (no shared endpoint) are not compared
  f = pcbFile([], [
    track('t1', { startX: 200, startY: 300, endX: 600, endY: 300 }),
    track('t2', { startX: 398, startY: 200, endX: 400, endY: 400 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: crossing without a shared endpoint is silent', JSON.stringify(codes(runDrc(f, {}))));

  // threshold override: 60° is legal by default, acute under minAngle 65
  f = pcbFile([], [
    track('t1', { startX: 200, startY: 200, endX: 400, endY: 200 }),
    track('t2', { startX: 200, startY: 200, endX: 300, endY: 373.205 })
  ]);
  ok(!codes(runDrc(f, {})).includes('D012'), 'D012: 60° is legal at the default 45° floor');
  ok(codes(runDrc(f, { rules: { minAngle: 65 } })).includes('D012'), 'D012 honours a stricter minAngle');

  // ------------------------------------------------------------------ score
  // new findings deduct exactly like the older rules
  f = pcbFile([], acute().concat([via('v1', { holeDiameter: 8 })]));
  r = runDrc(f, {});
  ok(r.findings.length === 2, 'score fixture has exactly D009 + D012', JSON.stringify(codes(r)));
  ok(r.score === 100 - RULES.D009.weight - RULES.D012.weight, 'score deducts the new weights', `${r.score} vs ${JSON.stringify(codes(r))}`);
  ok(r.errors === 1 && r.warnings === 1, 'errors/warnings counted', `${r.errors}/${r.warnings}`);

  // --------------------------------------------------------- no-regression
  // The shipped deliverable carries NO copper (policy since 1.13): this probe
  // asserts the placed board is copper-free AND that the DFM floors stay quiet
  // on pads alone. The copper floors themselves are judged by the synthetic
  // fixtures above — imported client boards still get the full DRC.
  const proj = path.join(TMP, 'blink');
  const design = path.join(ROOT, 'examples', 'designs', 'blink.json');
  const rb = spawnCaptured(process.execPath, [path.join(ROOT, 'scripts/build.js'), '--design', design, '--dir', proj], { cwd: ROOT, encoding: 'utf8' });
  const buildOut = `${rb.stdout || ''}${rb.stderr || ''}`;
  ok(rb.status === 0, 'blink builds for the DFM regression probe', buildOut.slice(-500));
  const blinkPcb = path.join(proj, 'pcb', 'PCB1.epcb2');
  if (fs.existsSync(blinkPcb)) {
    const geo = pcbGeometry(blinkPcb);
    ok(geo.tracks.length === 0 && geo.vias.length === 0 && geo.pours.length === 0,
      'the shipped board carries zero copper — by policy, not by luck',
      `${geo.tracks.length} tracks / ${geo.vias.length} vias / ${geo.pours.length} pours`);
    ok(geo.pads.length > 0, 'footprints and pads are placed (the deliverable is placement)', String(geo.pads.length));
    ok(geo.pads.every((p) => !p.hole || p.hole >= DEFAULTS.minDrill), 'no shipped pad drill breaks the floor');
    const rr = runDrc(blinkPcb, {});
    ok(rr.mode === 'placed-only', 'drc auto-detects the placed-only mode', rr.mode);
    ok(rr.findings.length === 0, 'blink gains no DFM findings', JSON.stringify(rr.findings));
    ok(rr.score === 100, 'blink still scores 100', rr.score);
  } else {
    ok(false, 'blink PCB document exists', blinkPcb);
  }

  // the --rules table printed by the CLI includes the new codes
  const rulesOut = spawnCaptured(process.execPath, [path.join(ROOT, 'scripts/drc.js'), '--dir', proj, '--rules'], { cwd: ROOT, encoding: 'utf8' });
  const table = `${rulesOut.stdout || ''}`;
  for (const code of ['D009', 'D010', 'D011', 'D012']) {
    ok(table.includes(code), `--rules prints ${code}`, table.trim().split('\n').slice(-6).join(' / '));
  }

  // ---------------------------------------------- land-pattern contract
  // The auto families and the preset footprints must keep the dimensions
  // recorded in docs/footprint-evidence.md — calibrated against the EasyEDA
  // 官方库 (fetched via easyeda.com/api/products/{LCSC}/components) and
  // JEDEC/IPC-7351B where no official sample is fetched yet. A silent drift
  // here went unnoticed for releases (D001 ignores intra-footprint spacing).
  // If one of these asserts fails, fix the FOOTPRINT (or the evidence doc) —
  // never the test.
  const FA = require(path.join(ROOT, 'scripts/lib/fp-auto.js'));
  const P = require(path.join(ROOT, 'scripts/lib/parts.js'));

  const famPads = (spec) => FA.expandAuto(spec).pads;
  // SOT-23 — official MMBT5551 (C2145): pads 1.0×0.65 mm at ±1.0 mm, pin
  // pitch 1.9 mm between pads 1/2
  {
    const s = famPads({ auto: 'SOT23' });
    ok(Math.abs(s[0][1] + 39.4) < 0.01 && Math.abs(s[0][2] - 37.4) < 0.01 && Math.abs(s[0][3] - 39.4) < 0.01,
      'auto SOT23 pads 39.4×25.6 at ±39.4, pitch 74.8 (P1.90)', JSON.stringify(s[0]));
  }
  // TSOT-23-5 — official ME6211 (C82942): pads 45.6×19.3 at ±45.4, in-column
  // pitch 37.4; right column aligns with rows 3 and 1
  {
    const p5 = famPads({ auto: 'SOT23-5' });
    ok(Math.abs(p5[0][1] + 45.4) < 0.01 && Math.abs(p5[0][3] - 45.6) < 0.01,
      'auto SOT23-5 pads 45.6×19.3 at ±45.4', JSON.stringify(p5[0]));
    ok(String(p5[3][2]) === '-37.4' && String(p5[4][2]) === '37.4',
      'SOT23-5 right column aligns with rows 3 and 1', JSON.stringify(p5.slice(3)));
  }
  // SOT-223 — official AMS1117 (C6186): row at y=-116.9, pitch 90.5, pads
  // 43.3×98.4; tab 141.7×92.1 at +116.9
  {
    const s223 = famPads({ auto: 'SOT223' });
    ok(Math.abs(s223[0][2] + 116.9) < 0.5 && Math.abs(s223[0][3] - 43.3) < 0.5 && Math.abs(s223[3][3] - 141.7) < 0.5,
      'auto SOT223 row y=-116.9 pads 43.3×98.4, tab 141.7×92.1', JSON.stringify(s223[0]));
  }
  // SOIC-8 — official LM358DR (C7950): pads 76.8 radial × 22.4 at ±106.5
  {
    const s8 = famPads({ auto: 'SOP8' });
    ok(Math.abs(s8[0][1] + 106.5) < 0.01 && Math.abs(s8[0][3] - 76.8) < 0.01 && Math.abs(s8[0][4] - 22.4) < 0.01,
      'auto SOP8 pads 76.8×22.4 at ±106.5 (radial long axis)', JSON.stringify(s8[0]));
  }
  // QFN — official MPU-6050 (C24112, QFN-24 4×4): pads 31.5×11 at ±78.7
  {
    const q24 = famPads({ auto: 'QFN24' });
    ok(Math.abs(q24[0][1] + 49.2) < 0.3 && Math.abs(q24[0][2] + 78.7) < 0.6 && Math.abs(q24[0][4] - 31.5) < 0.6,
      'auto QFN24 bottom row starts bottom-left at ±78.7 rows, pads 11×31.5', JSON.stringify(q24[0]));
  }
  // LQFP-48 — official STM32F103C8T6 (C8734): pads ≈10.6×59.1 at ±167.3
  {
    const q48 = famPads({ auto: 'LQFP48' });
    ok(Math.abs(q48[0][2] + 167.3) < 0.6 && Math.abs(q48[0][4] - 59.1) < 0.6,
      'auto LQFP48 pads ≈10.6×59.1 at ±167.3', JSON.stringify(q48[0]));
  }
  // TSSOP — IPC-7351B derivation (0.65 mm pitch class), official sample pending
  {
    const t20 = famPads({ auto: 'TSSOP20' });
    ok(Math.abs(t20[0][1] + 112.7) < 0.01 && Math.abs(Math.abs(t20[1][2] - t20[0][2]) - 25.6) < 0.01,
      'auto TSSOP20 pads 58×16 at ±112.7, pitch 25.6 (IPC-derived)', JSON.stringify(t20.slice(0, 2)));
  }
  // DFN / LGA — IPC-7351B derivation for the sensor class (SHT30 / BMP280
  // 0.65 mm pitch); same "derived, official sample pending" status as TSSOP
  {
    const dfn = famPads({ auto: 'DFN8', pitch: 25.6 });
    ok(dfn.length === 8 && Math.abs(dfn[0][3] - 28) < 1 && Math.abs(dfn[0][4] - 13) < 1,
      'auto DFN8 pads ≈28×13 at 25.6 pitch (IPC-derived)', JSON.stringify(dfn.slice(0, 2)));
    const lga = famPads({ auto: 'LGA8', pitch: 25.6 });
    ok(lga.length === 8 && Math.abs(lga[0][3] - 20) < 1 && Math.abs(lga[0][4] - 20) < 1,
      'auto LGA8 square pads ≈20×20 at 25.6 pitch (IPC-derived)', JSON.stringify(lga.slice(0, 2)));
  }
  // USB-C — official TYPE-C-31-M-12 (C165948): 6 merged power/CC pads
  {
    const usbc = famPads({ auto: 'USB_C' });
    ok(usbc.length === 6 && String(usbc[0][0]) === 'A1B12' && Math.abs(usbc[0][1] + 126) < 0.1,
      'auto USB_C = 6 official merged power/CC pads (A1B12…)', JSON.stringify(usbc[0]));
  }
  // 0402 presets: IPC-7351N-scale pads (0.58×0.63 mm at ±0.48 mm)
  for (const name of ['R0402', 'C0402', 'L0402']) {
    const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/library/footprint', `${name}.json`), 'utf8'));
    const fp = P.parseFootprintEntry(entry);
    ok(fp.pads.length === 2
      && Math.abs(Math.abs(fp.pads[0].x) - 19) < 0.01
      && Math.abs(fp.pads[0].w - 23) < 0.01
      && Math.abs(fp.pads[0].h - 25) < 0.01,
      `${name} preset pads 23×25 mil at ±19 mil`,
      JSON.stringify(fp.pads.map((p) => [p.x, p.w, p.h])));
  }

  // The shipped 2-pin polarized SYMBOLS share one convention: pin 1 = anode,
  // designator D — a trap the corpus cannot see (DIODE used to be 1=K + U?).
  for (const name of ['DIODE', 'LED']) {
    const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/library/symbol', `${name}.json`), 'utf8'));
    const sym = P.parseSymbolEntry(entry);
    ok(sym.designator === 'D?', `${name} preset designator is D?`, sym.designator);
    const p1 = sym.pinByNum.get('1');
    const p2 = sym.pinByNum.get('2');
    ok(p1 && p1.name === 'A' && p2 && p2.name === 'K', `${name} preset pins are 1=A / 2=K`,
      `${p1 && p1.name}/${p2 && p2.name}`);
    ok(sym.graphics && sym.graphics.length > 0, `${name} preset carries diode artwork`);
  }

  // The inline footprints in the recipes match the official-library numbers.
  const ldo = JSON.parse(fs.readFileSync(path.join(ROOT, 'recipe', 'ldo-3v3.json'), 'utf8'));
  const ldoPad = ldo.parts.find((p) => p.id === 'U1').footprint.pads[0];
  ok(Math.abs(ldoPad[1] + 45.4) < 0.01 && Math.abs(ldoPad[3] - 45.6) < 0.01,
    'ldo-3v3 SOT23_5 pads 45.6×19.3 at ±45.4 (official ME6211 geometry)', JSON.stringify(ldoPad));
  const mos = JSON.parse(fs.readFileSync(path.join(ROOT, 'recipe', 'mosfet-switch.json'), 'utf8'));
  const mosPad = mos.parts.find((p) => p.id === 'Q1').footprint.pads[0];
  ok(Math.abs(mosPad[1] + 39.4) < 0.01 && Math.abs(mosPad[3] - 39.4) < 0.01,
    'mosfet-switch SOT23_3 pads 39.4×25.6 at ±39.4 (official MMBT5551 geometry)', JSON.stringify(mosPad));
  const rs = JSON.parse(fs.readFileSync(path.join(ROOT, 'recipe', 'rs485.json'), 'utf8'));
  const rsPad = rs.parts.find((p) => p.id === 'U1').footprint.pads[0];
  ok(Math.abs(rsPad[1] + 106.5) < 0.01 && Math.abs(rsPad[3] - 76.8) < 0.01,
    'rs485 SOIC_8P pads 76.8×22.4 at ±106.5 (official LM358 geometry)', JSON.stringify(rsPad));

  // IC pinout entries live in the local cache (fetch-lcsc), NOT in the shipped
  // templates — the library policy keeps model-specific parts out of the repo.
  // When the cache is empty (clean CI checkout) these are skipped, not failed.
  {
    const I = require(path.join(ROOT, 'scripts/lib/icdirs.js'));
    const cached = new Map(I.icFiles(null).map((f) => [path.basename(f, '.json'), f]));
    if (!cached.size) {
      console.log('  note: no cached IC entries — fetch with scripts/fetch-lcsc.js --install (skipping IC assertions)');
    }
    if (cached.has('STM32F103C8T6')) {
      const stm = JSON.parse(fs.readFileSync(cached.get('STM32F103C8T6'), 'utf8'));
      const pins = stm.rawSymbol ? stm.rawSymbol.pins : (stm.symbol && stm.symbol.pins) || [];
      ok(pins.length === 48, 'STM32F103C8T6 cached entry carries 48 official pins', pins.length);
      ok(stm.footprint && Array.isArray(stm.footprint.pads) && stm.footprint.pads.length === 48,
        'STM32F103C8T6 ships 48 verbatim official pads', stm.footprint && stm.footprint.pads && stm.footprint.pads.length);
      ok(stm.evidence && /easyeda\.com\/api\/products\/C8734/.test(stm.evidence.symbol) && !!stm.evidence.datasheet,
        'STM32 IC entry cites the EasyEDA official-library API + datasheet', JSON.stringify(stm.evidence));
    }
    if (cached.has('AMS1117-3.3')) {
      const ams = JSON.parse(fs.readFileSync(cached.get('AMS1117-3.3'), 'utf8'));
      const pins = ams.rawSymbol ? ams.rawSymbol.pins : (ams.symbol && ams.symbol.pins) || [];
      ok(pins.length === 4 && /easyeda\.com\/api\/products\/C6186/.test(ams.evidence.symbol),
        'AMS1117-3.3 cached entry: 4 official pins with EasyEDA evidence', pins.length);
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`dfm: ${checks - failures}/${checks} assertions passed`);
  if (failures) process.exit(1);
}

main();
