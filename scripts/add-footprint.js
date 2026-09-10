#!/usr/bin/env node
'use strict';
/**
 * add-footprint.js — place a symbol+footprint pair on a PCB document.
 *
 * PCB containers embed the SYMBOL + FOOTPRINT + DEVICE docs of every placed
 * component; both library entries resolve preset-first
 * (templates/library/, see load-library.js list), then project staging
 * (<project>/.tmp/library/). The DEVICE doc is composed here — no device
 * staging. All embedded docs are rewritten to the project's client id first.
 *
 *   add-footprint --dir <project> --pcb PCB1 --symbol RES --footprint R0603
 *                 --x 300 --y 300 [--angle 90] [--refdes R1]
 *                 [--name <device title>] [--nets "1:VCC,2:GND"]
 *
 * Coordinates are mil. Named nets are inserted after the empty NET record.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'pcb', desc: 'PCB title', required: true },
  { name: 'symbol', desc: 'symbol library entry', required: true },
  { name: 'footprint', desc: 'footprint library entry', required: true },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'angle', desc: 'rotation (default 90, as the example)' },
  { name: 'refdes', desc: 'reference designator (default: symbol placeholder)' },
  { name: 'name', desc: 'device title (default: footprint entry name)' },
  { name: 'nets', desc: 'pad net map num:NET,... e.g. "1:VCC,2:GND"' }
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

  const sym = project.loadLibrary(opts.symbol);
  if (!sym || sym.kind !== 'symbol') {
    die(`symbol entry not found: ${opts.symbol} (see load-library.js list; entry must be kind "symbol")`);
  }
  const fp = project.loadLibrary(opts.footprint);
  if (!fp || fp.kind !== 'footprint') {
    die(`footprint entry not found: ${opts.footprint} (see load-library.js list)`);
  }

  const deviceTitle = opts.name || fp.name;
  const client = project.client;
  const deviceUuid = E.uuid16();
  const deviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: deviceTitle,
    designator: sym.designator || 'U?',
    symbolUuid: sym.symbolUuid,
    symbolName: sym.name,
    footprintUuid: fp.footprintUuid,
    footprintName: fp.name,
    tags: [],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    client,
    ms: project.ms()
  });
  E.insertDocsBeforeMain(file, [
    E.rewriteDocHeads(sym.symbolDoc, client),
    E.rewriteDocHeads(fp.footprintDoc, client),
    E.rewriteDocHeads(deviceDoc, client)
  ]);

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

  const lines = E.readLines(file);
  const compId = E.randId();
  const block = E.pcbComponentBlock({
    compId,
    x: Number(opts.x), y: Number(opts.y),
    angle: opts.angle !== undefined ? Number(opts.angle) : 90,
    deviceUuid,
    deviceName: deviceTitle,
    footprintUuid: fp.footprintUuid,
    refdes: opts.refdes || sym.designator,
    uniqueId: E.nextUniqueId(lines),
    pads: fp.footprintElems.pads.map((p) => ({
      num: p.num, elemId: p.elemId, net: netsByNum[p.num] || ''
    })),
    attrFootprint: fp.footprintElems.attrFootprint,
    attrDesignator: fp.footprintElems.attrDesignator,
    zIndexFootprint: fp.attrZ.footprint,
    zIndexDesignator: fp.attrZ.designator,
    ticketBase: E.maxTicketOfLines(lines) + 1
  });
  E.appendLines(file, block.lines);
  project.save();
  console.log(`placed ${opts.refdes || sym.designator} (${deviceTitle}) at ${opts.x},${opts.y} on ${opts.pcb}`);
  console.log(`  component id: ${compId}${nets.size ? `, nets: ${[...nets].join(', ')}` : ''}`);
}

main();
