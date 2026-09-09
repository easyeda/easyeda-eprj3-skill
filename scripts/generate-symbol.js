#!/usr/bin/env node
'use strict';
/**
 * generate-symbol.js — build a schematic SYMBOL doc and stage it under
 * <project>/library/<name>.json (kind "symbol").
 *
 * The staged entry is raw material: combine it with a footprint into a device
 * via load-library.js before placing it with add-symbol.js.
 *
 * Subcommand:
 *   from-pins --dir <project> --name <lib-name> [--title T] [--designator R]
 *             [--description D] [--tags "a,b"] --pins "<spec>"
 *
 * Pin spec, ';'-separated:
 *   num:name              auto-layout (alternating left/right columns)
 *   num:name:x:y:rot      explicit position in symbol units
 *
 * Auto-layout mirrors the official example's geometry: pin hotspots at x=±20,
 * length 10, vertical pitch 10, body rect [-10,-h/2,10,h/2].
 */
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'name', desc: 'library entry name', required: true },
  { name: 'title', desc: 'symbol title (default: entry name)' },
  { name: 'designator', desc: 'designator prefix, e.g. R -> R?' },
  { name: 'description', desc: 'symbol description' },
  { name: 'tags', desc: 'comma-separated tags' },
  { name: 'pins', desc: 'pin spec, see above', required: true }
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

// Alternate left/right columns; y stacked around 0 with a 10-unit pitch.
function autoLayout(pins) {
  const left = [], right = [];
  pins.forEach((p, i) => (i % 2 === 0 ? left : right).push(p));
  for (const [list, x, rot] of [[left, -20, 0], [right, 20, 180]]) {
    list.forEach((p, i) => {
      p.x = x;
      p.rotation = rot;
      p.length = 10;
      p.y = Math.round((i - (list.length - 1) / 2) * 10 * 100) / 100;
    });
  }
  const h = Math.max(left.length, right.length) * 10;
  return { h: h || 10 };
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
      'Generate a schematic symbol and stage it as <project>/library/<name>.json.');
    return;
  }
  if (cmd !== 'from-pins') die(`unknown subcommand "${cmd}" (want: from-pins)`);
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  const project = E.Project.load(opts.dir);

  const pins = parsePins(opts.pins);
  const { h } = autoLayout(pins);
  const title = opts.title || opts.name;
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
    bbox: [-10, -h / 2, 10, h / 2],
    graphics: [{
      type: 'RECT',
      body: {
        dotX1: -10, dotY1: -h / 2, dotX2: 10, dotY2: h / 2,
        radiusX: 0, radiusY: 0, rotation: 0,
        strokeColor: null, strokeStyle: 'SOLID', fillColor: null,
        strokeWidth: 1, fillStyle: 'NONE'
      }
    }],
    pins,
    name: title,
    designator
  });

  project.saveLibrary(opts.name, {
    name: opts.name,
    kind: 'symbol',
    symbolUuid: uuid,
    symbolTitle: title,
    designator,
    description: opts.description || '',
    symbolDoc,
    placement: readPlacement(symbolDoc)
  });
  console.log(`staged symbol "${opts.name}" (${symbolDoc.length} doc lines) -> library/${opts.name}.json`);
  console.log(`next: node scripts/load-library.js device --dir ${opts.dir} --symbol ${opts.name} [--footprint <fp>]`);
}

main();
