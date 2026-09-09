#!/usr/bin/env node
'use strict';
/**
 * smoke.js — End-to-end regression test for the eprj3 skill scripts.
 *
 * Runs the real scripts against a throwaway project in the OS temp dir and
 * asserts the invariants that have historically regressed:
 *   - add-wire emits exactly one LINE per segment (no duplicates)
 *   - COMPONENT body.id == head.id == ATTR.parentId (schematic and PCB)
 *   - DeviceName uuid resolves to the embedded __symbols__/__footprints__ doc
 *   - record round-trip survives '||' inside JSON string bodies
 *   - get-or-die paths fail instead of silently creating documents
 *   - validate --fix removes duplicate/orphan records
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const { readRecords, appendRecord, parseRecord, formatRecord } = require(path.join(SCRIPTS, 'lib', 'eprj3'));

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

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eprj3-smoke-'));
  const proj = path.join(tmp, 'demo');
  const j = (...p) => path.join(proj, ...p);
  const rel = f => path.relative(ROOT, f).split(path.sep).join('/');

  try {
    // ---- bootstrap ----
    run([SCRIPTS + '/init.js', 'init', '--dir', proj, '--name', 'demo', '--with-schematic', 'S1', '--with-pcb']);
    assert(fs.existsSync(j('demo.eprj3')), 'init creates project index');
    assert(fs.existsSync(j('sch', 'S1', 'P1.esch2')), 'init creates sheet with DOCHEAD preamble');
    const r2 = run([SCRIPTS + '/init.js', 'init', '--dir', proj, '--name', 'demo', '--with-pcb'], null);
    assert(r2.status !== 0, 'init refuses to overwrite an existing project', `exit ${r2.status}`);

    // ---- library generation ----
    run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj, '--name', 'RES', '--pins', '1,A,2,B']);
    run([SCRIPTS + '/generate-footprint.js', 'from-pads', '--dir', proj, '--name', '0603',
      '--pads', '1,-31.5,0,rect,24,16,40;2,31.5,0,rect,24,16', '--silk', 'rect,-32,-8,32,8']);
    const fpRecs = readRecords(j('sch', '__footprints__', '0603.esch2'));
    const pad = fpRecs.find(r => r.type === 'PAD' && r.body.num === '1');
    assert(pad && pad.body.hole && pad.body.hole.diameter === 40, 'generate-footprint supports through-hole pads');
    assert(fpRecs.find(r => r.type === 'PAD' && r.body.num === '2' && r.body.hole === null), 'generate-footprint keeps SMD pads hole-less');

    // ---- placement ----
    run([SCRIPTS + '/add-symbol.js', 'add', '--dir', proj, '--schematic', 'S1', '--sheet', 'P1',
      '--symbol', 'RES', '--refdes', 'R1', '--value', '10k', '--x', '200', '--y', '100', '--footprint', '0603']);
    const sch = readRecords(j('sch', 'S1', 'P1.esch2'));
    const comp = sch.find(r => r.type === 'COMPONENT');
    const desig = sch.find(r => r.type === 'ATTR' && r.body.key === 'Designator');
    assert(comp && comp.body.y === 100, 'add-symbol --y is not shadowed by an option alias', `y=${comp && comp.body.y}`);
    assert(comp && comp.body.id && comp.head.id === comp.body.id, 'COMPONENT head id == body id');
    assert(desig && desig.body.parentId === comp.body.id, 'Designator ATTR.parentId == COMPONENT id');
    const symUuid = readRecords(j('sch', '__symbols__', 'RES.esch2')).find(r => r.type === 'DOCHEAD').body.uuid;
    assert(JSON.parse(comp.body.attrs.DeviceName).uuid === symUuid, 'DeviceName uuid resolves to the embedded symbol doc');
    assert(JSON.parse(comp.body.attrs.FootprintName).name === '0603', 'FootprintName references the footprint name');

    // ---- wires: exactly one LINE per segment ----
    run([SCRIPTS + '/add-wire.js', 'add', '--dir', proj, '--schematic', 'S1', '--sheet', 'P1', '--points', '210,100;290,100']);
    const sch2 = readRecords(j('sch', 'S1', 'P1.esch2'));
    const wires = sch2.filter(r => r.type === 'WIRE');
    assert(wires.length === 1 && sch2.filter(r => r.type === 'LINE').length === 1,
      'add-wire emits exactly one LINE per segment', `wires=${wires.length} lines=${sch2.filter(r => r.type === 'LINE').length}`);
    const rBad = run([SCRIPTS + '/add-wire.js', 'add', '--dir', proj, '--schematic', 'S1', '--sheet', 'P1', '--points', '1,foo;2,3'], null);
    assert(rBad.status !== 0, 'add-wire rejects non-numeric points', `exit ${rBad.status}`);

    // ---- text round-trip with '||' in the body ----
    run([SCRIPTS + '/add-text.js', 'add', '--dir', proj, '--doc', 'S1', '--sheet', 'P1', '--text', 'A||B', '--x', '1', '--y', '2']);
    const txt = readRecords(j('sch', 'S1', 'P1.esch2')).find(r => r.type === 'TEXT');
    assert(txt && txt.body.value === 'A||B', "TEXT value containing '||' survives a read/write round-trip",
      `value=${txt && JSON.stringify(txt.body.value)}`);
    const roundTrip = parseRecord(formatRecord({ type: 'TEXT', ticket: 1, id: 'x' }, { value: 'A||B' }));
    assert(roundTrip && roundTrip.body.value === 'A||B', "parseRecord handles '||' inside JSON string bodies");
    const threeSeg = parseRecord('{"type":"T","ticket":5}||{"ticket":5,"id":"a"}||{"value":"A||B"}|');
    assert(threeSeg && threeSeg.ticket === 5 && threeSeg.id === 'a' && threeSeg.body.value === 'A||B',
      'parseRecord handles 3-segment records whose body contains "||"');

    // ---- PCB: footprint id linkage ----
    run([SCRIPTS + '/add-footprint.js', 'add', '--dir', proj, '--pcb', 'PCB1', '--footprint', '0603', '--refdes', 'R1', '--x', '200', '--y', '100']);
    const pcb = readRecords(j('pcb', 'PCB1.epcb2'));
    const pcomp = pcb.find(r => r.type === 'COMPONENT');
    const pattr = pcb.find(r => r.type === 'ATTR');
    assert(pcomp && pcomp.body.id && pcomp.head.id === pcomp.body.id, 'PCB COMPONENT head id == body id');
    assert(pattr && pattr.body.parentId === pcomp.body.id, 'PCB Designator ATTR.parentId == COMPONENT id');
    const fpUuid = fpRecs.find(r => r.type === 'DOCHEAD').body.uuid;
    assert(JSON.parse(pcomp.body.attrs.DeviceName).uuid === fpUuid, 'PCB DeviceName uuid resolves to the embedded footprint doc');

    // ---- netlabel / port / refdes ----
    run([SCRIPTS + '/add-netlabel.js', 'add', '--dir', proj, '--schematic', 'S1', '--sheet', 'P1', '--name', 'VCC', '--x', '150', '--y', '100']);
    run([SCRIPTS + '/add-port.js', 'add', '--dir', proj, '--schematic', 'S1', '--sheet', 'P1', '--name', 'OUT', '--type', 'OUTPUT', '--x', '300', '--y', '100']);
    run([SCRIPTS + '/set-refdes.js', 'set', '--dir', proj, '--doc', 'S1', '--sheet', 'P1', '--from', 'R1', '--to', 'R100']);
    assert(readRecords(j('sch', 'S1', 'P1.esch2')).some(r => r.type === 'ATTR' && r.body.value === 'R100'), 'set-refdes renames the designator');
    run([SCRIPTS + '/set-refdes.js', 'renumber', '--dir', proj, '--doc', 'S1', '--sheet', 'P1', '--prefix', 'R']);
    assert(readRecords(j('sch', 'S1', 'P1.esch2')).some(r => r.type === 'ATTR' && r.body.value === 'R1'), 'set-refdes renumber normalizes to prefix+index');
    const rGhost = run([SCRIPTS + '/set-refdes.js', 'set', '--dir', proj, '--doc', 'NoSuch', '--sheet', 'P1', '--from', 'A', '--to', 'B'], null);
    assert(rGhost.status !== 0, 'set-refdes fails on unknown schematic instead of creating one', `exit ${rGhost.status}`);

    // ---- validate (clean) ----
    const rVal = run([SCRIPTS + '/validate.js', 'check', '--dir', proj, '--strict']);
    assert(/0 errors, 0 warnings/.test(rVal.stdout), 'validate reports 0 errors, 0 warnings on the finished project', rVal.stdout.trim());

    // ---- validate --fix removes duplicated LINE + orphan WIRE ----
    appendRecord(j('sch', 'S1', 'P1.esch2'), 'LINE', {
      fillColor: null, fillStyle: null, strokeColor: '#000000', strokeStyle: 'SOLID', strokeWidth: 1,
      startX: 210, startY: 100, endX: 290, endY: 100, lineGroup: wires[0].id
    });
    appendRecord(j('sch', 'S1', 'P1.esch2'), 'WIRE', { zIndex: 1 }, undefined, 'orphan1');
    run([SCRIPTS + '/validate.js', 'check', '--dir', proj, '--fix']);
    const fixed = readRecords(j('sch', 'S1', 'P1.esch2'));
    assert(fixed.filter(r => r.type === 'LINE').length === 1, 'validate --fix removes duplicate LINE');
    assert(fixed.filter(r => r.type === 'WIRE').length === 1, 'validate --fix removes orphan WIRE');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main();
