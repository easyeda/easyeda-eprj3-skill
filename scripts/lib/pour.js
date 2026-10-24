'use strict';
/**
 * pour.js — plan copper pours and stitching vias.
 *
 * A pour record only stores its REGION: the client recomputes the filled
 * copper when the file opens. So "auto pour" means deriving a sane region from
 * the board outline (inset by the edge clearance) and adding a via fence so the
 * top and bottom ground planes are actually stitched together.
 */

const G = require('./geom');

const DEFAULTS = {
  clearance: 12,
  layer: 1,
  stitchSpacing: 100,
  stitchInset: 40,
  viaDiameter: 24,
  viaDrill: 12,
  net: 'GND'
};

/** Board outline as a rectangle, from the design's board size or a poly. */
function boardRect(board) {
  if (board.points && board.points.length >= 3) {
    return G.bboxOfPoints(board.points);
  }
  return G.rect(0, 0, board.width || 4000, board.height || 3000);
}

/**
 * @param board  {width,height} or {points:[{x,y}]}
 * @param opts   {net, clearance, layers:[1,2], stitch:boolean, spacing}
 * @returns {pours:[{net,layer,path}], vias:[{net,x,y,width,hole}], notes:[]}
 */
function planPours(board, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const r = boardRect(board);
  const inset = o.clearance;
  const region = {
    x1: r.x1 + inset,
    y1: r.y1 + inset,
    x2: r.x2 - inset,
    y2: r.y2 - inset
  };
  const notes = [];
  if (region.x2 - region.x1 < 4 * o.stitchSpacing || region.y2 - region.y1 < 4 * o.stitchSpacing) {
    notes.push(`board ${r.x2 - r.x1}×${r.y2 - r.y1} mil is small — the pour region may be mostly void`);
  }
  const path = [E_rectPath(region.x1, region.y1, region.x2 - region.x1, region.y2 - region.y1)];
  const pours = [];
  const layers = o.layers || [o.layer];
  for (const layer of layers) {
    pours.push({ net: o.net, layer, path });
  }

  const vias = [];
  if (o.stitch) {
    const step = o.stitchSpacing;
    const sx1 = region.x1 + o.stitchInset;
    const sy1 = region.y1 + o.stitchInset;
    const sx2 = region.x2 - o.stitchInset;
    const sy2 = region.y2 - o.stitchInset;
    if (sx2 > sx1 && sy2 > sy1) {
      const put = (x, y) => vias.push({
        net: o.net, x: Math.round(x), y: Math.round(y),
        width: o.viaDiameter, hole: o.viaDrill
      });
      // via fence along the perimeter, one grid step in from the pour edge
      for (let x = sx1; x <= sx2; x += step) { put(x, sy1); put(x, sy2); }
      for (let y = sy1; y <= sy2; y += step) { put(sx1, y); put(sx2, y); }
      // and a coarse interior grid so the two planes are tied across the board
      const interior = step * 3;
      for (let x = sx1 + interior; x < sx2; x += interior) {
        for (let y = sy1 + interior; y < sy2; y += interior) put(x, y);
      }
    }
    // de-duplicate on the 10 mil grid
    const seen = new Set();
    const unique = [];
    for (const v of vias) {
      const k = `${v.x},${v.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(v);
    }
    vias.length = 0;
    vias.push(...unique);
  }
  return { pours, vias, region, notes };
}

function E_rectPath(x, y, w, h) {
  // mirrors epjr3.rectPath: anchor = min-x/max-y corner, height toward -y
  return ['R', x, y + h, w, h];
}

module.exports = { DEFAULTS, planPours, boardRect };
