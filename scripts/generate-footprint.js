#!/usr/bin/env node
'use strict';
/**
 * generate-footprint.js — build a FOOTPRINT doc and stage it under
 * <project>/library/<name>.json (kind "footprint").
 *
 * Combine with a symbol into a device via load-library.js, then place it on
 * the PCB with add-footprint.js.
 *
 * Subcommand:
 *   from-pads --dir <project> --name <lib-name> [--title T] [--designator U?]
 *             [--description D] [--tags "a,b"] --pads "<spec>"
 *             [--outline "R,x,y,w,h"] [--silk "<spec>"]
 *
 * All coordinates are mil (footprint docs carry them as-is despite the mm
 * canvas unit — see the official example).
 *   pads   spec: ';'-separated num:x:y:w:h        (RECT pads on layer 1)
 *   outline spec: R,x,y,w,h                        (layer 48 component body)
 *   silk   spec: ';'-separated items:
 *                rect,x1,y1,x2,y2                  (closed rect outline)
 *                path,x1,y1,x2,y2[,x3,y3,...]      (open polyline)
 *                                                  (layer 3, width 6)
 */
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'name', desc: 'library entry name', required: true },
  { name: 'title', desc: 'footprint title (default: entry name)' },
  { name: 'designator', desc: 'designator prefix, e.g. R -> R?' },
  { name: 'description', desc: 'footprint description' },
  { name: 'tags', desc: 'comma-separated tags' },
  { name: 'pads', desc: 'pad spec num:x:y:w:h;... (mil)', required: true },
  { name: 'outline', desc: 'body outline R,x,y,w,h (mil, layer 48)' },
  { name: 'silk', desc: 'silk spec, see above (mil, layer 3)' }
];

function parsePads(spec) {
  return spec.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = s.split(':');
    if (p.length !== 5) return die(`bad pad spec "${s}" (want num:x:y:w:h)`);
    return {
      num: p[0].trim(),
      x: Number(p[1]), y: Number(p[2]),
      width: Number(p[3]), height: Number(p[4])
    };
  });
}

// POLY path encoding of the example: [x0,y0,"L",x1,y1,x2,y2,...].
function parseSilk(spec) {
  return spec.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const kind = s.split(',')[0].trim();
    if (kind === 'rect') {
      const pts = s.split(',').slice(1).map(Number);
      if (pts.length !== 4 || pts.some((v) => Number.isNaN(v))) die(`bad silk rect "${s}"`);
      const [x1, y1, x2, y2] = pts;
      return { path: [x1, y1, 'L', x2, y1, x2, y2, x1, y2, x1, y1] };
    }
    if (kind === 'path') {
      const pts = s.split(',').slice(1).map(Number);
      if (pts.length < 4 || pts.length % 2 || pts.some((v) => Number.isNaN(v))) {
        die(`bad silk path "${s}"`);
      }
      const path = [pts[0], pts[1], 'L'];
      for (let i = 2; i < pts.length; i += 2) path.push(pts[i], pts[i + 1]);
      return { path };
    }
    return die(`bad silk item "${s}" (want rect,... or path,...)`);
  });
}

function parseOutline(spec) {
  if (!spec) return undefined;
  const p = spec.split(',').map((v) => v.trim());
  if (p[0] !== 'R' || p.length !== 5) return die('outline must be R,x,y,w,h');
  return ['R', Number(p[1]), Number(p[2]), Number(p[3]), Number(p[4]), 0, 0];
}

// Footprint/Designator attr ids and zIndexes; the PCB component block reuses
// both (attr record id = compId + elem id, zIndex copied from the doc).
function readAttrMeta(lines) {
  const found = {};
  for (const l of lines) {
    const r = E.parseRecord(l);
    if (r && r.type === 'ATTR' && r.body && (r.body.key === 'Footprint' || r.body.key === 'Designator')) {
      found[r.body.key] = { id: r.id, zIndex: r.body.zIndex };
    }
  }
  if (!found.Footprint || !found.Designator) die('generated footprint doc lacks Footprint/Designator attrs');
  return found;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('generate-footprint.js from-pads [options]', SCHEMA,
      'Generate a footprint and stage it as <project>/library/<name>.json.');
    return;
  }
  if (cmd !== 'from-pads') die(`unknown subcommand "${cmd}" (want: from-pads)`);
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  const project = E.Project.load(opts.dir);

  const title = opts.title || opts.name;
  const designator = opts.designator ? `${opts.designator}?` : 'U?';
  const uuid = E.uuid16();
  const { lines, pads } = E.buildFootprintDoc({
    uuid,
    client: project.client,
    title,
    description: opts.description || '',
    tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    ms: project.ms(),
    outline: parseOutline(opts.outline),
    silks: opts.silk ? parseSilk(opts.silk) : [],
    pads: parsePads(opts.pads),
    designator
  });
  const attrMeta = readAttrMeta(lines);

  project.saveLibrary(opts.name, {
    name: opts.name,
    kind: 'footprint',
    footprintUuid: uuid,
    footprintTitle: title,
    designator,
    description: opts.description || '',
    footprintDoc: lines,
    footprintElems: {
      pads,
      attrFootprint: attrMeta.Footprint.id,
      attrDesignator: attrMeta.Designator.id
    },
    attrZ: { footprint: attrMeta.Footprint.zIndex, designator: attrMeta.Designator.zIndex }
  });
  console.log(`staged footprint "${opts.name}" (${lines.length} doc lines, ${pads.length} pads) -> library/${opts.name}.json`);
  console.log(`next: node scripts/load-library.js device --dir ${opts.dir} --symbol <sym> --footprint ${opts.name}`);
}

main();
