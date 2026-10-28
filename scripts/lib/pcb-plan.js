'use strict';
/**
 * pcb-plan.js — place footprints on the board.
 *
 * Placement follows the schematic's block order (the same signal flow), so the
 * physical layout reads like the schematic. Three deterministic refinements
 * make the result usable instead of merely packed:
 *
 *   1. connectors (refdes J…) go on the bottom board edge, in declaration
 *      order; a footprint whose pads form a single line is rotated so that
 *      line runs PARALLEL to the edge (headers along the edge, USB-C plug
 *      axis into the board).
 *   2. decoupling caps (C…) sit next to their IC (same schematic block, one
 *      pad on a ground net) instead of wherever the grid left them.
 *   3. gaps scale with the parts: a 0402 keeps 140 mil of breathing room, a
 *      large IC gets up to 260 — room to escape the pads by hand later.
 *
 * An explicit `pcb.place` map always wins: { "R1": [x, y, angle] }. Everything
 * stays inside the board outline with a part-to-edge margin.
 */

const G = require('./geom');

const EDGE = 150;      // mil from board edge to the nearest part extent
const GAP_MIN = 140;   // mil between neighbouring parts, small parts
const GAP_MAX = 260;   // mil between neighbouring parts, large parts

/** Gap that scales with the part: small parts never get 5× their own width of
 *  dead space, large parts never get less than the default escape room. */
function gapFor(size) {
  return Math.round(Math.max(GAP_MIN, Math.min(GAP_MAX, size)));
}

/**
 * Real copper extent of a footprint: body box AND every pad rectangle. A
 * footprint whose outline is tighter than its pads would otherwise be placed
 * too close to its neighbour and fail the clearance rule.
 */
function footprintExtent(fp, angle) {
  const pts = [];
  const b = fp.bbox;
  if (b) {
    for (const [x, y] of [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]]) {
      pts.push(G.rotate(x, y, angle || 0));
    }
  }
  for (const p of fp.pads || []) {
    const r = G.rotate(p.x, p.y, angle || 0);
    const hw = (p.w || 20) / 2;
    const hh = (p.h || 20) / 2;
    pts.push({ x: r.x - hw, y: r.y - hh }, { x: r.x + hw, y: r.y + hh });
  }
  if (!pts.length) return { x1: -20, y1: -20, x2: 20, y2: 20 };
  return G.bboxOfPoints(pts);
}

/** A footprint whose pads all share one x (a pin line) wants that line
 *  parallel to the board edge it sits on — rotate a vertical pad line by 90°.
 *  Two-column footprints (USB-C) keep rotation 0: their plug axis is the y
 *  axis, which is what must cross the edge. */
function connectorAngle(fp) {
  const pads = fp.pads || [];
  if (pads.length < 2) return 0;
  const xs = pads.map((p) => Number(p.x));
  const line = xs.every((x) => Math.abs(x - xs[0]) < 0.01);
  return line ? 90 : 0;
}

function overlapsAny(ext, placed, selfRef) {
  return placed.some((p) => p.ref !== selfRef && G.rectsOverlap(p.ext, ext));
}

/**
 * @param design  normalized design
 * @param lib     {footprintOf}
 * @param schematicPlacements  used only for ordering
 * @returns {{placements:[{part, pcbPos:[x,y,angle]}], required:{width,height}}}
 */
