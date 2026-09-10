#!/usr/bin/env node
'use strict';
/**
 * add-pcb-shape.js — draw graphics on a PCB document.
 *
 *   add-pcb-shape rect    --dir <p> --pcb PCB1 --x 500 --y 500 --w 400 --h 300
 *                        [--layer 1] [--width 2]
 *   add-pcb-shape poly    --dir <p> --pcb PCB1 --pts "500,500,900,500,700,800"
 *                        [--closed] [--layer 1] [--width 2]
 *   add-pcb-shape circle  --dir <p> --pcb PCB1 --cx 700 --cy 650 --r 100
 *                        [--layer 1] [--width 2]
 *   add-pcb-shape arc     --dir <p> --pcb PCB1 --x1 500 --y1 500 --x2 900 --y2 500
 *                        --angle 90 [--layer 1] [--width 10]
 *
 * Coordinates are mil. rect/poly/circle emit POLY records (rect uses the
 * ["R",x,y,w,h,0,0] form, circle the ["CIRCLE",cx,cy,r,isCCW] form); arc emits
 * an ARC record with a signed sweep angle (CCW positive). These are graphics
 * only — use add-pour for copper pours.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'x', desc: 'rect top-left x (mil)' },
  { name: 'y', desc: 'rect top-left y (mil)' },
  { name: 'w', desc: 'rect width (mil)' },
  { name: 'h', desc: 'rect height (mil)' },
  { name: 'pts', desc: 'comma-separated x,y pairs: "x1,y1,x2,y2,..."' },
  { name: 'closed', desc: 'close the polyline (flag)', hasValue: false },
  { name: 'cx', desc: 'circle center x (mil)' },
  { name: 'cy', desc: 'circle center y (mil)' },
  { name: 'r', desc: 'circle radius (mil)' },
  { name: 'x1', desc: 'arc start x (mil)' },
  { name: 'y1', desc: 'arc start y (mil)' },
  { name: 'x2', desc: 'arc end x (mil)' },
  { name: 'y2', desc: 'arc end y (mil)' },
  { name: 'angle', desc: 'arc sweep angle degrees, CCW positive' },
  { name: 'layer', desc: 'layer id (default 1 = top)' },
  { name: 'width', desc: 'stroke width (default 2, arc 10)' }
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
    printHelp('add-pcb-shape.js <rect|poly|circle|arc> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  const layerId = opts.layer !== undefined ? Number(opts.layer) : 1;
  const lines = E.readLines(file);
  const ticket = E.maxTicketOfLines(lines) + 1;
  let record;
  if (cmd === 'rect') {
    if ([opts.x, opts.y, opts.w, opts.h].some((v) => v === undefined)) die('rect needs --x --y --w --h');
    record = E.pcbPolyLine({
      layerId,
      width: opts.width !== undefined ? Number(opts.width) : 2,
      path: E.rectPath(Number(opts.x), Number(opts.y), Number(opts.w), Number(opts.h)),
      ticketBase: ticket
    });
  } else if (cmd === 'poly') {
    if (!opts.pts) die('poly needs --pts "x1,y1,x2,y2,..."');
    const nums = numList(opts.pts, 'pts');
    if (nums.length < 4) die('poly needs at least 2 points');
    const path = [nums[0], nums[1], 'L', ...nums.slice(2)];
    if (opts.closed) {
      const last = nums[nums.length - 2];
      const lastY = nums[nums.length - 1];
      if (nums[0] !== last || nums[1] !== lastY) path.push(nums[0], nums[1]);
    }
    record = E.pcbPolyLine({
      layerId,
      width: opts.width !== undefined ? Number(opts.width) : 2,
      path,
      ticketBase: ticket
    });
  } else if (cmd === 'circle') {
    if ([opts.cx, opts.cy, opts.r].some((v) => v === undefined)) die('circle needs --cx --cy --r');
    record = E.pcbPolyLine({
      layerId,
      width: opts.width !== undefined ? Number(opts.width) : 2,
      path: ['CIRCLE', Number(opts.cx), Number(opts.cy), Number(opts.r), 1],
      ticketBase: ticket
    });
  } else if (cmd === 'arc') {
    if ([opts.x1, opts.y1, opts.x2, opts.y2, opts.angle].some((v) => v === undefined)) {
      die('arc needs --x1 --y1 --x2 --y2 --angle');
    }
    record = E.pcbArcLine({
      layerId,
      startX: Number(opts.x1), startY: Number(opts.y1),
      endX: Number(opts.x2), endY: Number(opts.y2),
      angle: Number(opts.angle),
      width: opts.width !== undefined ? Number(opts.width) : 10,
      ticketBase: ticket
    });
  } else {
    die(`unknown shape "${cmd}" (want: rect | poly | circle | arc)`);
  }

  E.appendLines(file, [record]);
  project.save();
  console.log(`drew ${cmd} on ${opts.pcb} (layer ${layerId})`);
}

main();
