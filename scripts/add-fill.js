#!/usr/bin/env node
'use strict';
/**
 * add-fill.js — add a static copper fill (FILL record) to a PCB document.
 *
 *   add-fill rect --dir <project> --pcb PCB1 [--net GND] --layer 1
 *                --x 100 --y 100 --w 400 --h 300
 *   add-fill poly --dir <project> --pcb PCB1 [--net GND] --layer 1
 *                --pts "100,100,500,100,500,400,100,400"
 *
 * Coordinates are mil; the outline uses the example's ["R",...] / [x0,y0,"L",...]
 * path encodings. --style only accepts SOLID — it is the only fill mode backed
 * by a real client record (grid/inner-plane modes have no verifiable sample).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'net', desc: 'net name (optional, default none)' },
  { name: 'layer', desc: 'layer id (default 1 = top)' },
  { name: 'x', desc: 'rect top-left x (mil)' },
  { name: 'y', desc: 'rect top-left y (mil)' },
  { name: 'w', desc: 'rect width (mil)' },
  { name: 'h', desc: 'rect height (mil)' },
  { name: 'pts', desc: 'poly outline: comma-separated x,y pairs' },
  { name: 'style', desc: 'SOLID only (default; other modes have no verifiable sample)' },
  { name: 'width', desc: 'stroke width (default 0.2, as in example)' }
];

function numList(s, what) {
  const nums = String(s).split(',').map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isFinite(n)) || nums.length % 2 !== 0 || !nums.length) {
    die(`--${what} must be comma-separated x,y pairs like "x1,y1,x2,y2"`);
  }
  return nums;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('add-fill.js <rect|poly> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  if (opts.style !== undefined && opts.style !== 'SOLID') {
    die(`FILL style "${opts.style}" is not sample-backed — only SOLID can be emitted (see docs/format-reference.md)`);
  }
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  let path;
  if (cmd === 'rect') {
    if ([opts.x, opts.y, opts.w, opts.h].some((v) => v === undefined)) die('rect needs --x --y --w --h');
    path = [['R', Number(opts.x), Number(opts.y), Number(opts.w), Number(opts.h), 0, 0]];
  } else if (cmd === 'poly') {
    if (!opts.pts) die('poly needs --pts "x1,y1,x2,y2,..."');
    const nums = numList(opts.pts, 'pts');
    if (nums.length < 6) die('poly needs at least 3 points');
    path = [[nums[0], nums[1], 'L', ...nums.slice(2)]];
  } else {
    die(`unknown shape "${cmd}" (want: rect | poly)`);
  }

  if (opts.net !== undefined) E.ensurePcbNets(file, [opts.net]);
  const lines = E.readLines(file);
  E.appendLines(file, [E.pcbFillLine({
    netName: opts.net,
    layerId: opts.layer !== undefined ? Number(opts.layer) : 1,
    path,
    width: opts.width !== undefined ? Number(opts.width) : undefined,
    style: 'SOLID',
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`added ${cmd} fill on ${opts.pcb}${opts.net ? ` (net ${opts.net})` : ''}`);
}

main();
