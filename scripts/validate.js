#!/usr/bin/env node
'use strict';
/**
 * validate.js — check an eprj3 folder project against the format invariants
 * derived from the official easyeda-pro-eprj3-format example:
 *
 *   - index JSON shape (folder format, 32-hex owner uuids, profile maps)
 *   - per-schematic container: 4-record .ecfg, .evar, sheet .esch2 files whose
 *     main doc (SCH_PAGE) uuid matches the index
 *   - sheet docs: every placed component's Device/Symbol attr must reference
 *     DEVICE/SYMBOL docs embedded in the same file
 *   - PCB docs: preamble with layers + empty NET + board outline; components'
 *     Device/Footprint links; PAD_NET ↔ NET/COMPONENT references
 *   - panel present; per-doc ticket uniqueness; doc uuid uniqueness
 *
 *   node scripts/validate.js --dir <project>
 *
 * Exit code 0 = clean, 1 = errors found (printed).
 */
const fs = require('fs');
const path = require('path');
const E = require('./lib/eprj3');
const { parseArgs, printHelp } = require('./lib/utils');

const errors = [];
const warnings = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
const warn = (cond, msg) => { if (!cond) warnings.push(msg); };
const hex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Split a container file into docs: [{docType, uuid, lines}].
function docsOf(file) {
  const lines = E.readLines(file);
  const docs = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('{"type":"DOCHEAD"}')) {
      const r = E.parseRecord(l);
      cur = { docType: r && r.body && r.body.docType, uuid: r && r.body && r.body.uuid, lines: [l] };
      docs.push(cur);
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  return docs;
}

