#!/usr/bin/env node
'use strict';
/**
 * init.js — create a new eprj3 folder project: index, schematic container
 * (.ecfg/.evar), sheet document (A4 frame + page) and PCB document (preamble +
 * board outline). The panel is optional — pass --panel to add one.
 *
 *   node scripts/init.js --dir <dir> [--name <proj>] [--schematic Schematic1]
 *                        [--sheet P1] [--pcb PCB1] [--panel Panel1]
 *                        [--board-w 4000] [--board-h 3000]
 *
 * --board-w/--board-h set the PCB board outline in mil (default 4000x3000).
 * Run the generate / add scripts afterwards to populate it.
 */
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory (created)', required: true },
  { name: 'name', desc: 'project name (default: directory name)' },
  { name: 'schematic', desc: 'schematic name (default Schematic1)' },
  { name: 'sheet', desc: 'initial sheet title (default P1)' },
  { name: 'pcb', desc: 'initial PCB title (default PCB1)' },
  { name: 'panel', desc: 'also create a panel document Panel1 (optional, default off)', hasValue: false },
  { name: 'board-w', desc: 'PCB board outline width in mil (default 4000)' },
  { name: 'board-h', desc: 'PCB board outline height in mil (default 3000)' }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('init.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const board = {};
  for (const [key, def] of [['board-w', 4000], ['board-h', 3000]]) {
    if (opts[key] !== undefined) {
      const v = Number(opts[key]);
      if (!Number.isFinite(v) || v <= 0) die(`bad --${key} "${opts[key]}" (want a positive number, mil)`);
      board[key] = v;
    } else {
      board[key] = def;
    }
  }
  const project = E.Project.create(opts.dir, opts.name);
  const schName = opts.schematic || 'Schematic1';
  const sheetTitle = opts.sheet || 'P1';
  const pcbName = opts.pcb || 'PCB1';

  const { sch, sheet } = project.ensureSheetDocument(schName, sheetTitle);
  const { pcb } = project.ensurePcbDocument(pcbName, {
    outline: E.rectPath(0, 0, board['board-w'], board['board-h'])
  });
  let panel = null;
  if (opts.panel) panel = project.ensurePanelDocument().panel;
  project.save();

  console.log(`created project ${project.indexFile}`);
  console.log(`  schematic ${sch.name} (${sch.uuid}), sheet ${sheet.title} (${sheet.uuid})`);
  console.log(`  pcb ${pcb.title} (${pcb.uuid}), board ${board['board-w']}x${board['board-h']} mil${panel ? `, panel ${panel.title}` : ''}`);
  console.log('next: node scripts/generate-symbol.js from-pins --dir ... ');
}

main();
