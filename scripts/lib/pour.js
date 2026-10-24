'use strict';
/**
 * pour.js — plan copper pours and stitching vias.
 *
 * A pour record only stores its REGION: the client recomputes the filled
 * copper when the file opens. So "auto pour" means deriving a sane region from
 * the board outline (inset by the edge clearance) and adding a via fence so the
 * top and bottom ground planes are actually stitched together.
 *
 * Stitching vias are through-holes: they pierce every layer, so each one must
 * clear FOREIGN copper on all layers. Copper of the pour's own net is not an
 * obstacle — landing on it is the point (it joins the plane).
 */

const G = require('./geom');

const DEFAULTS = {
  clearance: 12,
  layer: 1,
  stitchSpacing: 100,
  stitchInset: 40,
  viaDiameter: 24,
  viaDrill: 12,
  net: 'GND',
  viaClearance: 10
};

/** Board outline as a rectangle, from the design's board size or a poly. */
function boardRect(board) {
  if (board.points && board.points.length >= 3) {
    return G.bboxOfPoints(board.points);
  }
  return G.rect(0, 0, board.width || 4000, board.height || 3000);
}

/**
 * Distance from (x,y) to the EDGE of an axis-aligned rect (0 when inside).
 * rect is {x, y, w, h} — a pad footprint.
 */
function rectEdgeDist(x, y, p) {
  const dx = Math.max(Math.abs(x - p.x) - (p.w || 20) / 2, 0);
  const dy = Math.max(Math.abs(y - p.y) - (p.h || 20) / 2, 0);
  return Math.hypot(dx, dy);
}

/**
 * Does a via at (x,y) violate clearance against foreign copper?
 * @returns null when clear, otherwise a short reason string for the notes.
 */
function viaConflict(x, y, viaR, clearance, obstacles, ownNet) {
  for (const p of obstacles.pads) {
    if (p.net === ownNet) continue;
    if (rectEdgeDist(x, y, p) < viaR + clearance) {
      return `pad ${p.ref || '?'}${p.num !== undefined ? '.' + p.num : ''} (${p.net})`;
    }
  }
  for (const t of obstacles.tracks) {
    if (t.net === ownNet) continue;
    if (G.pointSegDist({ x, y }, t) < viaR + (t.width || 8) / 2 + clearance) {
      return `track (${t.net})`;
    }
  }
  for (const v of obstacles.vias) {
    if (v.net === ownNet) continue;
    if (Math.hypot(x - v.x, y - v.y) < viaR + (v.diameter || 24) / 2 + clearance) {
      return `via (${v.net})`;
    }
  }
  return null;
}

/**
 * @param board  {width,height} or {points:[{x,y}]}
 * @param opts   {net, clearance, layers:[1,2], stitch:boolean, spacing,
 *                viaClearance, obstacles:{pads,tracks,vias}}
 *        obstacles pads: {ref,num,net,x,y,w,h}; tracks: {net,x1,y1,x2,y2,width};
 *        vias: {net,x,y,diameter}
 * @returns {pours:[{net,layer,path}], vias:[{net,x,y,width,hole}], notes:[],
 *           viasMoved, viasDropped}
 */
function planPours(board, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const obstacles = {
    pads: (o.obstacles && o.obstacles.pads) || [],
    tracks: (o.obstacles && o.obstacles.tracks) || [],
    vias: (o.obstacles && o.obstacles.vias) || []
  };
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
  let viasMoved = 0;
  let viasDropped = 0;
  if (o.stitch) {
    const step = o.stitchSpacing;
    const viaR = o.viaDiameter / 2;
    const sx1 = region.x1 + o.stitchInset;
    const sy1 = region.y1 + o.stitchInset;
    const sx2 = region.x2 - o.stitchInset;
    const sy2 = region.y2 - o.stitchInset;
    // Nudge candidates on the 10 mil grid: stay, slide along y, slide along x,
    // then diagonal slides. A fence via should stay near its fence line.
    const nudges = [
      [0, 0], [0, -10], [0, 10], [-10, 0], [10, 0],
      [0, -20], [0, 20], [-20, 0], [20, 0],
      [-20, -20], [-20, 20], [20, -20], [20, 20],
      [0, -30], [0, 30], [-30, 0], [30, 0]
    ];
    const placed = [];
    const put = (x, y) => {
      let conflict = null;
      let fx = x;
      let fy = y;
      if (obstacles.pads.length || obstacles.tracks.length || obstacles.vias.length) {
        for (const [dx, dy] of nudges) {
          const cx = x + dx;
          const cy = y + dy;
          conflict = viaConflict(cx, cy, viaR, o.viaClearance, obstacles, o.net);
          if (!conflict) { fx = cx; fy = cy; break; }
        }
      }
      if (conflict) {
        viasDropped += 1;
        if (notes.length < 8) notes.push(`stitching via near ${Math.round(x)},${Math.round(y)} dropped: clears ${conflict} by < ${o.viaClearance} mil`);
        return;
      }
      if (fx !== x || fy !== y) viasMoved += 1;
      placed.push({ net: o.net, x: Math.round(fx), y: Math.round(fy), width: o.viaDiameter, hole: o.viaDrill });
    };
    if (sx2 > sx1 && sy2 > sy1) {
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
    for (const v of placed) {
      const k = `${v.x},${v.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      vias.push(v);
    }
    if (viasMoved) notes.push(`${viasMoved} stitching via(s) nudged off foreign copper`);
    if (viasDropped) notes.push(`${viasDropped} stitching via(s) dropped (no clear spot within ±30 mil)`);
  }
  return { pours, vias, region, notes, viasMoved, viasDropped };
}

function E_rectPath(x, y, w, h) {
  // mirrors epjr3.rectPath: anchor = min-x/max-y corner, height toward -y
  return ['R', x, y + h, w, h];
}

module.exports = { DEFAULTS, planPours, boardRect, viaConflict };