function checkTicketsAndRecords(doc, label) {
  const seen = new Set();
  for (const l of doc.lines.slice(1)) {
    const r = E.parseRecord(l);
    check(r, `${label}: unparseable record ${l.slice(0, 60)}...`);
    if (!r) continue;
    if (typeof r.ticket === 'number') {
      check(!seen.has(r.ticket), `${label}: duplicate ticket ${r.ticket} (${r.type})`);
      seen.add(r.ticket);
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('validate.js [options]', [
      { name: 'dir', desc: 'project directory', required: true }
    ]);
    return;
  }
  const { opts } = parseArgs(argv, [
    { name: 'dir', desc: 'project directory', required: true }
  ]);
  const dir = opts.dir;

  // ---------------------------------------------------------------- index
  const idxFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.eprj3')) : [];
  check(idxFiles.length === 1, `exactly one .eprj3 index expected in ${dir}, found: ${idxFiles.join(', ') || 'none'}`);
  if (idxFiles.length !== 1) return report();
  const indexFile = path.join(dir, idxFiles[0]);
  let index = null;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch (e) {
    errors.push(`index not valid JSON: ${e.message}`);
    return report();
  }
  check(index.format === 'folder', 'index format must be "folder"');
  check(hex(index.owner_uuid, 32) && hex(index.creator_uuid, 32) && hex(index.modifier_uuid, 32),
    'owner/creator/modifier uuid must be 32-hex');
  check(typeof index.created_at === 'string' && typeof index.updated_at === 'string',
    'created_at/updated_at must be strings');
  check(isObj(index.profile), 'index.profile missing');
  if (!isObj(index.profile)) return report();
  const profile = index.profile;
  for (const k of ['boards', 'schematics', 'sheets', 'pcbs', 'panels', 'blockSymbols', 'simSchematics', 'simulations']) {
    check(isObj(profile[k]), `index.profile.${k} must be an object`);
  }
  check(isObj(profile.owner) && hex(profile.owner.uuid, 32), 'profile.owner.uuid must be 32-hex');
  if (!isObj(profile.boards) || !isObj(profile.schematics) || !isObj(profile.sheets)
    || !isObj(profile.pcbs)) return report();

  // -------------------------------------------------------------- schematic
  const schDirOf = (sch) => path.join(dir, 'sch', sch.name);
  for (const sch of Object.values(profile.schematics)) {
    check(hex(sch.uuid, 16) && !!sch.name, `bad schematic entry: ${JSON.stringify(sch)}`);
    check(profile.boards[sch.board], `schematic ${sch.name}: board ${sch.board} not in profile.boards`);
    const d = schDirOf(sch);
    check(fs.existsSync(d), `missing schematic dir ${d}`);
    const ecfg = path.join(d, `${sch.name}.ecfg`);
    if (fs.existsSync(ecfg)) {
      const docs = docsOf(ecfg);
      check(docs.length === 1 && docs[0].docType === 'SCH' && docs[0].uuid === sch.uuid,
        `${ecfg}: want a single SCH doc with uuid ${sch.uuid}`);
      check(fs.readFileSync(ecfg, 'utf8').trim().split('\n').length === 4,
        `${ecfg}: want 4 records (DOCHEAD META RULE RULE)`);
      if (docs.length === 1) checkTicketsAndRecords(docs[0], path.basename(ecfg));
    } else {
      errors.push(`missing ${ecfg}`);
    }
    warn(fs.existsSync(path.join(d, `${sch.name}.evar`)), `${sch.name}.evar missing (variant data)`);
  }

  // ----------------------------------------------------------------- sheets
  for (const sheet of Object.values(profile.sheets)) {
    const sch = profile.schematics[sheet.schematic_uuid];
    check(sch, `sheet ${sheet.title}: schematic_uuid ${sheet.schematic_uuid} not in profile`);
    if (!sch) continue;
    const file = path.join(schDirOf(sch), `${sheet.title}.esch2`);
    if (!fs.existsSync(file)) { errors.push(`missing sheet document ${file}`); continue; }
    const docs = docsOf(file);
    check(docs.length >= 3, `${file}: want >= 3 docs (frame symbol, device, page), got ${docs.length}`);
    const uuids = new Set();
    for (const d of docs) {
      check(d.uuid && !uuids.has(d.uuid), `${file}: duplicate/missing doc uuid ${d.uuid}`);
      uuids.add(d.uuid);
      checkTicketsAndRecords(d, `${path.basename(file)}[${d.docType}]`);
    }
    const main = docs[docs.length - 1];
    check(main.docType === 'SCH_PAGE' && main.uuid === sheet.uuid,
      `${file}: last doc must be SCH_PAGE with uuid ${sheet.uuid}, got ${main.docType} ${main.uuid}`);
    const symUuids = new Set(docs.filter((d) => d.docType === 'SYMBOL').map((d) => d.uuid));
    const devUuids = new Set(docs.filter((d) => d.docType === 'DEVICE').map((d) => d.uuid));
    const wireIds = new Set(main.lines.slice(1)
      .map((l) => E.parseRecord(l))
      .filter((r) => r && r.type === 'WIRE' && r.id)
      .map((r) => r.id));
    for (const l of main.lines.slice(1)) {
      const r = E.parseRecord(l);
      if (!r) continue;
      if (r.type === 'COMPONENT' && r.body) {
        const dn = r.body.attrs && r.body.attrs.DeviceName;
        if (dn) {
          const parsed = JSON.parse(dn);
          check(devUuids.has(parsed.uuid), `${file}: component ${r.id} DeviceName uuid ${parsed.uuid} has no DEVICE doc`);
        }
      }
      if (r.type === 'ATTR' && r.body && r.body.key === 'Symbol' && r.body.parentId) {
        check(symUuids.has(r.body.value), `${file}: Symbol attr references missing SYMBOL doc ${r.body.value}`);
      }
      if (r.type === 'ATTR' && r.body && r.body.key === 'Device' && r.body.parentId) {
        check(devUuids.has(r.body.value), `${file}: Device attr references missing DEVICE doc ${r.body.value}`);
      }
      if (r.type === 'LINE' && r.body && r.body.lineGroup) {
        check(wireIds.has(r.body.lineGroup), `${file}: LINE references missing WIRE ${r.body.lineGroup}`);
      }
    }
    // NET attrs are optional on wires — client-generated unnamed wires omit
    // them entirely, and empty wire shells (no LINE) are legal too. The
    // lineGroup back-reference check above catches real linkage corruption.
  }

  // -------------------------------------------------------------------- PCB
  for (const pcb of Object.values(profile.pcbs)) {
    check(profile.boards[pcb.board], `pcb ${pcb.title}: board ${pcb.board} not in profile.boards`);
    const file = path.join(dir, 'pcb', `${pcb.title}.epcb2`);
    if (!fs.existsSync(file)) { errors.push(`missing PCB document ${file}`); continue; }
    const docs = docsOf(file);
    const uuids = new Set();
    for (const d of docs) {
      check(d.uuid && !uuids.has(d.uuid), `${file}: duplicate/missing doc uuid ${d.uuid}`);
      uuids.add(d.uuid);
      checkTicketsAndRecords(d, `${path.basename(file)}[${d.docType}]`);
    }
    const main = docs[docs.length - 1];
    check(main.docType === 'PCB' && main.uuid === pcb.uuid,
      `${file}: last doc must be PCB with uuid ${pcb.uuid}, got ${main.docType} ${main.uuid}`);
    const mainRecords = main.lines.slice(1).map(E.parseRecord).filter(Boolean);
    check(mainRecords.some((r) => r.type === 'NET' && r.id === '["NET",""]'),
      `${file}: main doc lacks the empty NET record`);
    check(mainRecords.some((r) => r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE'),
      `${file}: main doc lacks the BOARD_OUTLINE poly`);
    check(mainRecords.some((r) => r.type === 'LAYER'), `${file}: main doc lacks LAYER records`);
    const devUuids = new Set(docs.filter((d) => d.docType === 'DEVICE').map((d) => d.uuid));
    const fpUuids = new Set(docs.filter((d) => d.docType === 'FOOTPRINT').map((d) => d.uuid));
    const netNames = new Set(mainRecords
      .filter((r) => r.type === 'NET' && r.id && r.id !== '["NET",""]')
      .map((r) => { try { return JSON.parse(r.id)[1]; } catch { return null; } }));
    const compIds = new Set(mainRecords.filter((r) => r.type === 'COMPONENT').map((r) => r.id));
    for (const r of mainRecords) {
      if (r.type === 'COMPONENT' && r.body) {
        const dn = r.body.attrs && r.body.attrs.DeviceName;
        if (dn) {
          const parsed = JSON.parse(dn);
          check(devUuids.has(parsed.uuid), `${file}: component ${r.id} DeviceName uuid ${parsed.uuid} has no DEVICE doc`);
        }
      }
      if (r.type === 'ATTR' && r.body && r.body.key === 'Footprint' && r.body.parentId) {
        check(fpUuids.has(r.body.value), `${file}: Footprint attr references missing FOOTPRINT doc ${r.body.value}`);
      }
      if (r.type === 'PAD_NET' && r.body) {
        const parts = (() => { try { return JSON.parse(r.id); } catch { return null; } })();
        check(parts && parts[0] === 'PAD_NET' && compIds.has(parts[1]),
          `${file}: PAD_NET ${r.id} references missing COMPONENT ${parts && parts[1]}`);
        if (r.body.padNet) {
          check(netNames.has(r.body.padNet), `${file}: PAD_NET uses net "${r.body.padNet}" without a NET record`);
        }
      }
      if ((r.type === 'POUR' || r.type === 'VIA' || r.type === 'FILL') && r.body && r.body.netName) {
        check(netNames.has(r.body.netName),
          `${file}: ${r.type} ${r.id} uses net "${r.body.netName}" without a NET record`);
      }
      if ((r.type === 'POUR' || r.type === 'FILL' || r.type === 'REGION') && r.body) {
        check(Array.isArray(r.body.path) && r.body.path.length
          && r.body.path.every((p) => Array.isArray(p)),
          `${file}: ${r.type} ${r.id} path must be an array of polygon arrays`);
      }
    }
  }

  // ------------------------------------------------------------------ panel
  const panelDir = path.join(dir, 'panel');
  check(fs.existsSync(panelDir) && fs.readdirSync(panelDir).some((f) => f.endsWith('.epan2')),
    'missing panel/Panel1.epan2');

  // ------------------------------------------------------ extra file warning
  for (const sch of Object.values(profile.schematics)) {
    const d = schDirOf(sch);
    if (!fs.existsSync(d)) continue;
    const known = new Set([`${sch.name}.ecfg`, `${sch.name}.evar`]);
    for (const sheet of Object.values(profile.sheets)) {
      if (sheet.schematic_uuid === sch.uuid) known.add(`${sheet.title}.esch2`);
    }
    for (const f of fs.readdirSync(d)) {
      warn(known.has(f), `${d}: unexpected file ${f}`);
    }
  }

  return report();
}

function report() {
  for (const w of warnings) console.log(`warn: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`OK (0 errors, ${warnings.length} warning(s))`);
}

main();
