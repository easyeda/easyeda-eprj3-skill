'use strict';
/**
 * sch-tidy.js — connectivity-driven symbol rotation for readable schematics.
 *
 * The AI (or the recipe) supplies rough positions; this pass decides each
 * symbol's ROTATION from the actual net geometry, the way a human draws:
 *
 *   - 2-pin parts (R/C/D/LED) turn onto their connection axis — partners
 *     stacked vertically get a vertical resistor, partners side by side a
 *     horizontal one;
 *   - ICs rotate so the mass of their pin partners sits on the side where
 *     those pins actually are (objective: total Manhattan distance from every
 *     pin hotspot to the centroid of its net's other pins, minimized over
 *     0/90/180/270).
 *
 * Deterministic, pure, and cheap: it runs between the two layout passes in
 * build.js (layout → tidy rotations → re-layout → route). Explicit user
 * rotations (`parts[].rotation` in the design) are respected and never moved.
 */

const G = require('./geom');

/** Hotspot of `pin` on a part at (x,y) with rotation r (record point = hotspot). */
function hotspotAt(pin, x, y, r) {
  const p = G.rotate(pin.x, pin.y, r || 0);
  return { x: x + p.x, y: y + p.y };
}

/**
 * Decide better rotations. Mutates `placements` (pl.rotation) and the
 * underlying design parts (part.rotation) in place.
 * @returns {{rotated: string[], score: number}} rotated refdes list
 */
function tidyRotations(design, lib, placements) {
  if (!placements || !placements.length) return { rotated: [], score: 0 };

  // net → all hotspots (across the whole sheet set; cross-sheet partners are
  // far enough that they never dominate a local rotation choice)
  const netHotspots = new Map();
  for (const pl of placements) {
    for (const pin of pl.sym.pins) {
      const net = pl.part.pins[String(pin.num)];
      if (!net) continue;
      const h = G.pinTip(pin, pl.x, pl.y, pl.rotation || 0);
      if (!netHotspots.has(net)) netHotspots.set(net, []);
      netHotspots.get(net).push(h);
    }
  }

  const rotated = [];
  for (const pl of placements) {
    const part = pl.part;
    if (part.rotationExplicit) continue;              // the author chose it
    const routable = pl.sym.pins.filter((p) => part.pins[String(p.num)]);
    if (routable.length < 2) continue;                // nothing to orient
    // A two-pin part bridging a supply rail and ground is drawn VERTICALLY,
    // supply north (larger y, y-UP sheet) and ground south — regardless of
    // where its partners sit. Letting the centroid rule decide made stacked decoupling
    // caps turn to face each other, piling their power flags in the middle and
    // overlapping the GND symbols.
    if (pl.sym.pins.length === 2) {
      const [a, b] = pl.sym.pins;
      const na = part.pins[String(a.num)];
      const nb = part.pins[String(b.num)];
      const dirOf = (net) => (design.powers && design.powers[net]) || null;
      let upPin = null;
      let downPin = null;
      if (dirOf(na) === 'up' && dirOf(nb) === 'down') { upPin = a; downPin = b; }
      else if (dirOf(nb) === 'up' && dirOf(na) === 'down') { upPin = b; downPin = a; }
      if (upPin && downPin) {
        const yOf = (pin, r) => G.pinTip(pin, pl.x, pl.y, r).y;
        const cur = pl.rotation || 0;
        // sheet coordinates are y-UP: north = larger y
        if (yOf(upPin, cur) <= yOf(downPin, cur)) {
          let bestR = cur;
          let bestD = Infinity;
          for (const r of [0, 90, 180, 270]) {
            if (yOf(upPin, r) <= yOf(downPin, r)) continue;
            const d = Math.abs(((r - cur + 540) % 360) - 180);
            if (d < bestD) { bestD = d; bestR = r; }
          }
          if (bestD !== Infinity) {
            pl.rotation = bestR;
            part.rotation = bestR;
            rotated.push(part.id);
          }
        }
        continue;   // the power rule owns this part's orientation
      }
    }
    // candidate partner centroids per pin
    const targets = [];
    for (const pin of routable) {
      const net = part.pins[String(pin.num)];
      const all = (netHotspots.get(net) || []);
      const others = all.filter((h) => {
        // exclude THIS pin's own hotspot (identity by proximity)
        const mine = G.pinTip(pin, pl.x, pl.y, pl.rotation || 0);
        return Math.hypot(h.x - mine.x, h.y - mine.y) > 0.01;
      });
      if (!others.length) continue;
      const cx = others.reduce((n, h) => n + h.x, 0) / others.length;
      const cy = others.reduce((n, h) => n + h.y, 0) / others.length;
      targets.push({ pin, cx, cy });
    }
    if (targets.length < 2) continue;                 // single-sided part: no signal
    const scoreAt = (r) => targets.reduce((n, t) => {
      const h = hotspotAt(t.pin, pl.x, pl.y, r);
      return n + Math.abs(h.x - t.cx) + Math.abs(h.y - t.cy);
    }, 0);
    const base = scoreAt(pl.rotation || 0);
    let bestR = pl.rotation || 0;
    let bestScore = base;
    // A real IC reads with its pins on the left/right sides. Rotating it 90/270
    // turns every pin upward/downward, which is what the user sees as "the chip
    // is lying sideways" — so multi-pin symbols may only flip (0/180). Two-pin
    // parts (R/C/D/LED) are free to take any of the four orientations.
    const rots = pl.sym.pins.length > 4 ? [0, 180] : [0, 90, 180, 270];
    for (const r of rots) {
      const s = scoreAt(r) + (r === 0 ? 1 : 0);        // stability tie-break toward 0
      if (s < bestScore - 0.5) { bestScore = s; bestR = r; }
    }
    if (bestR !== (pl.rotation || 0)) {
      pl.rotation = bestR;
      part.rotation = bestR;
      part.rotationTidied = true;
      rotated.push(part.id);
    }
  }
  return { rotated, score: 0 };
}

