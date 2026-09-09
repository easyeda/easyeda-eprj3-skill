#!/usr/bin/env node
'use strict';
/**
 * add-region.js — add a keepout region (REGION record) to a PCB document.
 *
 *   add-region rect --dir <project> --pcb PCB1 --prohibit "2,5"
 *                 --x 100 --y 100 --w 400 --h 300
 *   add-region poly --dir <project> --pcb PCB1 --prohibit 7
 *                 --pts "100,100,500,100,500,400,100,400"
 *
 * Coordinates are mil. --prohibit is a comma-separated list of rule ids:
 * 2 component, 3 via, 5 track, 6 fill, 7 pour, 8 inner plane
 * (1 and 4 are deprecated and rejected).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const PROHIBIT = { 2: 'component', 3: 'via', 5: 'track', 6: 'fill', 7: 'pour', 8: 'inner plane' };

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'prohibit', desc: 'rule ids: 2 component, 3 via, 5 track, 6 fill, 7 pour, 8 inner plane', required: true },
  { name: 'layer', desc: 'layer id (default 1 = top)' },
  { name: 'x', desc: 'rect top-left x (mil)' },
  { name: 'y', desc: 'rect top-left y (mil)' },
  { name: 'w', desc: 'rect width (mil)' },
  { name: 'h', desc: 'rect height (mil)' },
  { name: 'pts', desc: 'poly outline: comma-separated x,y pairs' },
  { name: 'width', desc: 'stroke width (default 1)' },
  { name: 'name', desc: 'region name (optional)' }
];

function numList(s, what) {
  const nums = String(s).split(',').map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isFinite(n)) || nums.length % 2 !== 0 || !nums.length) {
    die(`--${what} must be comma-separated x,y pairs like "x1,y1,x2,y2"`);
  }
  return nums;
}

function parseProhibit(s) {
  const ids = String(s).split(',').map((t) => Number(t.trim()));
  for (const id of ids) {
    if (!Number.isInteger(id)) die(`--prohibit entries must be integers, got "${s}"`);
    if (id === 1 || id === 4) die(`prohibitType ${id} is deprecated and not emitted`);
    if (!PROHIBIT[id]) die(`unknown prohibitType ${id} (want one of ${Object.keys(PROHIBIT).join(', ')})`);
  }
  return ids;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('add-region.js <rect|poly> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  if (opts.prohibit === undefined) die('--prohibit is required (e.g. --prohibit "2,5")');
  const prohibit = parseProhibit(opts.prohibit);

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

  const lines = E.readLines(file);
  E.appendLines(file, [E.pcbRegionLine({
    layerId: opts.layer !== undefined ? Number(opts.layer) : 1,
    path,
    width: opts.width !== undefined ? Number(opts.width) : undefined,
    prohibit,
    name: opts.name,
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`added ${cmd} keepout region (${prohibit.map((id) => PROHIBIT[id]).join(', ')}) on ${opts.pcb}`);
}

main();
