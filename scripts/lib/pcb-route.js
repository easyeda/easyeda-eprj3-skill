'use strict';
/**
 * pcb-route.js — dependency-free grid router for a 2-layer board.
 *
 * Approach: rasterise the board at a coarse grid, mark obstacles (foreign pads,
 * already-routed copper, board edge, keepouts), then run A* per net connection.
 * Two layers are available and connected by vias; a via costs more than a bend
 * so the router keeps as much as it can on one side.
 *
 * This is deliberately a simple maze router: it will not do length matching or
 * impedance control, but it produces clean orthogonal-looking copper for the
 * kind of boards this skill generates (a handful of parts, one or two layers),
 * and every net it fails to route is reported instead of silently skipped.
 */

const G = require('./geom');

const DEFAULT_RULES = {
  grid: 10,          // mil raster
  clearance: 10,     // mil, copper-to-copper (DRC checks 10 — keep headroom)
  trackWidth: 8,    // mil
  viaDiameter: 24,   // mil
  viaDrill: 12,      // mil
  edgeClearance: 20, // mil
  layers: 2,
  bendCost: 6,
  viaCost: 120
};

/** Binary min-heap keyed by fScore (self-contained, no deps). */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1; const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class Grid {
  constructor(board, rules) {
    this.rules = rules;
    this.grid = rules.grid;
    this.cols = Math.max(2, Math.ceil(board.width / this.grid));
    this.rows = Math.max(2, Math.ceil(board.height / this.grid));
    this.layers = rules.layers;
    // blocked[layer][idx] — clearance zone (net name, '#conflict' or '#edge')
    // body[layer][idx]    — real pad copper: only its own net may enter
    // trackOcc[layer][idx]— centreline keep-out of REAL copper (tracks/vias):
    //                       never passable, not even in the allowSoft pass
    this.blocked = [];
    this.body = [];
    this.trackOcc = [];
    for (let l = 0; l < this.layers; l += 1) {
      this.blocked.push(new Array(this.cols * this.rows).fill(''));
      this.body.push(new Array(this.cols * this.rows).fill(''));
      this.trackOcc.push(new Array(this.cols * this.rows).fill(false));
    }
  }

  idx(i, j) { return j * this.cols + i; }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.cols && j < this.rows; }
  toCell(p) {
    return {
      i: Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.grid))),
      j: Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / this.grid)))
    };
  }
  toPoint(i, j) {
    return { x: (i + 0.5) * this.grid, y: (j + 0.5) * this.grid };
  }

  /**
   * Mark a rectangle. `kind` 'body' writes real pad copper (only its own net
   * may enter); 'track'/'via' additionally mark real copper that allowSoft may
   * never cross; the default 'soft' writes the clearance zone. Soft zones of
   * two different nets become '#conflict' so neither can sneak through the
   * other's clearance.
   */
  blockRect(rect, net, layers, kind) {
    const a = this.toCell({ x: rect.x1, y: rect.y1 });
    const b = this.toCell({ x: rect.x2, y: rect.y2 });
    const soft = kind !== 'body';
    const solid = kind === 'track' || kind === 'via';
    for (let j = Math.min(a.j, b.j); j <= Math.max(a.j, b.j); j += 1) {
      for (let i = Math.min(a.i, b.i); i <= Math.max(a.i, b.i); i += 1) {
        if (!this.inside(i, j)) continue;
        for (const l of layers) {
          const idx = this.idx(i, j);
          if (solid) this.trackOcc[l][idx] = true;
          if (!soft) {
            this.body[l][idx] = net;
            continue;
          }
          const cur = this.blocked[l][idx];
          if (!cur) this.blocked[l][idx] = net;
          else if (cur !== net) this.blocked[l][idx] = '#conflict';
        }
      }
    }
  }

  edgeBlocked(layers) {
    const m = Math.ceil(this.rules.edgeClearance / this.grid);
    for (let j = 0; j < this.rows; j += 1) {
      for (let i = 0; i < this.cols; i += 1) {
        if (i >= m && j >= m && i < this.cols - m && j < this.rows - m) continue;
        for (const l of layers) if (!this.blocked[l][this.idx(i, j)]) this.blocked[l][this.idx(i, j)] = '#edge';
      }
    }
  }
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function heuristic(a, b) {
  return (Math.abs(a.i - b.i) + Math.abs(a.j - b.j)) * 10;
}

