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
    for (const r of [0, 90, 180, 270]) {
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

module.exports = { tidyRotations, hotspotAt };
