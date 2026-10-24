#!/usr/bin/env node
'use strict';
/**
 * add-wire.js — draw a wire (one WIRE record + its LINE segments) on a
 * schematic sheet.
 *
 * Two ways to say where it goes:
 *
 *   # pin references — the script measures the pins and routes orthogonally
 *   add-wire --dir <p> --sch S --sheet P --from R1.2 --to C1.1 [--net SIG]
 *
 *   # raw geometry, in mil
 *   add-wire --dir <p> --sch S --sheet P --segs "300,-470,300,-470" [--net SIG]
 *
 * Pin references are strongly preferred: "R1.2" is resolved against the placed
 * component and its symbol, so a wire can never miss a pin tip by a few mil.
 * Chain several connections with --link "R1.2>C1.1;R1.1>VCC.1".
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const P = require('./lib/pins');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'from', desc: 'start pin reference, e.g. R1.2' },
  { name: 'to', desc: 'end pin reference, e.g. C1.1' },
  { name: 'link', desc: 'semicolon-separated pin pairs: "R1.2>C1.1;R1.1>U1.3"' },
  { name: 'segs', desc: 'segments x1,y1,x2,y2;... (mil)' },
  { name: 'net', desc: 'net name to label the wire with' },
  { name: 'stub', desc: 'stub length out of each pin (default 40 mil)' }
];

function parseSegs(spec) {
  return spec.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = s.split(',').map(Number);
    if (p.length !== 4 || p.some((v) => Number.isNaN(v))) die(`bad segment "${s}" (want x1,y1,x2,y2)`);
    return { startX: p[0], startY: p[1], endX: p[2], endY: p[3] };
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-wire.js [options]', SCHEMA,
      'Connect pins by reference (--from/--to or --link) or draw raw segments (--segs).');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const usePins = opts.from || opts.to || opts.link;
  if (usePins && opts.segs) die('use either --from/--to/--link or --segs, not both');
  if (!usePins && !opts.segs) die('nothing to draw: pass --from/--to, --link, or --segs');

  let segs;
  let summary;
  if (usePins) {
    const components = P.sheetPins(file);
    const pairs = [];
    if (opts.link) {
      for (const item of String(opts.link).split(';').map((s) => s.trim()).filter(Boolean)) {
        const parts = item.split('>');
        if (parts.length !== 2) die(`bad --link item "${item}" (want A.B>C.D)`);
        pairs.push(parts.map((s) => s.trim()));
      }
    } else {
      if (!opts.from || !opts.to) die('--from and --to must be given together');
      pairs.push([opts.from, opts.to]);
    }
    segs = [];
    for (const [from, to] of pairs) {
      const a = P.resolvePin(components, from);
      const b = P.resolvePin(components, to);
      const stub = opts.stub !== undefined ? Number(opts.stub) : 40;
      const path = P.routeBetween(a, b, { stub });
      segs.push(...path.map((s) => ({ startX: s.x1, startY: s.y1, endX: s.x2, endY: s.y2 })));
      summary = summary || [];
      summary.push(`${a.comp}.${a.pin} → ${b.comp}.${b.pin}`);
    }
    if (!segs.length) {
      console.error(`nothing to draw: the pins already coincide`);
      return;
    }
  } else {
    segs = parseSegs(opts.segs);
    summary = [`${segs.length} segment(s)`];
  }

  const lines = E.readLines(file);
  const block = E.wireBlock({
    segs,
    net: opts.net,
    zIndex: E.nextMainZIndex(lines),
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`drew wire (${segs.length} segment${segs.length === 1 ? '' : 's'}${opts.net ? `, net ${opts.net}` : ''}) in ${opts.sch}/${opts.sheet}: ${summary.join(', ')}`);
  console.log(`  wire id: ${block.wireId}`);
}

main();