/**
 * A* between two pads on a two-layer grid. `src`/`dst` cells are passable even
 * if their own net blocked them.
 * @returns [{layer, i, j}] path or null
 */
function findPath(grid, src, dst, net, opts) {
  const { rules } = grid;
  const startKey = `${src.layer}:${src.i},${src.j}`;
  const gScore = new Map();
  const came = new Map();
  const heap = new Heap();
  gScore.set(startKey, 0);
  heap.push({ layer: src.layer, i: src.i, j: src.j, f: heuristic(src, dst), key: startKey });

  const dirOf = (key) => {
    const parent = came.get(key);
    if (!parent) return -1;
    const p = parent.node;
    return DIRS.findIndex(([di, dj]) => di === (parent.node.i - p.i) && dj === (parent.node.j - p.j));
  };
  void dirOf;

  const isGoal = (n) => n.i === dst.i && n.j === dst.j && n.layer === dst.layer;
  // Pad escape: on a fine-pitch part a pad sits inside its neighbours' keep-outs
  // (SOT-23 pads are 37 mil apart, their keep-outs ~64), so the router must be
  // allowed to step out of the source pad and into the target pad or it is
  // walled in before it starts. The DRC likewise ignores pad-to-pad spacing
  // inside one footprint — this zone is that same region.
  const ESCAPE = 1;
  const passable = (i, j, layer) => {
    if (!grid.inside(i, j)) return false;
    if (i === src.i && j === src.j && layer === src.layer) return true;
    if (i === dst.i && j === dst.j && layer === dst.layer) return true;
    // never route over another net's actual pad copper, escape or not
    const bodyOcc = grid.body[layer][grid.idx(i, j)];
    if (bodyOcc && bodyOcc !== net) return false;
    const occ = grid.blocked[layer][grid.idx(i, j)];
    const mine = occ === net || occ === `T:${net}`;
    // Existing copper of another net is a hard wall even inside an escape zone:
    // squeezing past a pad's clearance is ugly, crossing a track is a short.
    if (!mine && occ.charAt(0) === 'T') return false;
    if (Math.abs(i - src.i) <= ESCAPE && Math.abs(j - src.j) <= ESCAPE) return true;
    if (Math.abs(i - dst.i) <= ESCAPE && Math.abs(j - dst.j) <= ESCAPE) return true;
    if (!occ || mine) return true;
    // Best-effort pass: reach the target through a PAD clearance zone rather
    // than leaving the net unrouted. Real copper (tracks/vias) is never
    // passable — overlapping copper is a short, not a spacing violation.
    // A trace WIDER than the default has no business squeezing through a pad
    // gap sized for the default: its copper would land on the pad itself.
    if (opts && opts.allowSoft) {
      if (grid.trackOcc[layer][grid.idx(i, j)]) return false;
      if ((opts.width || rules.trackWidth) > rules.trackWidth) return false;
      return occ !== '#edge' && occ !== '#keepout';
    }
    return false;
  };

  let guard = 0;
  // Search budget per connection: a maze router on a blocked board can explore
  // the whole grid without finding anything, so cap it rather than stall.
  const maxNodes = Math.min(40000, grid.cols * grid.rows * grid.layers);
  while (heap.size && guard < maxNodes) {
    guard += 1;
    const cur = heap.pop();
    if (cur.f === undefined) continue;
    if (isGoal(cur)) {
      const path = [];
      let key = cur.key;
      let node = cur;
      while (key) {
        path.push({ layer: node.layer, i: node.i, j: node.j });
        const prev = came.get(key);
        if (!prev) break;
        node = prev.node;
        key = prev.key;
      }
      return path.reverse();
    }
    const prevKey = came.get(cur.key);
    const prevDir = prevKey ? prevKey.dir : -1;
    const g = gScore.get(cur.key);

    for (let d = 0; d < DIRS.length; d += 1) {
      const [di, dj] = DIRS[d];
      const ni = cur.i + di;
      const nj = cur.j + dj;
      if (!passable(ni, nj, cur.layer)) continue;
      const key = `${cur.layer}:${ni},${nj}`;
      const turn = prevDir >= 0 && prevDir !== d ? rules.bendCost : 0;
      const ng = g + grid.grid + turn;
      if (gScore.has(key) && gScore.get(key) <= ng) continue;
      gScore.set(key, ng);
      came.set(key, { key: cur.key, node: { i: cur.i, j: cur.j, layer: cur.layer }, dir: d });
      heap.push({ layer: cur.layer, i: ni, j: nj, f: ng + heuristic({ i: ni, j: nj }, dst), key });
    }
    // via to the other layer
    if (rules.layers > 1) {
      for (let l = 0; l < rules.layers; l += 1) {
        if (l === cur.layer) continue;
        if (!passable(cur.i, cur.j, l)) continue;
        const key = `${l}:${cur.i},${cur.j}`;
        const ng = g + rules.viaCost;
        if (gScore.has(key) && gScore.get(key) <= ng) continue;
        gScore.set(key, ng);
        came.set(key, { key: cur.key, node: { i: cur.i, j: cur.j, layer: cur.layer }, dir: -1 });
        heap.push({ layer: l, i: cur.i, j: cur.j, f: ng + heuristic(cur, dst), key });
      }
    }
  }
  void opts;
  return null;
}

