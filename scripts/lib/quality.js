'use strict';
/**
 * quality.js — how good does a schematic sheet look? One number.
 *
 * Absorbed from the reference implementation's quality model (report §7.2),
 * re-derived for our geometry:
 *
 *   score = normalizedArea            // how much blank space the drawing wastes
 *         + 1.2 · normalizedWire      // wire length, per edge, in "typical node" units
 *         + 0.8 · normalizedBends     // bends per edge
 *         + 12  · crossings / edges   // wires of DIFFERENT nets crossing
 *         + 6   · collinearOverlap/edges
 *         + 12  · throughNode / edges // wire passing through a symbol body
 *
 * Area carries a shape preference: a landscape drawing close to √2:1 is
 * cheapest; being too TALL is penalised ~10× harder than being too wide
 * (0.15 vs 1.5 coefficient), capped at 9× so real area still dominates.
 *
 * `valid` is false when two parts overlap — callers must reject such a layout
 * outright rather than trade it against a number.
 */
const G = require('./geom');

const TARGET_ASPECT = Math.SQRT2;

function effectiveArea(w, h) {
  if (!(w > 0 && h > 0)) return 0;
  const ratio = h / w;
  const tall = Math.max(0, TARGET_ASPECT * ratio - 1);
  const wide = Math.max(0, w / (TARGET_ASPECT * h) - 1);
  const penalty = 1.5 * tall * tall + 0.15 * wide * wide;
  return w * h * (1 + Math.min(9, penalty));
}

/** Merge collinear runs of one net so a shared trunk is counted once. */
function straightRuns(segs) {
  const h = new Map();   // y -> [x1,x2]
  const v = new Map();   // x -> [y1,y2]
  for (const s of segs) {
    if (Math.abs(s.y1 - s.y2) < G.EPS) {
      if (!h.has(s.y1)) h.set(s.y1, []);
      h.get(s.y1).push([Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)]);
    } else if (Math.abs(s.x1 - s.x2) < G.EPS) {
      if (!v.has(s.x1)) v.set(s.x1, []);
      v.get(s.x1).push([Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)]);
    }
  }
  const merge = (map) => {
    let total = 0;
    for (const list of map.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let cur = null;
      for (const iv of list) {
        if (!cur) { cur = iv.slice(); continue; }
        if (iv[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], iv[1]);
        else { total += cur[1] - cur[0]; cur = iv.slice(); }
      }
      if (cur) total += cur[1] - cur[0];
    }
    return total;
  };
  return merge(h) + merge(v);
}

function properCrossing(a, b) {
  // strictly interior intersection of one horizontal and one vertical segment:
  // that is a crossing the reader accepts (not a T junction)
  const horiz = Math.abs(a.y1 - a.y2) < G.EPS;
  const vert = Math.abs(b.x1 - b.x2) < G.EPS;
  if (!(horiz && vert)) return false;
  const y = a.y1;
  const x = b.x1;
  const inAx = x > Math.min(a.x1, a.x2) + G.EPS && x < Math.max(a.x1, a.x2) - G.EPS;
  const inBy = y > Math.min(b.y1, b.y2) + G.EPS && y < Math.max(b.y1, b.y2) - G.EPS;
  return inAx && inBy;
}

/**
 * @param {object} sheet {parts:[{extent}], wires:[{net,segs}], blocks:[{rect}]}
 */
