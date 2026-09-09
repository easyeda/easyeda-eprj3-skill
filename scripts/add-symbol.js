#!/usr/bin/env node
'use strict';
/**
 * add-symbol.js — Add a placed COMPONENT referencing a SYMBOL on a schematic sheet.
 *
 * Usage:
 *   node scripts/add-symbol.js add \
 *     --dir <projectDir> \
 *     --schematic <schName> --sheet <sheetTitle> \
 *     --symbol <symbolNameOrUuid> \
 *     --refdes <R1> --x <mil> --y <mil> [--rot 0] [--mirror false] \
 *     [--footprint <fpName>] [--value <text>]
 *
 * Effect:
 *   Appends a COMPONENT record plus required ATTR records (Designator, Value, Footprint)
 *   to the sheet's .esch2 file.
 */
const fs = require('fs');
const path = require('path');
const { Project, uuid, randId, appendRecord, readDocHeadUuid } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root directory' },
  { name: 'schematic', alias: 's', hasValue: true, required: true, desc: 'Schematic name' },
  { name: 'sheet', alias: 'p', hasValue: true, required: true, desc: 'Sheet title (file basename)' },
  { name: 'symbol', alias: 'y', hasValue: true, required: true, desc: 'Symbol name or uuid (from a SYMBOL doc)' },
  { name: 'refdes', alias: 'r', hasValue: true, desc: 'Reference designator (e.g. R1)' },
  { name: 'value', alias: 'v', hasValue: true, desc: 'Component value/comment' },
  { name: 'footprint', alias: 'f', hasValue: true, desc: 'Footprint name (e.g. 0603)' },
  { name: 'x', hasValue: true, default: '0', desc: 'X position in mil' },
  { name: 'y', hasValue: true, default: '0', desc: 'Y position in mil' },
  { name: 'rot', hasValue: true, default: '0', desc: 'Rotation in degrees' },
  { name: 'mirror', hasValue: false, desc: 'Mirror the symbol' },
  { name: 'uuid', hasValue: true, desc: 'Override component uuid' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp('add-symbol.js add [options]', schema); process.exit(sub ? 0 : 1);
  }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'add') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const file = project.ensureSheetDocument(opts.schematic, opts.sheet);

  const compUuid = opts.uuid || randId();
  const symUuid = readDocHeadUuid(path.join(project.rootDir, 'sch', '__symbols__', `${opts.symbol}.esch2`)) || uuidFromName(opts.symbol);
  const symMeta = JSON.stringify({ uuid: symUuid, name: opts.symbol, source: '' });
  const fpUuid = opts.footprint
    ? (readDocHeadUuid(path.join(project.rootDir, 'sch', '__footprints__', `${opts.footprint}.esch2`)) || uuidFromName(opts.footprint))
    : null;
  const partId = 'pid' + randId();
  const body = {
    id: compUuid,
    partId,
    x: parseFloat(opts.x), y: parseFloat(opts.y),
    rotation: parseFloat(opts.rot), isMirror: !!opts.mirror,
    attrs: {
      Footprints: '[]',
      Devices: '[]',
      DeviceName: symMeta,
      FootprintName: opts.footprint ? JSON.stringify({ uuid: fpUuid, name: opts.footprint, source: '' }) : null,
      pinClass: {}, differentialPairClass: {},
      Symbols: '[]'
    },
    zIndex: null
  };
  appendRecord(file, 'COMPONENT', body);
  let z = 1;
  if (opts.refdes) {
    appendRecord(file, 'ATTR', { x: parseFloat(opts.x) + 10, y: parseFloat(opts.y) - 10, key: 'Designator', value: opts.refdes, keyVisible: false, valueVisible: true, parentId: compUuid, zIndex: ++z, fontSize: 10, align: 'LEFT_TOP' });
  }
  if (opts.value) {
    appendRecord(file, 'ATTR', { x: parseFloat(opts.x) + 10, y: parseFloat(opts.y) + 10, key: 'Value', value: opts.value, keyVisible: false, valueVisible: true, parentId: compUuid, zIndex: ++z, fontSize: 10, align: 'LEFT_BOTTOM' });
  }
  console.log(`Added COMPONENT ${opts.refdes || compUuid} on ${opts.schematic}/${opts.sheet}`);
}

function uuidFromName(name) {
  // Fallback when no embedded symbol/footprint doc exists for this name.
  const h = require('crypto').createHash('md5').update(name).digest('hex');
  return h.slice(0, 16);
}

main().catch(err => die(err.message, 1));