/** Collapse a cell path into orthogonal segments, splitting at layer changes. */
function pathToTracks(path, grid) {
  const segments = [];
  const vias = [];
  if (path.length < 2) return { segments, vias };
  const seg = (layer, a, b) => ({
    layer,
    a: grid.toPoint(a.i, a.j),
    b: grid.toPoint(b.i, b.j)
  });
  let runStart = path[0];
  let prev = path[0];
  let dir = null;
  for (let k = 1; k < path.length; k += 1) {
    const cur = path[k];
    if (cur.layer !== prev.layer) {
      if (runStart !== prev) segments.push(seg(prev.layer, runStart, prev));
      vias.push(grid.toPoint(prev.i, prev.j));
      runStart = cur;
      dir = null;
    } else {
      const nd = { di: Math.sign(cur.i - prev.i), dj: Math.sign(cur.j - prev.j) };
      if (dir && (nd.di !== dir.di || nd.dj !== dir.dj)) {
        if (runStart !== prev) segments.push(seg(prev.layer, runStart, prev));
        runStart = prev;
      }
      dir = nd;
    }
    prev = cur;
  }
  if (runStart !== prev) segments.push(seg(prev.layer, runStart, prev));
  return { segments, vias };
}

/**
 * @param opts {pads:[{ref,num,net,x,y,w,h}], board:{width,height}, rules,
 *              keepouts, netWidths:{netName:mil}}
 * @returns {tracks:[], vias:[], unrouted:[], stats:{}}
 */
