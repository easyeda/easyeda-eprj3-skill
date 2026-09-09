#!/usr/bin/env node
'use strict';
/**
 * add-shape.js — draw non-electrical graphics on a schematic sheet.
 *
 *   add-shape rect    --dir <p> --sch S1 --sheet P1 --x1 200 --y1 -200 --x2 400 --y2 -300
 *                    [--radius 0] [--rotation 0]
 *   add-shape poly    --dir <p> --sch S1 --sheet P1 --pts "200,-200,300,-100,400,-200"
 *                    [--closed]
 *   add-shape circle  --dir <p> --sch S1 --sheet P1 --cx 300 --cy -250 --r 50
 *   add-shape ellipse --dir <p> --sch S1 --sheet P1 --cx 300 --cy -250 --rx 80 --ry 40
 *                    [--rotation 0]
 *   add-shape arc     --dir <p> --sch S1 --sheet P1 --start 200,-200 --mid 300,-300
 *                    --end 400,-200
 *   add-shape bezier  --dir <p> --sch S1 --sheet P1 --pts "200,-200,250,-100,350,-100,400,-200"
 *
 * Coordinates are mil. Shapes are annotations only — they carry no net
 * connectivity (use add-wire for electrical connections).
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'x1', desc: 'rect corner 1 x (mil)' },
  { name: 'y1', desc: 'rect corner 1 y (mil)' },
  { name: 'x2', desc: 'rect corner 2 x (mil)' },
  { name: 'y2', desc: 'rect corner 2 y (mil)' },
  { name: 'radius', desc: 'rect corner radius (default 0)' },
  { name: 'rotation', desc: 'rotation degrees CCW (default 0)' },
  { name: 'pts', desc: 'comma-separated x,y pairs: "x1,y1,x2,y2,..."' },
  { name: 'closed', desc: 'close the polyline (flag)', hasValue: false },
  { name: 'cx', desc: 'center x (mil)' },
  { name: 'cy', desc: 'center y (mil)' },
  { name: 'r', desc: 'circle radius (mil)' },
  { name: 'rx', desc: 'ellipse radius x (mil)' },
  { name: 'ry', desc: 'ellipse radius y (mil)' },
  { name: 'start', desc: 'arc start point "x,y"' },
  { name: 'mid', desc: 'point the arc passes through "x,y"' },
  { name: 'end', desc: 'arc end point "x,y"' }
];

function numList(s, what) {
  const nums = String(s).split(',').map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isFinite(n)) || nums.length % 2 !== 0 || !nums.length) {
    die(`--${what} must be comma-separated x,y pairs like "x1,y1,x2,y2"`);
  }
  return nums;
}
function pair(s, what) {
  const nums = numList(s, what);
  if (nums.length !== 2) die(`--${what} must be a single "x,y" pair`);
  return { x: nums[0], y: nums[1] };
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('add-shape.js <rect|poly|circle|ellipse|arc|bezier> [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const lines = E.readLines(file);
  const ctx = { zIndex: E.nextMainZIndex(lines), ticketBase: E.maxTicketOfLines(lines) + 1 };
  let record;
  if (cmd === 'rect') {
    if ([opts.x1, opts.y1, opts.x2, opts.y2].some((v) => v === undefined)) die('rect needs --x1 --y1 --x2 --y2');
    record = E.schRectLine({
      x1: Number(opts.x1), y1: Number(opts.y1),
      x2: Number(opts.x2), y2: Number(opts.y2),
      rotation: opts.rotation !== undefined ? Number(opts.rotation) : 0,
      radiusX: opts.radius !== undefined ? Number(opts.radius) : 0,
      radiusY: opts.radius !== undefined ? Number(opts.radius) : 0,
      ...ctx
    });
  } else if (cmd === 'poly' || cmd === 'bezier') {
    if (!opts.pts) die(`${cmd} needs --pts "x1,y1,x2,y2,..."`);
    const nums = numList(opts.pts, 'pts');
    if (cmd === 'poly') {
      record = E.schPolyLine({
        points: nums.reduce((acc, n, i) => {
          if (i % 2 === 0) acc.push({ x: n, y: nums[i + 1] });
          return acc;
        }, []),
        closed: !!opts.closed,
        ...ctx
      });
    } else {
      if (nums.length < 8 || nums.length % 2 !== 0) die('bezier needs at least 4 control points (8 numbers)');
      record = E.schBezierLine({ controls: nums, ...ctx });
    }
  } else if (cmd === 'circle') {
    if ([opts.cx, opts.cy, opts.r].some((v) => v === undefined)) die('circle needs --cx --cy --r');
    record = E.schCircleLine({ cx: Number(opts.cx), cy: Number(opts.cy), r: Number(opts.r), ...ctx });
  } else if (cmd === 'ellipse') {
    if ([opts.cx, opts.cy, opts.rx, opts.ry].some((v) => v === undefined)) die('ellipse needs --cx --cy --rx --ry');
    record = E.schEllipseLine({
      cx: Number(opts.cx), cy: Number(opts.cy),
      rx: Number(opts.rx), ry: Number(opts.ry),
      rotation: opts.rotation !== undefined ? Number(opts.rotation) : 0,
      ...ctx
    });
  } else if (cmd === 'arc') {
    if (!opts.start || !opts.mid || !opts.end) die('arc needs --start --mid --end "x,y"');
    const s = pair(opts.start, 'start');
    const m = pair(opts.mid, 'mid');
    const e = pair(opts.end, 'end');
    record = E.schArcLine({
      startX: s.x, startY: s.y, referX: m.x, referY: m.y, endX: e.x, endY: e.y,
      ...ctx
    });
  } else {
    die(`unknown shape "${cmd}" (want: rect | poly | circle | ellipse | arc | bezier)`);
  }

  E.appendLines(file, [record]);
  project.save();
  console.log(`drew ${cmd} in ${opts.sch}/${opts.sheet}`);
}

main();
