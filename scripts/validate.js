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
 *   - Every sheet/PCB file has a DOCHEAD record followed by a META record
 *   - Ticket numbers are monotonically increasing
 *   - Every WIRE record has at least one matching LINE record
 *   - No duplicate LINE segments within one wire
 *   - Every ATTR parentId matches an existing COMPONENT id (schematic and PCB)
 *   - COMPONENT DeviceName/FootprintName uuid matches the embedded
 *     __symbols__/__footprints__ doc's DOCHEAD uuid (when that doc exists)
 *
 * With --fix the script rewrites auto-correctable problems in place
 * (orphan WIRE records, duplicate LINE segments).
 */
const fs = require('fs');
const path = require('path');
const { Project, readRecords, writeRecords, readDocHeadUuid } = require('./lib/eprj3');
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
  const warn = msg => { console.warn(`[WARN] ${msg}`); warnings++; };
  const err = msg => { console.error(`[ERR] ${msg}`); problems++; };

  // Scans one document's records; returns drop-predicates for --fix.
  function checkDoc(file, records, kind) {
    const drops = [];
    if (!records.find(r => r.type === 'DOCHEAD')) err(`${file}: missing DOCHEAD`);
    if (!records.find(r => r.type === 'META')) err(`${file}: missing META`);

    // 1. tickets monotonic
    let prevTicket = 0;
    for (const r of records) {
      if (r.ticket && r.ticket <= prevTicket) warn(`${file}: ticket ${r.ticket} not greater than previous ${prevTicket}`);
      if (r.ticket) prevTicket = r.ticket;
    }

    // 2. WIRE group containers must have LINE segments; no duplicate segments
    const wireIds = new Set(records.filter(r => r.type === 'WIRE').map(r => r.id));
    const lineRecs = records.filter(r => r.type === 'LINE');
    for (const wid of wireIds) {
      if (!lineRecs.some(l => l.body.lineGroup === wid)) {
        warn(`${file}: WIRE ${wid} has no matching LINE segments`);
        if (opts.fix) drops.push(r => r.type === 'WIRE' && r.id === wid);
      }
    }
    const seenSeg = new Set();
    for (const l of lineRecs) {
      const key = `${l.body.lineGroup}|${l.body.startX},${l.body.startY}->${l.body.endX},${l.body.endY}`;
      if (seenSeg.has(key)) {
        warn(`${file}: duplicate LINE segment in wire ${l.body.lineGroup} (${l.body.startX},${l.body.startY} -> ${l.body.endX},${l.body.endY})`);
        if (opts.fix) drops.push(r => r === l);
      } else {
        seenSeg.add(key);
      }
    }

    // 3. ATTR.parentId must match a COMPONENT id
    const compIds = new Set(records.filter(r => r.type === 'COMPONENT').map(r => r.id));
    for (const r of records) {
      if (r.type === 'ATTR' && r.body.parentId && !compIds.has(r.body.parentId) && !wireIds.has(r.body.parentId)) {
        warn(`${file}: ATTR ${r.id} parentId=${r.body.parentId} has no source component`);
      }
    }

    // 4. DeviceName/FootprintName uuid vs embedded doc DOCHEAD uuid
    const checks = kind === 'pcb'
      ? [['DeviceName', '__footprints__']]
      : [['DeviceName', '__symbols__'], ['FootprintName', '__footprints__']];
    for (const r of records) {
      if (r.type !== 'COMPONENT') continue;
      const attrs = r.body.attrs || {};
      for (const [attrKey, subDir] of checks) {
        const raw = attrs[attrKey];
        if (!raw) continue;
        let meta;
        try { meta = JSON.parse(raw); } catch { continue; }
        if (!meta || !meta.name || !meta.uuid) continue;
        const docFile = path.join(project.rootDir, 'sch', subDir, `${meta.name}.esch2`);
        if (!fs.existsSync(docFile)) continue; // defined externally (e.g. converter import) — nothing to compare
        const docUuid = readDocHeadUuid(docFile);
        if (docUuid && docUuid !== meta.uuid) {
          warn(`${file}: COMPONENT ${r.id} ${attrKey}.uuid ${meta.uuid} does not match ${subDir}/${meta.name}.esch2 DOCHEAD uuid ${docUuid}`);
        }
      }
    }
    return drops;
  }

  // Schematic sheets
  for (const sch of Object.values(project.profile.profile.schematics)) {
    if (sch.name.startsWith('__')) continue;
    const dir = path.join(project.rootDir, 'sch', sch.name);
    if (!fs.existsSync(dir)) { err(`missing schematic dir: ${dir}`); continue; }
    const sheets = Object.values(project.profile.profile.sheets).filter(s => s.schematic_uuid === sch.uuid);
    if (sheets.length === 0) { err(`schematic ${sch.name} has no sheets`); continue; }
    for (const sheet of sheets) {
      const file = path.join(dir, `${sheet.title}.esch2`);
      if (!fs.existsSync(file)) { err(`missing sheet file: ${file}`); continue; }
      const records = readRecords(file);
      const drops = checkDoc(file, records, 'sch');
      if (drops.length) {
        writeRecords(file, records.filter(r => !drops.some(d => d(r))));
        console.log(`  fixed: rewrote ${file} (${drops.length} record(s) removed)`);
      }
    }
  }

  // PCB documents
  for (const pcb of Object.values(project.profile.profile.pcbs)) {
    const file = path.join(project.rootDir, 'pcb', `${pcb.title}.epcb2`);
    if (!fs.existsSync(file)) { err(`missing PCB file: ${file}`); continue; }
    const records = readRecords(file);
    const drops = checkDoc(file, records, 'pcb');
    if (drops.length) {
      writeRecords(file, records.filter(r => !drops.some(d => d(r))));
      console.log(`  fixed: rewrote ${file} (${drops.length} record(s) removed)`);
    }
  }

  console.log(`\nResult: ${problems} errors, ${warnings} warnings`);
  if (problems > 0 || (opts.strict && warnings > 0)) process.exit(1);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
