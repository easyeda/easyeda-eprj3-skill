#!/usr/bin/env node
'use strict';
/**
 * report.js — write project-report.md for a built project.
 *
 *   node scripts/report.js --dir <project> [--design design.json | --gen gen.js]
 *                         [--report build.json] [--out <file>]
 *
 * Reads the design and the built project, then writes a human-readable report:
 * overview, functional blocks, signal-flow + power diagram (mermaid), net
 * overview, gate results, known limitations and auto suggestions. `--report
 * build.json` (from `build.js --report`) fills in the gate results; without it
 * those lines are marked unknown. Exit 0 always (it reports, it does not judge).
 */
const fs = require('fs');
const path = require('path');
const { parseArgs, printHelp } = require('./lib/utils');
const N = require('./lib/netlist');
const { compare } = require('./lib/netcheck');
const { buildProjectReport } = require('./lib/report');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'design', desc: 'design.json (or use --gen)' },
  { name: 'gen', desc: 'generator module (A) => design' },
  { name: 'report', desc: 'build.json written by build.js --report (for gate results)' },
  { name: 'out', desc: 'output markdown file (default: <dir>/project-report.md)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('report.js [options]', SCHEMA, 'Write project-report.md for a built project.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);

  let design = null;
  if (opts.design || opts.gen) {
    try {
      design = require('./lib/design').readSource(opts.gen || opts.design, !!opts.gen);
    } catch (e) {
      console.error(`report.js: cannot load design: ${e.message}`);
      process.exit(1);
    }
  }
  let build = null;
  if (opts.report) {
    try {
      build = JSON.parse(fs.readFileSync(opts.report, 'utf8'));
    } catch (e) {
      console.error(`report.js: cannot read --report: ${e.message}`);
    }
  }

  const all = N.projectNetlist(opts.dir);
  const clientPcb = !!(build && build.pcb && /^client-(update|import)$/.test(build.pcb.source || ''));
  const netcheck = clientPcb ? null : compare(all);
  const designStub = {
    name: path.basename(path.resolve(opts.dir)),
    powerNets: new Map(),
    blocks: [],
    parts: [],
    sheets: 1,
    boardDeclared: false,
    board: { width: 0, height: 0 },
    file: null
  };
  const md = buildProjectReport(design || designStub, all, netcheck, build);

  const out = path.resolve(opts.out || path.join(opts.dir, 'project-report.md'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${md}\n`, 'utf8');
  const sheetNets = all.perSheet.reduce((n, s) => n + s.netlist.nets.length, 0);
  console.log(`report: wrote ${out} (${design ? design.parts.length : '?'} parts, ${sheetNets} nets)`);
}

main();