/**
 * Second-pass rotation on the FINAL layout. tidyRotations runs before the
 * second placement pass, so a part can end up rotated for a position it no
 * longer occupies. This pass re-scores each 2-pin part at its actual spot:
 * a 90° turn is taken when it shortens the connection to the part's same-net
 * partners (≤8-pin nets; a ground web would dominate) and the rotated extent
 * still fits its module frame and does not overlap a neighbour.
 * Pattern macros run AFTER this pass and keep their own deliberate rotations.
 * @returns {string[]} rotated part ids
 */
function alignRotations(placements, blocks, design) {
  if (!placements || !placements.length) return [];
  const D = require('./design');
  const tipsOf = (pl) => pl.sym.pins.map((pin) => {
    const net = pl.part.pins[String(pin.num)];
    return net ? { net, pin } : null;
  }).filter(Boolean);
  const netPoints = new Map();  // sheet|net -> [{x,y}]
  for (const pl of placements) {
    for (const t of tipsOf(pl)) {
      const key = `${pl.sheet || 1}|${t.net}`;
      if (!netPoints.has(key)) netPoints.set(key, []);
      const p = G.rotate(t.pin.x, t.pin.y, pl.rotation || 0);
      netPoints.get(key).push({ x: pl.x + p.x, y: pl.y + p.y, id: pl.part.id, num: String(t.pin.num) });
    }
  }
  const frameOf = (pl) => {
    if (!blocks || !blocks.length) return null;
    const b = blocks.find((bl) => (bl.sheet || 1) === (pl.sheet || 1) && (bl.members || []).includes(pl.part.id));
    return b ? b.rect : null;
  };
  const scoreAt = (pl, rot) => {
    let sum = 0;
    for (const t of tipsOf(pl)) {
      const pts = netPoints.get(`${pl.sheet || 1}|${t.net}`) || [];
      if (pts.length > 8) continue;           // a supply/ground web: no signal
      const p = G.rotate(t.pin.x, t.pin.y, rot);
      const hx = pl.x + p.x; const hy = pl.y + p.y;
      for (const q of pts) {
        if (q.id === pl.part.id && q.num === String(t.pin.num)) continue;
        sum += Math.abs(q.x - hx) + Math.abs(q.y - hy);
      }
    }
    return sum;
  };
  const rotated = [];
  for (const pl of placements) {
    if (pl.part.rotationExplicit) continue;
    if (!pl.sym || pl.sym.pins.length !== 2) continue;
    if (tipsOf(pl).length !== 2) continue;
    // supply→ground two-pin parts keep the vertical rule from tidyRotations
    // (supply north, ground south); re-scoring toward partners would flip one
    // of a stacked pair and pile the two flags in the middle
    if (design && design.powers) {
      const dirs = tipsOf(pl).map((t) => design.powers[t.net]);
      if (dirs.includes('up') && dirs.includes('down')) continue;
    }
    const base = pl.rotation || 0;
    const cur = scoreAt(pl, base);
    let bestR = base;
    let best = cur;
    for (const r of [90, 270]) {
      const rr = (base + r) % 360;
      const ext = D.partExtent(pl.sym, pl.x, pl.y, rr);
      const frame = frameOf(pl);
      if (frame && !G.rectContainsRect(frame, ext)) continue;
      if (placements.some((o) => o !== pl && (o.sheet || 1) === (pl.sheet || 1)
        && o.extent && G.rectsOverlap(ext, o.extent))) continue;
      const v = scoreAt(pl, rr);
      if (v < best - 60) { best = v; bestR = rr; }
    }
    if (bestR !== base) {
      pl.rotation = bestR;
      pl.extent = D.partExtent(pl.sym, pl.x, pl.y, bestR);
      pl.part.rotation = bestR;
      pl.part.rotationTidied = true;
      rotated.push(pl.part.id);
    }
  }
  return rotated;
}

module.exports = { tidyRotations, alignRotations, hotspotAt };
