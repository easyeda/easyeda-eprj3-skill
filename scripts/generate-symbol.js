#!/usr/bin/env node
'use strict';
/**
 * generate-symbol.js — build a schematic SYMBOL doc and stage it as a TEMP
 * library entry: <project>/.tmp/library/symbol/<name>.json (kind "symbol").
 *
 * Check the preset templates first (load-library.js list) — stage a custom
 * symbol only when no preset fits. Entries named like a preset are rejected:
 * placement resolves presets first, so a shadowing name could never be used.
 *
 * Subcommand:
 *   from-pins --dir <project> --name <lib-name> [--designator R]
 *             [--description D] [--tags "a,b"] --pins "<spec>"
 *             [--pitch 10]
 *
 * Pin spec, ';'-separated — either ALL pins auto-layouted or ALL explicit:
 *   num:name              auto-layout (alternating left/right columns)
 *   num:name:x:y:rot      explicit position, rot 0 (left column) or 180
 *                         (right column); hotspot at (x,y), pin points toward
 *                         the body
 *
 * Auto-layout mirrors the official example's geometry: pin hotspots at x=±20,
 * length 10, vertical pitch --pitch (default 10). The body rect and BBOX are
 * always derived from the pin geometry: each pin's inner end (hotspot +
 * length toward the body) defines that side's edge, plus pitch/2 margin on
 * top/bottom.
 */
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'name', desc: 'library entry name (must not shadow a preset)', required: true },
  { name: 'designator', desc: 'designator prefix, e.g. R -> R?' },
  { name: 'description', desc: 'symbol description' },
  { name: 'tags', desc: 'comma-separated tags' },
  { name: 'pins', desc: 'pin spec: all "num:name" or all "num:name:x:y:rot"', required: true },
  { name: 'pitch', desc: 'vertical pin pitch in mil (default 10)' }
];

function parsePins(spec) {
  return spec.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = s.split(':').map((x) => x.trim());
    if (p.length === 1 || p.length === 2) return { num: p[0], name: p[1] || p[0] };
    if (p.length === 5) {
      return { num: p[0], name: p[1] || p[0], x: Number(p[2]), y: Number(p[3]), rotation: Number(p[4]) };
    }
    return die(`bad pin spec "${s}" (want num:name or num:name:x:y:rotation)`);
  });
}

const PIN_LEN = 10;

// Either every pin carries an explicit position (rot 0/180 only — vertical
// columns have no real-client sample, so they are rejected) or none does and
// the official example's two-column layout is applied with `pitch`.
function layout(pins, pitch) {
  if (!pins.length) die('--pins is empty');
  const hasX = pins.filter((p) => p.x !== undefined);
  if (hasX.length && hasX.length !== pins.length) {
    die('pin spec mixes auto and explicit positions: give every pin "num:name:x:y:rot", or none');
  }
  if (hasX.length) {
    for (const p of pins) {
      if (![p.x, p.y, p.rotation].every(Number.isFinite)) die(`bad numeric pin "${p.num}:${p.name}:${p.x}:${p.y}:${p.rotation}"`);
      if (p.rotation !== 0 && p.rotation !== 180) {
        die(`explicit pin ${p.num} rotation ${p.rotation}: only 0 (left) or 180 (right) supported (matches the real-client symbols)`);
      }
      p.length = PIN_LEN;
    }
  } else {
    const left = [], right = [];
    pins.forEach((p, i) => (i % 2 === 0 ? left : right).push(p));
    for (const [list, x, rot] of [[left, -20, 0], [right, 20, 180]]) {
      list.forEach((p, i) => {
        p.x = x;
        p.rotation = rot;
        p.length = PIN_LEN;
        p.y = Math.round((i - (list.length - 1) / 2) * pitch * 100) / 100;
      });
    }
  }
  // Body edges sit at the inner ends of the pin columns (fallback ±10 when a
  // side has no pins); top/bottom get pitch/2 margin beyond the outer pins.
  const innerLeft = pins.filter((p) => p.rotation === 0).map((p) => p.x + p.length);
  const innerRight = pins.filter((p) => p.rotation === 180).map((p) => p.x - p.length);
  const dotX1 = innerLeft.length ? Math.max(...innerLeft) : -10;
  const dotX2 = innerRight.length ? Math.min(...innerRight) : 10;
  const ys = pins.map((p) => p.y);
  const dotY1 = Math.min(...ys) - pitch / 2;
  const dotY2 = Math.max(...ys) + pitch / 2;
  return { dotX1, dotY1, dotX2, dotY2 };
}

// The page-level Symbol attr zIndex mirrors the symbol doc: Name z, Designator
// z+1, Symbol z+2. Read the real values back from the generated doc.
function readPlacement(lines) {
  let nameZ, designatorZ;
  for (const l of lines) {
    const r = E.parseRecord(l);
    if (r && r.type === 'ATTR' && r.body && r.body.parentId === '') {
      if (r.body.key === 'Name') nameZ = r.body.zIndex;
      if (r.body.key === 'Designator') designatorZ = r.body.zIndex;
    }
  }
  if (designatorZ === undefined) die('generated symbol doc has no Designator attr');
  return { nameZ, designatorZ, symbolZ: designatorZ + 1 };
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('generate-symbol.js from-pins [options]', SCHEMA,
      'Generate a schematic symbol and stage it as <project>/.tmp/library/symbol/<name>.json.');
    return;
  }
  if (cmd !== 'from-pins') die(`unknown subcommand "${cmd}" (want: from-pins)`);
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  const pitch = opts.pitch !== undefined ? Number(opts.pitch) : 10;
  if (!Number.isFinite(pitch) || pitch <= 0) die(`bad --pitch "${opts.pitch}" (want a positive number, mil)`);
  const project = E.Project.load(opts.dir);
  if (project.presetHas(opts.name)) {
    die(`entry name "${opts.name}" shadows a preset template; pick another name (placement resolves presets first)`);
  }

  const pins = parsePins(opts.pins);
  const body = layout(pins, pitch);
  const title = opts.name;
  const designator = opts.designator ? `${opts.designator}?` : 'U?';
  const uuid = E.uuid16();
  const symbolDoc = E.buildSymbolDoc({
    uuid,
    client: project.client,
    title,
    description: opts.description || '',
    tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    ms: project.ms(),
    bbox: [body.dotX1, body.dotY1, body.dotX2, body.dotY2],
    graphics: [{
      type: 'RECT',
      body: {
        dotX1: body.dotX1, dotY1: body.dotY1, dotX2: body.dotX2, dotY2: body.dotY2,
        radiusX: 0, radiusY: 0, rotation: 0,
        strokeColor: null, strokeStyle: 'SOLID', fillColor: null,
        strokeWidth: 1, fillStyle: 'NONE'
      }
    }],
    pins,
    name: title,
    designator
  });

  project.saveLibrary({
    name: opts.name,
    kind: 'symbol',
    title,
    symbolUuid: uuid,
    designator,
    description: opts.description || '',
    symbolDoc,
    placement: readPlacement(symbolDoc)
  });
  console.log(`staged symbol "${opts.name}" (${symbolDoc.length} doc lines) -> .tmp/library/symbol/${opts.name}.json`);
  console.log(`next: node scripts/add-symbol.js --dir ${opts.dir} --sch <sch> --sheet <sheet> --symbol ${opts.name} [--footprint <fp>] --x <x> --y <y>`);
}

main();
