#!/usr/bin/env node
'use strict';
/**
 * validate.js — Check an eprj3 project for the most common format issues.
 *
 * Usage:
 *   node scripts/validate.js check --dir <projectDir> [--strict] [--fix]
 *
 * Checks:
 *   - <dir>/<name>.eprj3 exists and parses as JSON
 *   - Every schematic folder contains at least one .esch2 sheet
 *   - Every sheet file has a DOCHEAD record followed by a META record
 *   - Every WIRE record has at least one matching LINE record
 *   - Ticket numbers are monotonically increasing
 *   - Every COMPONENT parentId on ATTR matches an existing COMPONENT id
 *
 * With --fix the script will rewrite any auto-correctable problems in place.
 */
const fs = require('fs');
const path = require('path');
const { Project, readRecords, writeRecords } = require('./lib/eprj3');
const { parseArgs, printHelp } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'Project root' },
  { name: 'strict', hasValue: false, desc: 'Treat warnings as errors' },
  { name: 'fix', hasValue: false, desc: 'Attempt to auto-fix common issues' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp('validate.js check [options]', schema); process.exit(sub ? 0 : 1); }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'check') { console.error(`Unknown command: ${sub}`); process.exit(2); }

  const project = await Project.load(path.resolve(opts.dir));
  let problems = 0;
  let warnings = 0;

  // 1. schematics must have at least one sheet file
  for (const sch of Object.values(project.profile.profile.schematics)) {
    if (sch.name.startsWith('__')) continue;
    const dir = path.join(project.rootDir, 'sch', sch.name);
    if (!fs.existsSync(dir)) { console.error(`[ERR] missing schematic dir: ${dir}`); problems++; continue; }
    const sheets = Object.values(project.profile.profile.sheets).filter(s => s.schematic_uuid === sch.uuid);
    if (sheets.length === 0) { console.error(`[ERR] schematic ${sch.name} has no sheets`); problems++; continue; }
    for (const sheet of sheets) {
      const file = path.join(dir, `${sheet.title}.esch2`);
      if (!fs.existsSync(file)) { console.error(`[ERR] missing sheet file: ${file}`); problems++; continue; }
      const records = readRecords(file);
      const head = records.find(r => r.type === 'DOCHEAD');
      if (!head) { console.error(`[ERR] ${file}: missing DOCHEAD`); problems++; }
      const meta = records.find(r => r.type === 'META');
      if (!meta) { console.error(`[ERR] ${file}: missing META`); problems++; }

      // 2. tickets monotonic
      let prevTicket = 0;
      for (const r of records) {
        if (r.ticket <= prevTicket && r.ticket) {
          console.warn(`[WARN] ${file}: ticket ${r.ticket} not greater than previous ${prevTicket}`);
          warnings++;
        }
        prevTicket = r.ticket;
      }

      // 3. WIREs must have matching LINEs
      const wireIds = new Set(records.filter(r => r.type === 'WIRE').map(r => r.id));
      const lineGroups = new Set(records.filter(r => r.type === 'LINE').map(r => r.body.lineGroup).filter(Boolean));
      for (const wid of wireIds) if (!lineGroups.has(wid)) {
        console.warn(`[WARN] ${file}: WIRE ${wid} has no matching LINE segments`);
        warnings++;
        if (opts.fix) {
          // rewrite without that wire
          const filtered = records.filter(r => !(r.type === 'WIRE' && r.id === wid));
          writeRecords(file, filtered);
          console.log(`  fixed: removed orphan WIRE ${wid}`);
        }
      }

      // 4. ATTR.parentId matches a COMPONENT
      const compIds = new Set(records.filter(r => r.type === 'COMPONENT').map(r => r.id));
      for (const r of records) {
        if (r.type === 'ATTR' && r.body.parentId && !compIds.has(r.body.parentId) && !wireIds.has(r.body.parentId)) {
          console.warn(`[WARN] ${file}: ATTR ${r.id} parentId=${r.body.parentId} has no source component`);
          warnings++;
        }
      }
    }
  }

  // 5. PCB files
  for (const pcb of Object.values(project.profile.profile.pcbs)) {
    const file = path.join(project.rootDir, 'pcb', `${pcb.title}.epcb2`);
    if (!fs.existsSync(file)) { console.error(`[ERR] missing PCB file: ${file}`); problems++; continue; }
    const records = readRecords(file);
    if (!records.find(r => r.type === 'DOCHEAD')) { console.error(`[ERR] ${file}: missing DOCHEAD`); problems++; }
    if (!records.find(r => r.type === 'META')) { console.error(`[ERR] ${file}: missing META`); problems++; }
  }

  console.log(`\nResult: ${problems} errors, ${warnings} warnings`);
  if (problems > 0 || (opts.strict && warnings > 0)) process.exit(1);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });