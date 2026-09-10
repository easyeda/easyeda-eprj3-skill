#!/usr/bin/env node
'use strict';
/**
 * add-symbol.js — place a library entry on a schematic sheet (the unified
 * placement entry: regular symbols, power flags, net ports, special symbols).
 *
 * Entries resolve preset-first (templates/library/, see load-library.js list),
 * then project staging (<project>/.tmp/library/). Kind dispatch:
 *   symbol  -> COMPONENT block; pair with a footprint entry via --footprint
 *              (the DEVICE doc is composed here, no device staging needed)
 *   power   -> power block, net/style from the entry (VCC/GND/...)
 *   port    -> port block, net from the entry (PORT_IN/...)
 *   special -> power-family block without Global Net Name (DIFF_PAIR/SHORT;
 *              unverified in the real client)
 * All embedded docs are rewritten to the project's client id first.
 *
 *   add-symbol --dir <project> --sch Schematic1 --sheet P1 --symbol RES
 *              [--footprint R0603] --x 300 --y -400 [--refdes R1]
 *              [--name <device title>] [--rotation 0]
 *
 * Coordinates are mil. The designator defaults to the entry's placeholder
 * (e.g. "R?"); renumber later with set-refdes.js.
 */
const fs = require('fs');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'sch', desc: 'schematic name', required: true },
  { name: 'sheet', desc: 'sheet title', required: true },
  { name: 'symbol', desc: 'library entry (symbol/power/port/special)', required: true },
  { name: 'footprint', desc: 'footprint entry to pair (kind symbol only)' },
  { name: 'x', desc: 'x (mil)', required: true },
  { name: 'y', desc: 'y (mil)', required: true },
  { name: 'refdes', desc: 'reference designator (default: entry placeholder)' },
  { name: 'name', desc: 'device title (default: footprint or symbol entry name)' },
  { name: 'rotation', desc: '0 | 90 | 180 | 270 (default 0, kind symbol only)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('add-symbol.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(opts.dir);
  const { sch, sheet } = project.requireSheet(opts.sch, opts.sheet);
  const file = project.sheetFile(sheet);
  if (!fs.existsSync(file)) die(`sheet document missing: ${file} (run init.js first)`);

  const entry = project.loadLibrary(opts.symbol);
  if (!entry) die(`library entry not found: ${opts.symbol} (see load-library.js list)`);
  if (entry.kind === 'footprint') {
    die(`entry "${opts.symbol}" is a footprint — place it on a PCB with add-footprint.js`);
  }
  const client = project.client;
  const embed = [];

  if (entry.kind === 'symbol') {
    const fp = opts.footprint ? project.loadLibrary(opts.footprint) : null;
    if (opts.footprint && (!fp || fp.kind !== 'footprint')) {
      die(`footprint entry not found: ${opts.footprint} (see load-library.js list)`);
    }
    const deviceTitle = opts.name || (fp ? fp.name : entry.name);
    const deviceUuid = E.uuid16();
    const deviceDoc = E.buildDeviceDoc({
      uuid: deviceUuid,
      title: deviceTitle,
      designator: entry.designator || 'U?',
      symbolUuid: entry.symbolUuid,
      symbolName: entry.name,
      footprintUuid: fp ? fp.footprintUuid : undefined,
      footprintName: fp ? fp.name : undefined,
      tags: [],
      source: E.makeSource(E.uuid32(), project.index.owner_uuid),
      client,
      ms: project.ms()
    });
    if (fp) embed.push(E.rewriteDocHeads(fp.footprintDoc, client));
    embed.push(E.rewriteDocHeads(entry.symbolDoc, client), E.rewriteDocHeads(deviceDoc, client));
    E.insertDocsBeforeMain(file, embed);

    const lines = E.readLines(file);
    const placement = entry.placement || { nameZ: 10, designatorZ: 11, symbolZ: 12 };
    const block = E.schComponentBlock({
      compId: E.randId(),
      x: Number(opts.x), y: Number(opts.y),
      rotation: Number(opts.rotation || 0),
      zIndex: E.nextMainZIndex(lines),
      symbolUuid: entry.symbolUuid,
      deviceUuid,
      deviceName: deviceTitle,
      footprintUuid: fp ? fp.footprintUuid : null,
      refdes: opts.refdes || entry.designator,
      uniqueId: E.nextUniqueId(lines),
      nameZ: placement.nameZ,
      designatorZ: placement.designatorZ,
      symbolZ: placement.symbolZ,
      ticketBase: E.maxTicketOfLines(lines) + 1
    });
    E.appendLines(file, block.lines);
    project.save();
    console.log(`placed ${opts.refdes || entry.designator} (${deviceTitle}) at ${opts.x},${opts.y} in ${opts.sch}/${opts.sheet}`);
    return;
  }

  if (opts.footprint) die(`--footprint only pairs with regular symbol entries (entry "${opts.symbol}" is kind ${entry.kind})`);
  if (entry.kind === 'power') {
    embed.push(
      E.rewriteDocHeads(entry.powerSymbolDoc, client),
      E.rewriteDocHeads(entry.powerDeviceDoc, client)
    );
  } else if (entry.kind === 'port') {
    embed.push(
      E.rewriteDocHeads(entry.portSymbolDoc, client),
      E.rewriteDocHeads(entry.portDeviceDoc, client)
    );
  } else {
    embed.push(
      E.rewriteDocHeads(entry.symbolDoc, client),
      E.rewriteDocHeads(entry.deviceDoc, client)
    );
  }
  E.insertDocsBeforeMain(file, embed);

  const lines = E.readLines(file);
  const common = {
    compId: E.randId(),
    x: Number(opts.x), y: Number(opts.y),
    zIndex: E.nextMainZIndex(lines),
    ticketBase: E.maxTicketOfLines(lines) + 1
  };
  let block, label;
  if (entry.kind === 'power') {
    block = E.powerComponentBlock(Object.assign({}, common, {
      symbolUuid: entry.symbolUuid,
      deviceUuid: entry.deviceUuid,
      net: entry.net,
      style: entry.style
    }));
    label = entry.net;
  } else if (entry.kind === 'port') {
    block = E.portComponentBlock(Object.assign({}, common, {
      symbolUuid: entry.symbolUuid,
      deviceUuid: entry.deviceUuid,
      net: entry.net
    }));
    label = entry.net;
  } else {
    block = E.specialComponentBlock(Object.assign({}, common, {
      symbolUuid: entry.symbolUuid,
      deviceUuid: entry.deviceUuid,
      name: entry.name
    }));
    label = entry.name;
  }
  E.appendLines(file, block.lines);
  project.save();
  console.log(`placed ${label} (${entry.name}) at ${opts.x},${opts.y} in ${opts.sch}/${opts.sheet}`);
  console.log(`  component id: ${common.compId}`);
}

main();
