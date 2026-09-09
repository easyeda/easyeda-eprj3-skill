#!/usr/bin/env node
'use strict';
/**
 * add-region.js — add a keepout region (REGION record) to a PCB document.
 *
 *   add-region rect --dir <project> --pcb PCB1 --prohibit "COMPONENT,TRACK"
 *                 --x 100 --y 100 --w 400 --h 300
 *   add-region poly --dir <project> --pcb PCB1 --prohibit COPPER
 *                 --pts "100,100,500,100,500,400,100,400"
 *
 * Coordinates are mil. --prohibit is a comma-separated list of EProhibitType
 * names: COMPONENT, VIA, TRACK, FILL, COPPER, PLANE. --region-type PROHIBIT
 * (default) or CONSTRAINT.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const PROHIBIT = ['COMPONENT', 'VIA', 'TRACK', 'FILL', 'COPPER', 'PLANE'];

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'prohibit', desc: 'EProhibitType names: COMPONENT, VIA, TRACK, FILL, COPPER, PLANE', required: true },
  { name: 'region-type', desc: 'PROHIBIT (default) or CONSTRAINT' },
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
  const names = String(s).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!names.length) die('--prohibit is empty');
  for (const n of names) {
    if (!PROHIBIT.includes(n)) die(`unknown prohibitType "${n}" (want one of ${PROHIBIT.join(', ')})`);
  }
  return names;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('add-region.js <rect|poly> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  if (opts.prohibit === undefined) die('--prohibit is required (e.g. --prohibit "COMPONENT,TRACK")');
  const prohibit = parseProhibit(opts.prohibit);
  const regionType = opts['region-type'] !== undefined ? opts['region-type'].toUpperCase() : 'PROHIBIT';
  if (regionType !== 'PROHIBIT' && regionType !== 'CONSTRAINT') {
    die('--region-type must be PROHIBIT or CONSTRAINT');
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

  const lines = E.readLines(file);
  E.appendLines(file, [E.pcbRegionLine({
    layerId: opts.layer !== undefined ? Number(opts.layer) : 1,
    path,
    width: opts.width !== undefined ? Number(opts.width) : undefined,
    prohibit,
    regionType,
    name: opts.name,
    ticketBase: E.maxTicketOfLines(lines) + 1
  })]);
  project.save();
  console.log(`added ${cmd} ${regionType.toLowerCase()} region (${prohibit.join(', ')}) on ${opts.pcb}`);
}

main();