function planPcb(design, lib, schematicPlacements) {
  const explicit = (design.pcbSpec && design.pcbSpec.place) || {};
  const order = schematicPlacements && schematicPlacements.length
    ? schematicPlacements.map((p) => p.part)
    : design.parts;
  const groundNets = new Set([...(design.powerNets || [])]
    .filter(([, v]) => v === 'down').map(([n]) => n));

  // ---- pass 1: resolve every part's footprint and extent ------------------
  const items = [];
  for (const part of order) {
    if (explicit[part.id]) {
      const [x, y, a] = explicit[part.id];
      const fp = lib.footprintOf(part);
      const angle = Number(a || 0);
      const ext = fp ? G.translateBox(footprintExtent(fp, angle), Number(x), Number(y)) : null;
      items.push({ part, fp, explicit: true, x: Number(x), y: Number(y), angle, ext });
      continue;
    }
    const fp = lib.footprintOf(part);
    if (!fp) continue;
    items.push({ part, fp, explicit: false, angle: 0, ext: null });
  }

  // ---- pass 2: auto placement --------------------------------------------
  const connectors = items.filter((it) => !it.explicit && /^J/i.test(it.part.id));
  const rest = items.filter((it) => !it.explicit && !/^J/i.test(it.part.id));
  const placed = [];          // {ref, ext} for overlap/refinement checks
  for (const it of items) {
    if (it.explicit && it.ext) placed.push({ ref: it.part.id, ext: it.ext });
  }

  // connectors first: one row along the bottom edge
  let cursorX = EDGE;
  let connRowTop = 0;
  for (const it of connectors) {
    it.angle = connectorAngle(it.fp);
    it.ext = footprintExtent(it.fp, it.angle);
    const x = cursorX - it.ext.x1;
    const y = EDGE - it.ext.y1;             // extent bottom sits at EDGE
    it.x = G.round(x);
    it.y = G.round(y);
    placed.push({ ref: it.part.id, ext: G.translateBox(it.ext, it.x, it.y) });
    cursorX += (it.ext.x2 - it.ext.x1) + gapFor(it.ext.x2 - it.ext.x1);
    connRowTop = Math.max(connRowTop, it.ext.y2 - it.ext.y1);
  }

  // everything else grids in rows above the connector row — starting back at
  // the LEFT edge (cursorX currently sits where the connector row ended)
  cursorX = EDGE;
  let cursorY = EDGE + (connectors.length ? connRowTop + GAP_MAX : 0);
  let rowH = 0;
  let boardW = design.board.width;
  let neededW = 0;
  let neededH = 0;
  const gridStart = (it) => {
    const w = it.ext.x2 - it.ext.x1;
    const h = it.ext.y2 - it.ext.y1;
    // cursorX/cursorY track the CURRENT row's extent edges (left/bottom), so
    // the wrap test compares extent right edge against the usable width —
    // mixing in the part ORIGIN (as the old `x + w` form did) overstates the
    // right edge by |ext.x1| and wraps one part too many.
    const right = cursorX + w;
    if (cursorX > EDGE && right > Math.max(boardW, neededW) - EDGE) {
      cursorX = EDGE;
      cursorY += rowH + gapFor(rowH);
      rowH = 0;
    }
    it.x = G.round(cursorX - it.ext.x1);
    it.y = G.round(cursorY - it.ext.y1);
    placed.push({ ref: it.part.id, ext: G.translateBox(it.ext, it.x, it.y) });
    neededW = Math.max(neededW, right + EDGE);
    neededH = Math.max(neededH, cursorY + h + EDGE);
    cursorX = right + gapFor(w);
    rowH = Math.max(rowH, h);
  };

  // extents are needed before the grid walk — compute them in a first sweep
  for (const it of rest) it.ext = footprintExtent(it.fp, it.angle);
  for (const it of rest) gridStart(it);

  // ---- pass 3: decoupling caps next to their IC ---------------------------
  const isCap = (it) => /^C/i.test(it.part.id) && it.fp && it.fp.pads && it.fp.pads.length === 2
    && Object.values(it.part.pins).some((n) => groundNets.has(n));
  const moved = new Set();
  for (const ic of rest) {
    if (!/^U/i.test(ic.part.id)) continue;
    if (!ic.fp || !ic.fp.pads || ic.fp.pads.length < 4) continue;   // an IC, not a 2-3 pin part
    const cap = rest.find((c) => isCap(c) && !moved.has(c.part.id)
      && c.part.blockIndex !== undefined && c.part.blockIndex === ic.part.blockIndex);
    if (!cap) continue;
    // candidate spot: right of the IC, vertically centred on it
    const icBox = G.translateBox(ic.ext, ic.x, ic.y);
    const capW = cap.ext.x2 - cap.ext.x1;
    const capH = cap.ext.y2 - cap.ext.y1;
    const cx = icBox.x2 + gapFor(capW) - cap.ext.x1;
    const cy = ic.y + (ic.ext.y1 + ic.ext.y2) / 2 - cap.ext.y1 - capH / 2;
    const cand = G.rect(cx + cap.ext.x1, cy + cap.ext.y1, cx + cap.ext.x2, cy + cap.ext.y2);
    if (overlapsAny(cand, placed, cap.part.id)) continue;
    // commit: drop the cap's old grid cell from the overlap registry
    const old = placed.find((p) => p.ref === cap.part.id);
    if (old) { old.ext = cand; }
    cap.x = G.round(cx);
    cap.y = G.round(cy);
    moved.add(cap.part.id);
  }

  // ---- required board size from the FINAL extents -------------------------
  // (explicit placements included — a wide part at a hand-written [x,y] must
  // not stick past the outline the way the old x+EDGE heuristic allowed)
  for (const it of items) {
    if (!it.ext) continue;
    const box = G.translateBox(it.ext, it.x, it.y);
    neededW = Math.max(neededW, box.x2 + EDGE);
    neededH = Math.max(neededH, box.y2 + EDGE);
  }

  return {
    placements: items.map((it) => ({ part: it.part, pcbPos: [it.x, it.y, it.angle] })),
    required: { width: Math.ceil(neededW), height: Math.ceil(neededH) }
  };
}

module.exports = { planPcb, footprintExtent, EDGE, GAP_MIN, GAP_MAX };
