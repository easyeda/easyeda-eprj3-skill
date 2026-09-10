#!/usr/bin/env node
'use strict';
/**
 * cleanup.js — remove the project's temp staging area (<project>/.tmp/),
 * i.e. the library entries generated while authoring. Run it as the last
 * step of the generation flow, after validate passes. Preset templates
 * under templates/library/ ship with the skill and are never touched.
 *
 *   cleanup --dir <project>
 */
const fs = require('fs');
const path = require('path');
const E = require('./lib/eprj3');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true }
];

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('cleanup.js [options]', SCHEMA);
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const project = E.Project.load(path.resolve(opts.dir));
  const tmp = path.join(project.rootDir, '.tmp');
  if (!fs.existsSync(tmp)) return; // nothing staged — silent success
  let count = 0;
  for (const sub of ['symbol', 'footprint']) {
    const d = path.join(tmp, 'library', sub);
    if (fs.existsSync(d)) {
      count += fs.readdirSync(d).filter((f) => f.endsWith('.json')).length;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`removed ${tmp} (${count} temp library entries)`);
}

main();
