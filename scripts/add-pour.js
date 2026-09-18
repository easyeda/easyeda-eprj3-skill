#!/usr/bin/env node
'use strict';
/**
 * add-pour.js — add a copper pour region (POUR record) to a PCB document.
 *
 *   add-pour rect --dir <project> --pcb PCB1 --net GND --layer 1
 *                --x 100 --y 100 --w 3800 --h 2800
 *   add-pour poly --dir <project> --pcb PCB1 --net GND --layer 1
 *                --pts "100,100,3900,100,3900,2900,100,2900"
 *
 * Coordinates are mil and form the pour outline (rect takes the bottom-left
 * corner + size; the client's anchored rect form is emitted for you). --style
 * only accepts SOLID — it is the only fill mode backed by a real client
 * record; without --name the next free POURn is picked. The record is the pour
 * region only — the client recomputes the filled copper (POURED records) on
 * open.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'net', desc: 'net name', required: true },
  { name: 'layer', desc: 'layer id (default 1 = top)' },
  { name: 'x', desc: 'rect bottom-left x (mil)' },
  { name: 'y', desc: 'rect bottom-left y (mil)' },
  { name: 'w', desc: 'rect width (mil)' },
  { name: 'h', desc: 'rect height (mil)' },
  { name: 'pts', desc: 'poly outline: comma-separated x,y pairs' },
  { name: 'style', desc: 'SOLID only (default; other modes have no verifiable sample)' },
  { name: 'width', desc: 'clearance/stroke width (default 0.2, as in example)' },
  { name: 'name', desc: 'pour name (default: next free POURn in this PCB)' }
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
    printHelp('add-pour.js <rect|poly> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  if (opts.style !== undefined && opts.style !== 'SOLID') {
    die(`POUR style "${opts.style}" is not sample-backed — only SOLID can be emitted (see docs/format-reference.md)`);
  }
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  let path;
  if (cmd === 'rect') {
    if ([opts.x, opts.y, opts.w, opts.h].some((v) => v === undefined)) die('rect needs --x --y --w --h');
    path = [E.rectPath(Number(opts.x), Number(opts.y), Number(opts.w), Number(opts.h))];
  } else if (cmd === 'poly') {
    if (!opts.pts) die('poly needs --pts "x1,y1,x2,y2,..."');
    const nums = numList(opts.pts, 'pts');
    if (nums.length < 6) die('poly needs at least 3 points');
    path = [[nums[0], nums[1], 'L', ...nums.slice(2)]];
  } else {
    die(`unknown shape "${cmd}" (want: rect | poly)`);
  }

  E.ensurePcbNets(file, [opts.net]);
  const lines = E.readLines(file);
  let name = opts.name;
  if (name === undefined) {
    const used = new Set();
    for (const l of lines) {
      const r = E.parseRecord(l);
      if (r && r.type === 'POUR' && r.body && r.body.name) used.add(String(r.body.name));
    }
    let n = 1;
    while (used.has(`POUR${n}`)) n++;
    name = `POUR${n}`;
  }
  E.appendLines(file, [E.pcbPourLine({
    netName: opts.net,
    layerId: opts.layer !== undefined ? Number(opts.layer) : 1,
    path,
    width: opts.width !== undefined ? Number(opts.width) : undefined,
    name,
    style: 'SOLID',
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`added ${cmd} pour ${name} (net ${opts.net}) on ${opts.pcb}`);
}

main();
