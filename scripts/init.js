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
const { Project } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

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
    const file = project.ensureSheetDocument(opts['with-schematic'], 'P1');
    const cfg = path.join(dir, 'sch', opts['with-schematic'], `${opts['with-schematic']}.ecfg`);
    const evar = path.join(dir, 'sch', opts['with-schematic'], `${opts['with-schematic']}.evar`);
    require('fs').writeFileSync(cfg, '');
    require('fs').writeFileSync(evar, '');
    console.log(`  sch:   ${file}`);
  }

  if (opts['with-pcb']) {
    const file = project.ensurePcbDocument(opts['pcb-name']);
    console.log(`  pcb:   ${file}`);
  }
}

main().catch(err => die(err.message, 1));