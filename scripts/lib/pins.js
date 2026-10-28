'use strict';
/**
 * pins.js — resolve "R1.2" to an absolute connection point.
 *
 * This is the antidote to hand-computing pin coordinates. A sheet is read once,
 * every placed component is measured, and pin references become exact mil
 * coordinates that wires can attach to without guessing.
 */

const fs = require('fs');
const E = require('./eprj3');
const G = require('./geom');
const P = require('./parts');
const { docsOf } = require('./checks');

/** [{ref, x, y, rotation, symbolUuid, pins:[{num,name,x,y,dir}]}] for one sheet */
function sheetPins(file) {
  if (!fs.existsSync(file)) throw new Error(`sheet document missing: ${file}`);
  const docs = docsOf(file);
  // empty/truncated file → no main doc: report no pins instead of crashing
  const main = docs[docs.length - 1] || { docType: null, uuid: null, lines: [] };
  const symbolByUuid = new Map();
  for (const d of docs) {
    if (d.docType !== 'SYMBOL') continue;
    symbolByUuid.set(d.uuid, P.parseSymbolEntry({
      symbolDoc: d.lines.slice(1).map(E.parseRecord).filter(Boolean).map((r) => E.formatRecord(r.head, r.body))
    }));
  }
  const recs = main.lines.slice(1).map(E.parseRecord).filter(Boolean);
  const attrs = recs.filter((r) => r.type === 'ATTR' && r.body);
  const out = [];
  for (const r of recs) {
    if (r.type !== 'COMPONENT') continue;
    const b = r.body;
    const mine = attrs.filter((a) => a.body.parentId === r.id);
    const des = mine.find((a) => a.body.key === 'Designator');
    const symAttr = mine.find((a) => a.body.key === 'Symbol');
    const gn = mine.find((a) => a.body.key === 'Global Net Name');
    const sym = symAttr ? symbolByUuid.get(symAttr.body.value) : null;
    const ref = (des && des.body.value) || (gn ? `#${gn.body.value}` : '?');
    const entry = { ref, x: b.x, y: b.y, rotation: b.rotation || 0, power: gn ? gn.body.value : null, pins: [] };
    if (sym) {
      for (const pin of sym.pins) {
        const t = G.pinTip(pin, b.x, b.y, b.rotation || 0);
        entry.pins.push({
          num: String(pin.num),
          name: pin.name,
          x: t.x,
          y: t.y,
          dir: {
            x: Math.abs(t.x - b.x) >= Math.abs(t.y - b.y) ? (Math.sign(t.x - b.x) || 1) : 0,
            y: Math.abs(t.x - b.x) >= Math.abs(t.y - b.y) ? 0 : (Math.sign(t.y - b.y) || -1)
          }
        });
      }
    } else if (gn) {
      // power flags / ports connect at their origin
      entry.pins.push({ num: '1', name: gn.body.value, x: b.x, y: b.y, dir: { x: 0, y: 1 } });
    }
    out.push(entry);
  }
  return out;
}

/** "R1.2" → {x, y} ; throws with the list of valid refs/pins on failure. */
function resolvePin(components, ref) {
  const m = /^([^.#]+)\.(.+)$/.exec(String(ref).trim());
  if (!m) throw new Error(`bad pin reference "${ref}" (want PART.PIN, e.g. R1.2)`);
  const [, part, pin] = m;
  const comp = components.find((c) => c.ref === part || c.ref === `#${part}`);
  if (!comp) {
    const known = components.filter((c) => c.ref && c.ref !== '?').map((c) => c.ref).join(', ');
    throw new Error(`component "${part}" not found on this sheet (have: ${known})`);
  }
  const p = comp.pins.find((x) => x.num === String(pin) || x.name === String(pin));
  if (!p) {
    const known = comp.pins.map((x) => `${x.num}/${x.name}`).join(', ');
    throw new Error(`pin "${pin}" not on ${comp.ref} (have: ${known})`);
  }
  return { x: p.x, y: p.y, dir: p.dir, comp: comp.ref, pin: p.num, name: p.name };
}

/**
 * Orthogonal path between two resolved pins, leaving each pin along its
 * natural exit direction so the wire never starts inside a symbol.
 */
function routeBetween(a, b, opts) {
  const stub = (opts && opts.stub) || 40;
  const mode = (opts && opts.mode) || 'auto';
  const committed = (opts && opts.committed) || [];
  const pa = { x: a.x + (a.dir ? a.dir.x * stub : 0), y: a.y + (a.dir ? a.dir.y * stub : 0) };
  const pb = { x: b.x + (b.dir ? b.dir.x * stub : 0), y: b.y + (b.dir ? b.dir.y * stub : 0) };
  const build = (cornerMode) => {
    const segs = [];
    const push = (x1, y1, x2, y2) => {
      if (Math.abs(x1 - x2) < G.EPS && Math.abs(y1 - y2) < G.EPS) return;
      segs.push({ x1, y1, x2, y2 });
    };
    push(a.x, a.y, pa.x, pa.y);
    for (const s of G.orthoPath(pa, pb, cornerMode)) push(s.x1, s.y1, s.x2, s.y2);
    push(pb.x, pb.y, b.x, b.y);
    return segs;
  };
  // cross-net awareness: among the candidate corner modes pick the first that
  // never touches a wire of a DIFFERENT net — at tight layout density a blind
  // L-route T-merges into a neighbouring net. `committed` entries are
  // {seg, net}; same-net contacts are legitimate junctions.
  const modes = mode === 'auto' ? ['hv', 'vh'] : [mode];
  let fallback = null;
  for (const m of modes) {
    const segs = build(m);
    const clash = committed.some((c) => segs.some((s) => G.segsIntersect(s, c.seg, true)));
    if (!clash) return segs;
    if (!fallback) fallback = segs;
  }
  // every candidate touches something: emit the first anyway (a manual wire is
  // the author's call), but say so
  if (opts.warn) process.stderr.write(`  ! wire ${a.comp}.${a.pin} → ${b.comp}.${b.pin} touches existing wires of other nets — check the netlist\n`);
  return fallback || build(mode === 'auto' ? 'hv' : mode);
}

module.exports = { sheetPins, resolvePin, routeBetween };
