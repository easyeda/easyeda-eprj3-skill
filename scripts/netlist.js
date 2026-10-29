#!/usr/bin/env node
'use strict';
/**
 * netlist.js — print the electrical netlist recovered from a project.
 *
 * This is the "what did I actually build" view: it resolves wires, labels and
 * power flags to real pin-to-pin connectivity, independent of the design file.
 * Diff it against the design with `scripts/erc.js --design design.json`.
 *
 *   node scripts/netlist.js --dir <project> [--json] [--sheet P1] [--pcb]
 *   node scripts/netlist.js --dir <project> --design design.json --audit <out.json>
 *       write a self-contained netlist audit package (spec + built + mechanical
 *       diff + rubric) for an INDEPENDENT reviewer — see lib/audit.js and the
 *       "Netlist audit" step in SKILL.md. `--gen board.gen.js` works the same
 *       way for designs authored as a generator (no design.json to read).
 *
 * Exit code 0 always (it reports, it does not judge).
 */
const fs = require('fs');
const path = require('path');
const N = require('./lib/netlist');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'json', desc: 'print JSON instead of a table', hasValue: false },
  { name: 'sheet', desc: 'only this sheet title' },
  { name: 'pcb', desc: 'print the PCB netlist (PAD_NET view) instead', hasValue: false },
  { name: 'unconnected', desc: 'only list unconnected pins', hasValue: false },
  { name: 'design', desc: 'design.json — adds the spec view / spec↔built diff' },
  { name: 'gen', desc: 'generator module (A) => design — same, for --gen designs' },
  { name: 'audit', desc: 'write the audit package to this JSON file (what the sub-agent reads)' }
];

function loadDesign(opts) {
  if (!opts.design && !opts.gen) return null;
  try {
    return require('./lib/design').readSource(opts.gen || opts.design, !!opts.gen);
  } catch (e) {
    console.error(`netlist.js: cannot load the design: ${e.message}`);
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('netlist.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const design = loadDesign(opts);
  const all = N.projectNetlist(opts.dir);

  if (opts.audit) {
    const A = require('./lib/audit');
    const pkg = A.buildPackage(opts.dir, design);
    const out = path.resolve(opts.audit);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    const m = pkg.mechanical;
    const specPart = m.specAvailable
      ? `spec ${pkg.spec.parts.length} parts / ${m.diff.ok ? 'matches built' : `${m.diff.nets.length} net(s) differ`}`
      : 'no design source, spec checks skipped';
    console.log(`netlist-audit: wrote ${out} — ${specPart} · netcheck ${m.netcheck.match ? 'OK' : `${m.netcheck.issues.length} issue(s)`} · mechanical ${m.ok ? 'OK' : 'FAIL'} — hand this file to a fresh reviewer`);
    return;
  }

  if (opts.pcb) {
    const out = all.pcb.map((p) => ({ pcb: p.pcb, nets: p.netlist.nets, pads: p.netlist.pads.length }));
    if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
    for (const p of all.pcb) {
      console.log(`# ${p.pcb}: ${p.netlist.pads.length} pads, ${p.netlist.nets.length} nets`);
      for (const n of p.netlist.nets) {
        console.log(`  ${n.name.padEnd(20)} ${n.pins.map((x) => `${x.ref}.${x.num}`).join(' ')}`);
      }
    }
    return;
  }

  const sheets = all.perSheet.filter((s) => !opts.sheet || s.sheet === opts.sheet);
  if (opts.json) {
    console.log(JSON.stringify(sheets.map((s) => ({
      schematic: s.schematic,
      sheet: s.sheet,
      nets: s.netlist.nets,
      unconnected: s.netlist.unconnected
    })), null, 2));
    return;
  }
  if (opts.unconnected) {
    for (const s of sheets) {
      for (const u of s.netlist.unconnected) console.log(`${s.sheet} ${u.ref}.${u.num} (${u.name}) at ${u.x},${u.y}`);
    }
    return;
  }
  for (const s of sheets) {
    const nl = s.netlist;
    console.log(`# ${s.schematic}/${s.sheet}: ${nl.components.length} components, ${nl.nets.length} nets, ${nl.pinCount} pins`);
    for (const n of nl.nets) {
      const tag = n.auto ? ' (auto)' : '';
      console.log(`  ${n.name.padEnd(20)} ${n.pins.map((x) => `${x.ref}.${x.num}`).join(' ')}${tag}`);
    }
    if (nl.unconnected.length) {
      console.log(`  unconnected: ${nl.unconnected.map((u) => `${u.ref}.${u.num}`).join(' ')}`);
    }
  }

  if (design) {
    // table-mode spec view: which nets the design asked for are not what got built
    const A = require('./lib/audit');
    const pkg = A.buildPackage(opts.dir, design);
    const d = pkg.mechanical.diff;
    console.log(`# spec vs built: ${d.ok ? 'match' : `${d.nets.length} net(s) differ`}`);
    for (const n of d.nets) {
      console.log(`  ${n.name.padEnd(20)} missing ${n.missing.join(' ') || '-'} · extra ${n.extra.join(' ') || '-'}`);
    }
  }
}

main();
