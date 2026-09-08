#!/usr/bin/env node
'use strict';
/**
 * init.js — Create a new eprj3 project skeleton.
 *
 * Usage:
 *   node scripts/init.js init --dir <path> [--name <projectName>] [--with-pcb] [--with-schematic <name>]
 *
 * Side effects:
 *   <dir>/<name>.eprj3            <- project index
 *   <dir>/sch/<schematic>/...     <- if --with-schematic given
 *   <dir>/pcb/<pcb>.epcb2         <- if --with-pcb given
 */
const path = require('path');
const { Project, uuid, writeRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die, ensureDir } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root directory' },
  { name: 'name', alias: 'n', hasValue: true, desc: 'Project name (defaults to folder name)' },
  { name: 'with-pcb', alias: 'p', hasValue: false, desc: 'Create an empty PCB document' },
  { name: 'with-schematic', alias: 's', hasValue: true, desc: 'Create a schematic with the given name' },
  { name: 'pcb-name', hasValue: true, default: 'PCB1', desc: 'PCB document name when --with-pcb is set' },
  { name: 'help', alias: 'h', hasValue: false, desc: 'Show this help' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp('init.js <command> [options]', schema, 'Commands: init');
    process.exit(sub ? 0 : 1);
  }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (opts.help) return printHelp('init.js init [options]', schema);
  const dir = path.resolve(opts.dir);
  const name = opts.name || path.basename(dir);
  if (sub !== 'init') die(`Unknown command: ${sub}. Use 'init'.`);

  const project = await Project.create(dir, name);
  console.log(`Created project "${name}" at ${dir}`);
  console.log(`  index: ${project.indexFile}`);

  if (opts['with-schematic']) {
    const sch = project.ensureSchematic(opts['with-schematic']);
    const sheet = project.ensureSheet(sch, 'P1');
    const file = project.sheetFile(sheet);
    writeRecords(file, [
      { head: { type: 'DOCHEAD' }, body: { docType: 'SCH', client: 'easyeda-pro-skill', uuid: sch.uuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } },
      { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: sheet.title, source: '', board: sch.board, zIndex: null } },
      { head: { type: 'CANVAS', ticket: 2, id: 'CANVAS' }, body: { originX: 0, originY: 0 } }
    ]);
    const cfg = path.join(dir, 'sch', sch.name, `${sch.name}.ecfg`);
    const evar = path.join(dir, 'sch', sch.name, `${sch.name}.evar`);
    require('fs').writeFileSync(cfg, '');
    require('fs').writeFileSync(evar, '');
    console.log(`  sch:   ${file}`);
  }

  if (opts['with-pcb']) {
    const pcb = project.ensurePcb(opts['pcb-name']);
    const file = project.pcbFile(pcb);
    writeRecords(file, [
      { head: { type: 'DOCHEAD' }, body: { docType: 'PCB', client: 'easyeda-pro-skill', uuid: pcb.uuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } },
      { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: pcb.title, board: pcb.board, source: '' } },
      { head: { type: 'CANVAS', ticket: 2, id: 'CANVAS' }, body: { originX: 0, originY: 0 } },
      { head: { type: 'LAYER', ticket: 3, id: '["LAYER",1]' }, body: { layerType: 'TOP', layerName: 'Top Layer', use: true, show: true, locked: false, activeColor: '#FF0000', activateTransparency: 1, inactiveColor: '#7F0000', inactiveTransparency: 1 } },
      { head: { type: 'LAYER', ticket: 4, id: '["LAYER",2]' }, body: { layerType: 'BOTTOM', layerName: 'Bottom Layer', use: true, show: true, locked: false, activeColor: '#0000FF', activateTransparency: 1, inactiveColor: '#00007F', inactiveTransparency: 1 } }
    ]);
    console.log(`  pcb:   ${file}`);
  }
}

main().catch(err => die(err.message, 1));