function evaluate(sheet) {
  const parts = sheet.parts || [];
  const wires = sheet.wires || [];
  const blocks = sheet.blocks || [];

  // --- node overlap (hard invalid)
  let overlaps = 0;
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (G.rectsOverlap(G.expand(parts[i].extent, -4), G.expand(parts[j].extent, -4))) overlaps += 1;
    }
  }

  // --- occupied area (parts + wires + block frames)
  let bx1 = Infinity; let by1 = Infinity; let bx2 = -Infinity; let by2 = -Infinity;
  const acc = (r) => {
    bx1 = Math.min(bx1, r.x1); by1 = Math.min(by1, r.y1);
    bx2 = Math.max(bx2, r.x2); by2 = Math.max(by2, r.y2);
  };
  let partArea = 0;
  for (const p of parts) { acc(p.extent); partArea += (p.extent.x2 - p.extent.x1) * (p.extent.y2 - p.extent.y1); }
  for (const b of blocks) acc(b.rect);
  for (const w of wires) for (const s of w.segs) acc({ x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2), x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) });
  if (!Number.isFinite(bx1)) { bx1 = 0; by1 = 0; bx2 = 1; by2 = 1; }
  const w = bx2 - bx1;
  const h = by2 - by1;

  // --- wire metrics
  const edges = wires.length;
  const typical = Math.sqrt(Math.max(1, partArea) / Math.max(1, parts.length));
  let wireLen = 0;
  let bends = 0;
  let through = 0;
  const segs = [];
  for (const wire of wires) {
    wireLen += straightRuns(wire.segs);
    const all = wire.segs;
    for (let i = 1; i < all.length; i += 1) {
      const p = all[i - 1]; const q = all[i];
      const share = Math.abs(p.x2 - q.x1) < G.EPS && Math.abs(p.y2 - q.y1) < G.EPS;
      const hPrev = Math.abs(p.y1 - p.y2) < G.EPS;
      const hNext = Math.abs(q.y1 - q.y2) < G.EPS;
      if (share && hPrev !== hNext) bends += 1;
    }
    for (const s of all) segs.push({ net: wire.net, s });
  }
  // through-node: a segment middle strictly inside a part BODY (the symbol's
  // own BBOX, not the extent — the extent includes pins, and a wire must reach
  // its own pin); falls back to the extent when no body is given
  for (const sg of segs) {
    for (const p of parts) {
      const body = G.expand(p.body || p.extent, -4);
      for (const t of [0.25, 0.5, 0.75]) {
        const pt = { x: sg.s.x1 + (sg.s.x2 - sg.s.x1) * t, y: sg.s.y1 + (sg.s.y2 - sg.s.y1) * t };
        if (G.rectContains(body, pt)) { through += 1; break; }
      }
    }
  }
  // crossings between DIFFERENT nets
  let crossings = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].net === segs[j].net) continue;
      if (properCrossing(segs[i].s, segs[j].s) || properCrossing(segs[j].s, segs[i].s)) crossings += 1;
    }
  }
  // collinear overlap between different nets (wires lying on top of each other)
  let collinear = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].net === segs[j].net) continue;
      const a = segs[i].s; const b = segs[j].s;
      const ah = Math.abs(a.y1 - a.y2) < G.EPS;
      const bh = Math.abs(b.y1 - b.y2) < G.EPS;
      if (ah !== bh) continue;
      if (ah) {
        if (Math.abs(a.y1 - b.y1) > G.EPS) continue;
        const lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
        const hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
        if (hi - lo > 1) collinear += 1;
      } else {
        if (Math.abs(a.x1 - b.x1) > G.EPS) continue;
        const lo = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
        const hi = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
        if (hi - lo > 1) collinear += 1;
      }
    }
  }

  const areaNorm = partArea > 0 ? effectiveArea(w, h) / partArea : 1;
  const wireNorm = edges ? wireLen / (edges * typical) : 0;
  const bendNorm = edges ? bends / edges : 0;
  const e = Math.max(1, edges);
  const score = areaNorm
    + 1.2 * wireNorm
    + 0.8 * bendNorm
    + 12 * (crossings / e)
    + 6 * (collinear / e)
    + 12 * (through / e);

  return {
    valid: overlaps === 0 && through === 0,
    score,
    parts: { overlaps, count: parts.length, area: partArea },
    box: { w, h, aspect: h > 0 ? w / h : 1 },
    wires: { edges, length: wireLen, bends, crossings, collinear, through, typical },
    areaNorm, wireNorm, bendNorm
  };
}

/** Candidate gate: accept only a clear, safe improvement over the baseline. */
function safelyImproves(candidate, baseline) {
  if (!candidate.valid) return false;
  if (candidate.parts.count !== baseline.parts.count) return false;
  if (candidate.wires.edges !== baseline.wires.edges) return false;
  const noWorse = ['overlaps', 'through', 'crossings', 'collinear']
    .every((k) => candidate.wires[k] === undefined || candidate.wires[k] <= (baseline.wires[k] || 0));
  return noWorse && candidate.score < baseline.score * 0.985;
}

module.exports = { evaluate, safelyImproves, effectiveArea, straightRuns, TARGET_ASPECT };
