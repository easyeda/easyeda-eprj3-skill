#!/usr/bin/env node
'use strict';
/**
 * floorplan.js — PCB placement preview / planner.
 *
 *   node scripts/floorplan.js --design <design.json> [--write] [--json]
 *
 * Runs the same placer `build.js` uses and prints the resulting `pcb.place`
 * map (ref, x, y, angle) plus the fitted board size — WITHOUT building.
 * `--write` injects the map back into the design file's `pcb.place`, so the
 * AI can review/adjust coordinates and then build with the placement pinned
 * (connectors on the board edge, decoupling next to their IC, everything
 * inside the outline).
 */
const fs = require('fs');
const path = require('path');
const D = require('./lib/design');
const P = require('./lib/parts');
const FA = require('./lib/fp-auto');
const { planPcb } = require('./lib/pcb-plan');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'design', desc: 'design.json file', required: true },
  { name: 'write', desc: 'write the placement map back into the design (pcb.place)', hasValue: false },
  { name: 'json', desc: 'machine-readable output', hasValue: false }
];

// minimal library shim — same resolution rules as build.js's makeLibrary
function makeLib() {
  const cache = new Map();
  const load = (dir, kind, name) => {
    const key = `${kind}/${name}`;
    if (!cache.has(key)) {
      const file = path.join(__dirname, '..', 'templates', 'library', kind, `${name}.json`);
      if (!fs.existsSync(file)) throw new Error(`no ${kind} preset "${name}"`);
      cache.set(key, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    return cache.get(key);
  };
  return {
    symbolOf(p) {
      const e = typeof p.symbol === 'string'
        ? load(p.id, 'symbol', p.symbol)
        : null;
      if (e) return Object.assign({ entry: e }, P.parseSymbolEntry(e));
      const spec = Object.assign({}, p.symbol, { name: `SYM_${p.symbol.name}` });
      const entry = P.buildInlineSymbolEntry(spec, { ownerUuid: 'floorplan', client: 'x', ms: 1 });
      return Object.assign({ entry }, P.parseSymbolEntry(entry));
    },
    footprintOf(p) {
      if (typeof p.footprint === 'string') {
        const e = load(p.id, 'footprint', p.footprint);
        return Object.assign({ entry: e }, P.parseFootprintEntry(e));
      }
      const expanded = p.footprint.auto ? FA.expandAuto(p.footprint) : p.footprint;
      const entry = P.buildInlineFootprintEntry(Object.assign({}, expanded, { name: `FP_${expanded.name || p.id}` }), { ownerUuid: 'floorplan', client: 'x', ms: 1 });
      return Object.assign({ entry }, P.parseFootprintEntry(entry));
    }
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('floorplan.js [options]', SCHEMA,
      'Preview the PCB placement (pcb.place map + fitted board) without building.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const design = D.readDesign(path.resolve(opts.design));
  if (design.skipPcb) throw new Error('design sets "pcb": false — nothing to place');
  // work on a copy so the declared board stays untouched during fitting
  // (JSON clone keeps the plain data but loses the powerNets Map — re-attach)
  const probe = JSON.parse(JSON.stringify(design));
  probe.powerNets = design.powerNets;
  const lib = makeLib();
  let plan = planPcb(probe, lib, null);
  const targetW = Math.max(design.boardDeclared ? design.board.width : 0, plan.required.width, 400);
  const targetH = Math.max(design.boardDeclared ? design.board.height : 0, plan.required.height, 300);
  probe.board.width = targetW;
  probe.board.height = targetH;
  plan = planPcb(probe, lib, null);

  const place = {};
  for (const pl of plan.placements) place[pl.part.id] = pl.pcbPos;

  if (opts.write) {
    design.pcbSpec.place = place;
    fs.writeFileSync(design.file, JSON.stringify(JSON.parse(JSON.stringify({
      name: design.name,
      board: { width: targetW, height: targetH },
      sheet: { schematic: design.schematic, name: design.sheet },
      powers: Object.fromEntries(design.powerNets),
      sheets: design.sheets > 1 ? design.sheets : undefined,
      blocks: design.blocks.map((b) => ({ title: b.title, desc: b.desc || undefined, sheet: b.sheet, parts: b.parts })),
      parts: design.parts.map((p) => ({
        id: p.id, symbol: p.symbol, footprint: p.footprint,
        value: p.value || undefined, name: p.name || undefined,
        pins: p.pins, polarity: p.polarity || undefined,
        role: p.role || undefined, rotation: p.rotationExplicit ? p.rotation : undefined
      })),
      expect: design.expect || undefined,
      pcb: { place, rules: design.pcbSpec.rules || undefined }
    })), null, 2) + '\n', 'utf8');
    console.log(`wrote pcb.place (${Object.keys(place).length} parts) + fitted board ${targetW}×${targetH} mil → ${design.file}`);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ board: { width: targetW, height: targetH }, place }, null, 2));
    return;
  }
  console.log(`board (fitted): ${targetW}×${targetH} mil — ${Object.keys(place).length} parts`);
  for (const [ref, [x, y, a]] of Object.entries(place)) {
    console.log(`  ${ref.padEnd(8)} [${x}, ${y}${a ? `, ${a}` : ''}]`);
  }
}

main();
