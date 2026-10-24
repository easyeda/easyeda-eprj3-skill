#!/usr/bin/env node
'use strict';
/**
 * pour-auto.js — pour copper along the board outline, with a stitching fence.
 *
 * `add-pour.js` draws a pour where you point it. This derives the region from
 * the BOARD_OUTLINE instead: inset by the edge clearance, one pour per copper
 * layer, plus a via fence (and a coarse interior grid) so the top and bottom
 * planes are actually stitched together. That is the "add ground planes" step
 * of a finished board, not a manual drawing job.
 *
 *   node scripts/pour-auto.js --dir <project> [--pcb PCB1] [--net GND]
 *        [--clearance 16] [--layers 1,2] [--spacing 100] [--no-stitch]
 *        [--replace] [--dry-run]
 *
 * --replace removes existing POUR records on the poured layers first, so the
 * command is idempotent.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const G = require('./lib/geom');
const P = require('./lib/parts');
const { planPours } = require('./lib/pour');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB document title (default: the first one)' },
  { name: 'net', desc: 'net to pour (default GND)' },
  { name: 'clearance', desc: 'inset from the board edge (mil, default 16)' },
  { name: 'layers', desc: 'comma-separated layer ids (default 1,2)' },
  { name: 'spacing', desc: 'stitching via spacing (mil, default 100)' },
  { name: 'no-stitch', desc: 'do not add stitching vias', hasValue: false },
  { name: 'replace', desc: 'remove existing pours on those layers first', hasValue: false },
  { name: 'dry-run', desc: 'report what would be written, change nothing', hasValue: false },
  { name: 'json', desc: 'machine-readable output', hasValue: false }
];

/** Board outline bbox from a PCB document, falling back to the documented default. */
function boardOutline(file) {
  for (const r of E.readRecords(file)) {
    if (r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE') {
      const bb = G.bboxOfPoints(P.pathToPoints(r.body.path));
      if (bb) return { width: bb.x2 - bb.x1, height: bb.y2 - bb.y1, originX: bb.x1, originY: bb.y1, bbox: bb };
    }
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('pour-auto.js [options]', SCHEMA,
      'Derive copper pours from the board outline and stitch them with a via fence.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcbs = Object.values(project.profile.pcbs);
  if (!pcbs.length) die(`no PCB in ${opts.dir}`);
  const pcb = opts.pcb ? project.requirePcb(opts.pcb) : pcbs[0];
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file}`);

  const outline = boardOutline(file);
  if (!outline) die(`no BOARD_OUTLINE poly in ${file} — run init.js or add-pcb-shape.js first`);

  const net = opts.net || 'GND';
  const layers = (opts.layers || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n === 1 || n === 2);
  if (!layers.length) die('--layers must contain 1 and/or 2 (the only copper layers this skill authors)');

  const plan = planPours(outline, {
    net,
    clearance: opts.clearance !== undefined ? Number(opts.clearance) : 16,
    layers,
    stitch: !opts['no-stitch'],
    stitchSpacing: opts.spacing !== undefined ? Number(opts.spacing) : 100
  });

  const summary = {
    net,
    layers,
    pours: plan.pours.length,
    stitchingVias: plan.vias.length,
    region: plan.region,
    notes: plan.notes
  };

  if (opts['dry-run']) {
    if (opts.json) console.log(JSON.stringify(Object.assign({ dryRun: true }, summary), null, 2));
    else {
      console.log(`would pour ${net} on layer(s) ${layers.join(',')} inside ${JSON.stringify(plan.region)}`);
      console.log(`would add ${plan.vias.length} stitching vias`);
      for (const n of plan.notes) console.log(`  note: ${n}`);
    }
    return;
  }

  if (opts.replace) {
    const removed = E.removeRecord(file, (r) => r.type === 'POUR'
      && layers.includes(r.body && r.body.layerId));
    summary.replaced = removed;
  }

  E.ensurePcbNets(file, [net]);
  const lines = E.readLines(file);
  let ticket = E.maxTicketOfLines(lines) + 1;
  let z = E.nextMainZIndex(lines);
  const out = [];
  let n = 0;
  for (const p of plan.pours) {
    n += 1;
    out.push(E.pcbPourLine({
      netName: p.net,
      layerId: p.layer,
      name: `POUR${n}`,
      path: p.path,
      ticketBase: ticket++
    }));
  }
  for (const v of plan.vias) {
    out.push(E.pcbViaLine({
      netName: v.net, x: v.x, y: v.y,
      viaDiameter: v.width, holeDiameter: v.hole,
      ticketBase: ticket++
    }));
  }
  E.appendLines(file, out);
  project.save();
  void z;

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`poured ${net} on layer(s) ${layers.join(',')} — ${plan.pours.length} POUR record(s), ${plan.vias.length} stitching via(s)`);
  for (const note of plan.notes) console.log(`  note: ${note}`);
}

main();