function routePcb(opts) {
  const rules = Object.assign({}, DEFAULT_RULES, opts.rules || {});
  const netWidths = opts.netWidths || {};
  const widthOf = (net) => (netWidths[net] > 0 ? netWidths[net] : rules.trackWidth);
  // Pad keep-outs must clear the WIDEST trace on the board, or a wide power
  // route would squeeze past a pad the default-width radius permits.
  const boardMaxTrack = Math.max(rules.trackWidth, ...Object.values(netWidths).filter((v) => v > 0));
  const board = opts.board;
  const grid = new Grid(board, rules);
  const pads = opts.pads.filter((p) => p.net);
  const allLayers = [];
  for (let l = 0; l < rules.layers; l += 1) allLayers.push(l);

  // obstacles: pad BODY (hard copper) plus a clearance zone sized pad-half +
  // clearance + half the track width, because the CHECK measures copper edge to
  // copper edge. The extra 2 mil absorbs rasterisation rounding.
  const halfTrack = boardMaxTrack / 2;
  const full = rules.clearance + halfTrack + 2;
  for (const p of pads) {
    const hw0 = Math.max(p.w || 20, rules.grid) / 2;
    const hh0 = Math.max(p.h || 20, rules.grid) / 2;
    grid.blockRect({ x1: p.x - hw0, y1: p.y - hh0, x2: p.x + hw0, y2: p.y + hh0 }, p.net, allLayers, 'body');
    grid.blockRect({
      x1: p.x - hw0 - full, y1: p.y - hh0 - full,
      x2: p.x + hw0 + full, y2: p.y + hh0 + full
    }, p.net, allLayers);
  }
  for (const k of opts.keepouts || []) {
    grid.blockRect(k, '#keepout', allLayers);
  }
  grid.edgeBlocked(allLayers);

  const byNet = new Map();
  const skip = new Set(opts.skipNets || []);
  for (const p of pads) {
    if (skip.has(p.net)) continue; // e.g. the ground net is joined by the pour
    if (!byNet.has(p.net)) byNet.set(p.net, []);
    byNet.get(p.net).push(p);
  }

  const tracks = [];
  const vias = [];
  const unrouted = [];
  let routedNets = 0;
  // Wall-clock budget: a hard board must not turn a build into a hang.
  const budgetMs = opts.timeBudgetMs === undefined ? 15000 : opts.timeBudgetMs;
  const deadline = Date.now() + budgetMs;

  for (const [net, netPads] of byNet) {
    if (netPads.length < 2) continue;
    if (Date.now() > deadline) {
      unrouted.push(`${net}: router time budget exhausted`);
      continue;
    }
    // simple nearest-neighbour chain keeps the routing order local
    const remaining = netPads.slice(1);
    let current = netPads[0];
    let netOk = true;
    const w = widthOf(net);
    while (remaining.length) {
      remaining.sort((a, b) => (Math.abs(a.x - current.x) + Math.abs(a.y - current.y))
        - (Math.abs(b.x - current.x) + Math.abs(b.y - current.y)));
      const next = remaining.shift();
      const a = grid.toCell(current);
      const b = grid.toCell(next);
      let path = null;
      for (const layer of allLayers) {
        path = findPath(grid, { i: a.i, j: a.j, layer }, { i: b.i, j: b.j, layer }, net, { rules });
        if (path) break;
      }
      // Second chance: allow the route to squeeze through a clearance zone
      // instead of giving up. The DRC still reports the true spacing, so a
      // best-effort connection is visible rather than silent.
      if (!path) {
        for (const layer of allLayers) {
          path = findPath(grid, { i: a.i, j: a.j, layer }, { i: b.i, j: b.j, layer }, net, { rules, allowSoft: true, width: w });
          if (path) break;
        }
      }
      if (!path) {
        netOk = false;
        unrouted.push(`${net}: ${current.ref}.${current.num} → ${next.ref}.${next.num}`);
        current = next;
        continue;
      }
      const { segments, vias: pathVias } = pathToTracks(path, grid);
      for (const s of segments) {
        tracks.push({ net, layer: s.layer, x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, width: w });
        // Reserve the copper just laid: the keep-out radius is measured from the
        // centreline, so it must cover this track's half-width, the clearance,
        // and the NEXT track's half-width, or the DRC will see edge-to-edge.
        const r = rules.clearance + w;
        grid.blockRect({
          x1: Math.min(s.a.x, s.b.x) - r, y1: Math.min(s.a.y, s.b.y) - r,
          x2: Math.max(s.a.x, s.b.x) + r, y2: Math.max(s.a.y, s.b.y) + r
        }, `T:${net}`, [s.layer], 'track');
      }
      for (const v of pathVias) {
        vias.push({ net, x: v.x, y: v.y, diameter: rules.viaDiameter, drill: rules.viaDrill });
        const r = rules.viaDiameter / 2 + rules.clearance + boardMaxTrack / 2;
        grid.blockRect({ x1: v.x - r, y1: v.y - r, x2: v.x + r, y2: v.y + r }, net, allLayers, 'via');
      }
      current = next;
    }
    if (netOk) routedNets += 1;
  }

  return {
    tracks,
    vias,
    unrouted,
    stats: {
      nets: byNet.size,
      routedNets,
      tracks: tracks.length,
      vias: vias.length,
      grid: rules.grid,
      layers: rules.layers
    }
  };
}

module.exports = { DEFAULT_RULES, Grid, routePcb, findPath, pathToTracks };
void G;
