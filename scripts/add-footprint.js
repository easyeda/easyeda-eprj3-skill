#!/usr/bin/env node
'use strict';
/**
 * add-footprint.js — Place a footprint component on a PCB document.
 *
 * Usage:
 *   node scripts/add-footprint.js add \
 *     --dir <projectDir> \
 *     --pcb <pcbName> \
 *     --footprint <fpName> \
 *     --refdes <U1> --x <mil> --y <mil> [--rot 0] [--layer top]
 */
const path = require('path');
const { Project, uuid, randId, appendRecord, readDocHeadUuid } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root directory' },
  { name: 'pcb', alias: 'p', hasValue: true, required: true, desc: 'PCB document name' },
  { name: 'footprint', alias: 'f', hasValue: true, required: true, desc: 'Footprint name/uuid' },
  { name: 'refdes', alias: 'r', hasValue: true, desc: 'Reference designator' },
  { name: 'x', hasValue: true, default: '0', desc: 'X position (mil)' },
  { name: 'y', hasValue: true, default: '0', desc: 'Y position (mil)' },
  { name: 'rot', hasValue: true, default: '0', desc: 'Rotation in degrees' },
  { name: 'layer', hasValue: true, default: '1', desc: 'Layer ID (1=top, 2=bottom)' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('add-footprint.js add [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'add') die(`Unknown command: ${sub}`);

  const project = await Project.load(path.resolve(opts.dir));
  const file = project.ensurePcbDocument(opts.pcb);
  const compUuid = uuid(8);
  const fpUuid = readDocHeadUuid(path.join(project.rootDir, 'sch', '__footprints__', `${opts.footprint}.esch2`)) || uuidFromName(opts.footprint);
  const fpMeta = JSON.stringify({ uuid: fpUuid, name: opts.footprint, source: '' });
  appendRecord(file, 'COMPONENT', {
    id: compUuid,
    partId: 'pid' + randId(),
    x: parseFloat(opts.x), y: parseFloat(opts.y),
    rotation: parseFloat(opts.rot), isMirror: parseInt(opts.layer) === 2,
    attrs: { Footprints: '[]', Devices: '[]', DeviceName: fpMeta, FootprintName: null },
    zIndex: null
  });
  if (opts.refdes) {
    appendRecord(file, 'ATTR', {
      x: parseFloat(opts.x) + 10, y: parseFloat(opts.y) - 10,
      key: 'Designator', value: opts.refdes,
      keyVisible: false, valueVisible: true,
      parentId: compUuid, zIndex: 1, fontSize: 10, align: 'LEFT_TOP'
    });
  }
  console.log(`Added footprint ${opts.refdes || compUuid} on ${opts.pcb}`);
}

function uuidFromName(name) {
  // Fallback when no embedded footprint doc exists for this name.
  return require('crypto').createHash('md5').update(name).digest('hex').slice(0, 16);
}

main().catch(err => die(err.message, 1));
