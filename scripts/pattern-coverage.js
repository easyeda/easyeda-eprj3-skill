#!/usr/bin/env node
'use strict';
/**
 * pattern-coverage.js — measure how much of a design the pattern catalog covers.
 *
 *   node scripts/pattern-coverage.js --design design.json
 *   node scripts/pattern-coverage.js --gen board.gen.js
 *
 * A block counts as COVERED when the catalog absorbs every member except at
 * most one: tryPatternsOn takes a whole subset (chain / bank / hub / crystal /
 * series+shunt / bridge), and a multi-rail block may need several passes. The
 * remainder after the last pass is what would fall back to the generic grid.
 *
 * Exit code: 0 always (reporting tool); prints "coverage: N/M = P%".
 * Add --fail-under <pct> to exit 1 when coverage is below the target (CI use).
 */
const path = require('path');
const D = require('./lib/design');
const PAT = require('./lib/sch-patterns');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const designFile = opt('design');
const genFile = opt('gen');
const failUnder = Number(opt('fail-under'));

if (!designFile && !genFile) {
  console.error('usage: pattern-coverage.js (--design <design.json> | --gen <board.gen.js>) [--fail-under <pct>]');
  process.exit(2);
}

let design;
try {
  if (genFile) {
    const A = require('./lib/authoring').createAuthoring();
    const abs = path.resolve(genFile);
    design = D.normalize(require(abs)(A), abs);
  } else {
    design = D.readDesign(path.resolve(designFile));
  }
} catch (e) {
  console.error(`cannot read design: ${e.message}`);
  process.exit(2);
}

const byId = new Map(design.parts.map((p) => [p.id, p]));

/**
 * A placement needs a symbol with pin GEOMETRY; the design only carries a pin
 * map. Synthesise a plausible symbol per pin count (two-pin parts vertical,
 * ICs with left/right columns) so the catalog's topology detectors — and the
 * layouts they run — can work without a project/library.
 */
const synthSym = (n) => {
  const bbox = { x1: -30, y1: -20, x2: 30, y2: 20 };
  if (n === 2) {
    return { bbox, pins: [
      { num: '1', x: 0, y: 20, length: 10, rotation: 270 },
      { num: '2', x: 0, y: -20, length: 10, rotation: 90 }
    ] };
  }
  const pins = [];
  for (let i = 0; i < n; i += 1) {
    const left = i % 2 === 0;
    const row = Math.floor(i / 2);
    pins.push({ num: String(i + 1), x: left ? -30 : 30, y: 10 - row * 20, length: 10, rotation: left ? 0 : 180 });
  }
  const half = Math.max(30, Math.ceil(n / 2) * 10);
  return { bbox: { x1: -half, y1: -half, x2: half, y2: half }, pins };
};
const asPlacements = (parts) => parts.map((p) => {
  const sym = synthSym(Object.keys(p.pins || {}).length);
  const pl = { part: p, sym, x: 0, y: 0, rotation: 0, sheet: 1 };
  pl.extent = D.partExtent(sym, 0, 0, 0);
  return pl;
});

/**
 * The catalog arranges PASSIVE groups (two-pin parts) around anchors. A part
 * that is a lone multi-pin symbol (an IC) or a single-pin item (mounting hole,
 * test point) has nothing to group: the generic grid is the correct place for
 * it, so it never counts against coverage.
 */
const pinCount = (pl) => Object.keys(pl.part.pins || {}).length;
const triviallyFine = (pl) => pinCount(pl) <= 1 || pinCount(pl) > 2;

// a design without explicit blocks is one implicit block
const blocks = (design.blocks && design.blocks.length)
  ? design.blocks
  : [{ title: '(implicit)', parts: design.parts.map((p) => p.id) }];

let covered = 0;
const gaps = [];
console.log(`design: ${design.name} — ${blocks.length} block(s), ${design.parts.length} part(s)\n`);

for (const b of blocks) {
  const members = asPlacements((b.parts || []).map((id) => byId.get(id)).filter(Boolean));
  const kind = members.length > 1 ? '' : ' (singleton)';
  if (members.length < 2) { covered += 1; console.log(`  ok   ${b.title}${kind}`); continue; }
  let rest = members.slice();
  const hits = [];
  for (let guard = 0; guard < 8 && rest.length >= 2; guard += 1) {
    const m = PAT.tryPatternsOn(design, rest);
    if (m) {
      hits.push(`${m.groups.length} group(s)`);
      const ids = new Set(m.memberIds);
      rest = rest.filter((pl) => !ids.has(pl.part.id));
      continue;
    }
    const hub = PAT.findHubSubset(rest);
    if (hub) {
      hits.push('hub');
      const ids = new Set(hub.memberIds);
      rest = rest.filter((pl) => !ids.has(pl.part.id));
      continue;
    }
    const banks = PAT.findSubBanks(design, rest);
    if (banks.length) {
      hits.push('bank');
      const ids = new Set(banks[0].members.map((pl) => pl.part.id));
      rest = rest.filter((pl) => !ids.has(pl.part.id));
      continue;
    }
    break;
  }
  if (hits.length && (rest.length <= 1 || rest.every(triviallyFine))) {
    covered += 1;
    const lone = rest.length ? ` (${rest.length} part(s) left to the grid)` : '';
    console.log(`  ok   ${b.title} — ${hits.join(' + ')}${lone}`);
  } else if (!hits.length && rest.length && rest.every(triviallyFine)) {
    covered += 1;
    console.log(`  ok   ${b.title} — symbols/holes only (grid)`);
  } else {
    gaps.push(b.title);
    const restIds = rest.map((pl) => pl.part.id).join(' ') || '(none)';
    console.log(`  gap  ${b.title} — ${hits.length ? `absorbed ${hits.join(' + ')}, ` : ''}generic grid: ${restIds}`);
  }
}

const pct = blocks.length ? (covered / blocks.length) * 100 : 100;
console.log(`\ncoverage: ${covered}/${blocks.length} = ${pct.toFixed(0)}%`);
if (gaps.length) console.log(`ungrouped blocks: ${gaps.join(' | ')}`);
if (Number.isFinite(failUnder) && pct < failUnder) {
  console.error(`coverage ${pct.toFixed(0)}% is below --fail-under ${failUnder}%`);
  process.exit(1);
}
