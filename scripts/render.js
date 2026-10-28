#!/usr/bin/env node
'use strict';
/**
 * render.js — write SVG previews of every schematic sheet and PCB document.
 *
 *   node scripts/render.js --dir <project> [--out <dir>] [--json]
 *
 * Default output: <project>/preview/<Schematic>_<sheet>.svg + <PCB>.svg
 *
 * The SVGs are sketches, not plotter exports. Schematic: real symbol artwork
 * (diode triangle, LED arrows, cap plates), pin stubs, wires, block frames —
 * layout, spacing, routing and block structure judged in one look. PCB: board
 * outline, pads, refdes and the rats — how a human sanity-checks a
 * placement-only deliverable without opening the client.
 */
const fs = require('fs');
const path = require('path');
const { renderProject } = require('./lib/render');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'out', desc: 'output directory (default: <project>/preview)' },
  { name: 'json', desc: 'print the written file list as JSON', hasValue: false }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('render.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const files = renderProject(opts.dir, opts.out ? path.resolve(opts.out) : null);
  if (opts.json) {
    console.log(JSON.stringify(files, null, 2));
    return;
  }
  for (const f of files) console.log(`wrote ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
}

main();
