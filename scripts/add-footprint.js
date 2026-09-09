#!/usr/bin/env node
'use strict';
/**
 * add-footprint.js — place a staged device (kind "device" with a footprint)
 * on a PCB document.
 *
 * Embeds the symbol/footprint/device docs into the PCB file (once), inserts
 * any new named NET records after the empty NET (as the example does), and
 * appends the PAD_NETs + COMPONENT + ATTR block at EOF.
 *
 *   add-footprint --dir <project> --pcb PCB1 --lib <entry>
 *                 --x 300 --y 300 [--angle 90] [--refdes R1]
 *                 [--nets "1:VCC,2:GND"]
 *
 * Coordinates are mil.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'lib', desc: 'staged library entry (device with footprint)', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'angle', desc: 'rotation (default 90, as the example)' },
  { name: 'refdes', desc: 'reference designator' },
  { name: 'nets', desc: 'pad net map num:NET;... e.g. "1:VCC,2:GND"' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-footprint.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const pcb = project.requirePcb(opts.pcb);
  const file = project.pcbFile(pcb);
  if (!fs.existsSync(file)) die(`PCB document missing: ${file} (run init.js first)`);

  const entry = project.loadLibrary(opts.lib);
  if (entry.kind !== 'device' || !entry.footprintDoc) {
    die(`library entry "${opts.lib}" must be a device with a footprint (use load-library.js device --footprint ...)`);
  }

  const netsByNum = {};
  const nets = new Set();
  if (opts.nets) {
    for (const pair of opts.nets.split(',')) {
      const [num, net] = pair.split(':').map((s) => s.trim());
      if (!num || !net) die(`bad --nets item "${pair}" (want num:NET)`);
      netsByNum[num] = net;
      nets.add(net);
    }
    E.ensurePcbNets(file, [...nets]);
  }

  // The example PCB file embeds the symbol, footprint and device docs of every
  // placed component.
  E.insertDocsBeforeMain(file, [entry.symbolDoc, entry.footprintDoc, entry.deviceDoc]);

  const lines = E.readLines(file);
  const compId = E.randId();
  const block = E.pcbComponentBlock({
    compId,
    x: Number(opts.x), y: Number(opts.y),
    angle: opts.angle !== undefined ? Number(opts.angle) : 90,
    deviceUuid: entry.deviceUuid,
    deviceName: entry.deviceTitle,
    footprintUuid: entry.footprintUuid,
    refdes: opts.refdes || entry.designator,
    uniqueId: E.nextUniqueId(lines),
    pads: entry.footprintElems.pads.map((p) => ({
      num: p.num, elemId: p.elemId, net: netsByNum[p.num] || ''
    })),
    attrFootprint: entry.footprintElems.attrFootprint,
    attrDesignator: entry.footprintElems.attrDesignator,
    zIndexFootprint: entry.attrZ.footprint,
    zIndexDesignator: entry.attrZ.designator,
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`placed ${opts.refdes || entry.designator} (${entry.deviceTitle}) at ${opts.x},${opts.y} on ${opts.pcb}`);
  console.log(`  component id: ${compId}${nets.size ? `, nets: ${[...nets].join(', ')}` : ''}`);
}

main();
