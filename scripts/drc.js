#!/usr/bin/env node
'use strict';
/**
 * drc.js — PCB design rule check.
 *
 *   node scripts/drc.js --dir <project> [--pcb PCB1] [--json] [--strict]
 *                       [--clearance 10] [--min-track 8] [--edge 12]
 *                       [--pour-net GND] [--min-score 90]
 *
 * Judges the copper that is actually in the file: spacing between different
 * nets, track width, board-edge clearance, whether every net is fully routed,
 * and whether a ground pour exists — plus the DFM gate (D009 min drill,
 * D010 min annular ring, D011 silk-on-pad, D012 acute track angle;
 * `--rules` prints the whole table). Exit 1 on an error finding.
 */
const fs = require('fs');
const path = require('path');
const E = require('./lib/eprj3');
const { runDrc, RULES } = require('./lib/drc');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB document title (default: first in the project)' },
  { name: 'json', desc: 'machine-readable output', hasValue: false },
  { name: 'strict', desc: 'treat warnings as errors', hasValue: false },
  { name: 'placed-only', desc: 'force placement-deliverable mode (skip D004 unrouted + D006 missing pour)', hasValue: false },
  { name: 'routed', desc: 'force routed mode (judge D004/D006 even when the file has no tracks)', hasValue: false },
  { name: 'clearance', desc: 'minimum copper-to-copper spacing (mil)' },
  { name: 'min-track', desc: 'minimum track width (mil)' },
  { name: 'edge', desc: 'minimum copper-to-board-edge spacing (mil)' },
  { name: 'pour-net', desc: 'net expected to be poured (default GND)' },
  { name: 'design', desc: 'judge the copper against this design.json contract (pcb.rules/pour/net widths) — same as build.js does' },
  { name: 'min-score', desc: 'fail when the DRC score is below this (0-100)' },
  { name: 'rules', desc: 'print the rule table and exit', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('drc.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  if (opts.rules) {
    for (const [code, r] of Object.entries(RULES)) {
      console.log(`${code}  ${r.level.padEnd(5)} -${String(r.weight).padStart(2)}  ${r.text}`);
    }
    return;
  }
  const project = E.Project.load(path.resolve(opts.dir));
  const pcbs = Object.values(project.profile.pcbs);
  if (!pcbs.length) die(`no PCB in ${opts.dir}`);
  const pcb = opts.pcb ? project.requirePcb(opts.pcb) : pcbs[0];
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file}`);

  const rules = {};
  if (opts.clearance !== undefined) rules.clearance = Number(opts.clearance);
  if (opts['min-track'] !== undefined) rules.minTrack = Number(opts['min-track']);
  if (opts.edge !== undefined) rules.edge = Number(opts.edge);

  // `--design <design.json>` judges the copper against the contract the board
  // was built under (pcb.rules, pour net, per-net widths) — exactly what
  // build.js does. Without it the DRC defaults apply, which misjudge boards
  // that legitimately declared fine-pitch rules.
  let pourNet = opts['pour-net'] || 'GND';
  let netWidths = {};
  if (opts.design) {
    const D = require('./lib/design');
    const design = D.readDesign(path.resolve(opts.design));
    const dr = design.pcbSpec.rules || {};
    if (dr.clearance !== undefined) rules.clearance = dr.clearance;
    if (dr.trackWidth !== undefined) rules.minTrack = dr.trackWidth;
    if (dr.edgeClearance !== undefined) rules.edge = dr.edgeClearance;
    if (dr.minDrill !== undefined) rules.minDrill = dr.minDrill;
    if (dr.minRing !== undefined) rules.minRing = dr.minRing;
    if (dr.minAngle !== undefined) rules.minAngle = dr.minAngle;
    if (!opts['pour-net'] && design.pcbSpec.pour && design.pcbSpec.pour.net) pourNet = design.pcbSpec.pour.net;
    netWidths = design.netWidths || {};
  }

  // The strategy ships placement-only boards; D004/D006 (routing + pour
  // promises) then do not apply. Auto-detect reads it off the copper (no
  // tracks → nothing was routed); --placed-only / --routed force the mode.
  let placedOnly;
  if (opts['placed-only']) placedOnly = true;
  else if (opts.routed) placedOnly = false;

  const r = runDrc(file, { rules, pourNet, netWidths, placedOnly });
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const f of r.findings) {
      const out = f.level === 'error' ? console.error : console.log;
      out(`${f.level === 'error' ? 'error' : 'warn'} ${f.code}: ${f.msg}${f.fix ? `\n  fix: ${f.fix}` : ''}`);
    }
    console.log(`drc ${r.counts.pads} pads, ${r.counts.tracks} tracks, ${r.counts.vias} vias, ${r.counts.pours} pours`
      + (r.mode === 'placed-only' ? ' · placed-only mode (D004/D006 skipped)' : ''));
    console.log(`drc score ${r.score}/100 (${r.errors} error(s), ${r.warnings} warning(s))`);
  }
  const min = opts['min-score'] !== undefined ? Number(opts['min-score']) : null;
  if (r.errors || (opts.strict && r.warnings) || (min !== null && r.score < min)) process.exit(1);
}

main();
