'use strict';
/**
 * pcb-plan.js — place footprints on the board.
 *
 * Placement follows the schematic's block order (the same signal flow), so the
 * physical layout reads like the schematic. An explicit `pcb.place` map always
 * wins: { "R1": [x, y, angle] }. Everything stays inside the board outline with
 * a part-to-edge margin.
 */

const G = require('./geom');

const EDGE = 150;      // mil from board edge to the nearest part origin
const GAP_X = 260;     // mil between neighbouring parts (pad edge to pad edge)
const GAP_Y = 260;     // mil between rows

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

  const out = [];
  let cursorX = EDGE;
  let cursorY = EDGE;
  let rowH = 0;
  const boardW = design.board.width;
  let neededW = 0;
  let neededH = 0;

  for (const part of order) {
    if (explicit[part.id]) {
      const [x, y, a] = explicit[part.id];
      out.push({ part, pcbPos: [Number(x), Number(y), Number(a || 0)] });
      neededW = Math.max(neededW, Number(x) + EDGE);
      neededH = Math.max(neededH, Number(y) + EDGE);
      continue;
    }
    const fp = lib.footprintOf(part);
    if (!fp) continue;
    const angle = part.pcbAngle || 0;
    const ext = footprintExtent(fp, angle);
    const w = ext.x2 - ext.x1;
    const h = ext.y2 - ext.y1;

    // centre the part on its grid cell
    let x = cursorX - ext.x1;
    let y = cursorY - ext.y1;
    if (x + w > Math.max(boardW, neededW) - EDGE) {
      cursorX = EDGE;
      cursorY += rowH + GAP_Y;
      rowH = 0;
      x = cursorX - ext.x1;
      y = cursorY - ext.y1;
    }
    out.push({ part, pcbPos: [G.round(x), G.round(y), angle] });
    cursorX += w + GAP_X;
    rowH = Math.max(rowH, h);
    neededW = Math.max(neededW, x + w + EDGE);
    neededH = Math.max(neededH, cursorY + h + EDGE);
  }
  return {
    placements: out,
    required: { width: Math.ceil(neededW), height: Math.ceil(neededH) }
  };
}

module.exports = { planPcb, footprintExtent, EDGE, GAP_X, GAP_Y };
