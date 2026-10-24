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
 * and whether a ground pour exists. Exit 1 on an error finding.
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
  { name: 'clearance', desc: 'minimum copper-to-copper spacing (mil)' },
  { name: 'min-track', desc: 'minimum track width (mil)' },
  { name: 'edge', desc: 'minimum copper-to-board-edge spacing (mil)' },
  { name: 'pour-net', desc: 'net expected to be poured (default GND)' },
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

  const r = runDrc(file, { rules, pourNet: opts['pour-net'] || 'GND' });
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const f of r.findings) {
      const out = f.level === 'error' ? console.error : console.log;
      out(`${f.level === 'error' ? 'error' : 'warn'} ${f.code}: ${f.msg}`);
    }
    console.log(`drc ${r.counts.pads} pads, ${r.counts.tracks} tracks, ${r.counts.vias} vias, ${r.counts.pours} pours`);
    console.log(`drc score ${r.score}/100 (${r.errors} error(s), ${r.warnings} warning(s))`);
  }
  const min = opts['min-score'] !== undefined ? Number(opts['min-score']) : null;
  if (r.errors || (opts.strict && r.warnings) || (min !== null && r.score < min)) process.exit(1);
}

main();
