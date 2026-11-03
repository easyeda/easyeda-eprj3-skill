'use strict';
/**
 * sch-place.js — layered schematic placement (signal flow = layers).
 *
 * Why: grid-packing parts in declaration order gives "shelves of symbols" —
 * every net then has to be routed across the shelf, which is exactly where the
 * ugly long wires and crossings come from. The reference implementation solves
 * this with a Sugiyama-style layered layout; this is a dependency-free
 * re-derivation of the same idea:
 *
 *   1. build the intra-block net graph (power nets down-weighted: they are
 *      drawn as flags, not wires);
 *   2. pick an ANCHOR (highest weighted degree) and take BFS layers outward —
 *      layer = distance from the anchor, i.e. signal depth, not declaration order;
 *   3. order each layer by barycenter sweeps (4 passes, deterministic);
 *   4. assign coordinates: column pitch from real part widths, then pull each
 *      part toward the median y of its neighbours and push overlaps apart;
 *   5. prefer the orientation that faces a 2-pin part's partner (0° vs 90°);
 *   6. pack whole blocks left→right, wrapping at a target width so the sheet
 *      fills a page instead of forming a ribbon.
 *
 * Output shape is identical to design.js `layoutSchematic` (part, sym, x, y,
 * rotation, block, sheet, extent / blocks with title, desc, sheet, rect).
 */
const G = require('./geom');
const { partExtent } = require('./design');

const LAYER_GAP = 90;      // mil between layer columns (wire channels)
const ROW_GAP = 80;        // mil between parts inside a column
const BLOCK_PAD = require('./sch-tokens').FRAME_PAD;
const BLOCK_TITLE_H = 60;
const BARYCENTER_PASSES = 4;
const ALIGN_PASSES = 6;
const POWER_WEIGHT = 0.25;

const grid = (v) => Math.round(v / 10) * 10;

/** Weighted intra-block adjacency (power nets count little: they are flags). */
function blockGraph(members, powerNets) {
  const inBlock = new Set(members.map((p) => p.id));
  const weight = new Map();          // "a|b" -> weight
  const degree = new Map(members.map((p) => [p.id, 0]));
  const add = (a, b, wgt) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    weight.set(k, (weight.get(k) || 0) + wgt);
    degree.set(a, (degree.get(a) || 0) + wgt);
    degree.set(b, (degree.get(b) || 0) + wgt);
  };
  // which parts share which nets
  const byNet = new Map();
  for (const p of members) {
    for (const net of new Set(Object.values(p.pins))) {
      if (/^(NC|DNC\d*)$/i.test(net)) continue;
      if (!byNet.has(net)) byNet.set(net, []);
      byNet.get(net).push(p.id);
    }
  }
  for (const [net, ids] of byNet) {
    if (ids.length < 2) continue;
    const wgt = powerNets.has(net) ? POWER_WEIGHT : 1;
    // star from the first (declaration order keeps it deterministic)
    const hub = ids[0];
    for (const id of ids.slice(1)) if (inBlock.has(id)) add(hub, id, wgt);
  }
  return { weight, degree };
}

/** BFS layers from the anchor; each connected component is layered separately. */
function assignLayers(members, graph) {
  const ids = members.map((p) => p.id);
  const adj = new Map(ids.map((id) => [id, []]));
  for (const [k, wgt] of graph.weight) {
    const [a, b] = k.split('|');
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a).push({ id: b, wgt });
    adj.get(b).push({ id: a, wgt });
  }
  const layer = new Map();
  const order = ids.slice().sort((a, b) => (graph.degree.get(b) - graph.degree.get(a)) || a.localeCompare(b));
  let component = 0;
  const components = [];
  for (const start of order) {
    if (layer.has(start)) continue;
    const comp = [];
    let frontier = [start];
    layer.set(start, 0);
    comp.push(start);
    let depth = 0;
    while (frontier.length) {
      depth += 1;
      const next = [];
      for (const id of frontier) {
        for (const e of adj.get(id)) {
          if (layer.has(e.id)) continue;
          layer.set(e.id, depth);
          next.push(e.id);
          comp.push(e.id);
        }
      }
      // deterministic sweep order
      next.sort((a, b) => (graph.degree.get(b) - graph.degree.get(a)) || a.localeCompare(b));
      frontier = next;
    }
    components.push({ index: component, members: comp.slice().sort() });
    component += 1;
  }
  return { layer, adj, components };
}

/** Barycenter ordering inside each layer; deterministic. */
function orderLayers(layerIds, adj) {
  // layerIds: Map layer -> [id]
  const pos = new Map();
  const reindex = () => {
    pos.clear();
    for (const list of layerIds.values()) list.forEach((id, i) => pos.set(id, i));
  };
  reindex();
  const keys = [...layerIds.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < BARYCENTER_PASSES; pass += 1) {
    const down = pass % 2 === 0;
    const seq = down ? keys : keys.slice().reverse();
    for (const k of seq) {
      const list = layerIds.get(k);
      const bary = new Map();
      for (const id of list) {
        const nbrs = adj.get(id) || [];
        let sum = 0; let wsum = 0;
        for (const e of nbrs) {
          const p = pos.get(e.id);
          if (p === undefined) continue;
          sum += p * e.wgt;
          wsum += e.wgt;
        }
        bary.set(id, wsum ? sum / wsum : pos.get(id));
      }
      list.sort((a, b) => (bary.get(a) - bary.get(b)) || a.localeCompare(b));
      list.forEach((id, i) => pos.set(id, i));
    }
  }
}

/**
 * Median-alignment inside layers: pull each part toward the median y of its
 * neighbours, then resolve overlaps by pushing apart. Repeats a few times so
 * the result settles deterministically.
 */
function alignRows(layerIds, adj, extents, gap) {
  const y = new Map();
  const keys = [...layerIds.keys()].sort((a, b) => a - b);
  // initial packing: centred columns
  const heights = new Map();
  for (const k of keys) {
    let total = 0;
    for (const id of layerIds.get(k)) total += extents.get(id).h;
    total += gap * Math.max(0, layerIds.get(k).length - 1);
    heights.set(k, total);
  }
  const tallest = Math.max(0, ...heights.values());
  for (const k of keys) {
    let cursor = (tallest - heights.get(k)) / 2;
    for (const id of layerIds.get(k)) {
      y.set(id, cursor - extents.get(id).minY);   // anchor top
      cursor += extents.get(id).h + gap;
    }
  }
  for (let pass = 0; pass < ALIGN_PASSES; pass += 1) {
    for (const k of keys) {
      const list = layerIds.get(k);
      const target = new Map();
      for (const id of list) {
        const nbrs = adj.get(id) || [];
        const ys = [];
        for (const e of nbrs) if (y.has(e.id)) ys.push(y.get(e.id));
        if (!ys.length) { target.set(id, y.get(id)); continue; }
        ys.sort((a, b) => a - b);
        const mid = ys.length % 2
          ? ys[(ys.length - 1) / 2]
          : (ys[ys.length / 2 - 1] + ys[ys.length / 2]) / 2;
        // blend: mostly median, a quarter of the current slot (stability)
        target.set(id, 0.75 * mid + 0.25 * y.get(id));
      }
      list.sort((a, b) => (target.get(a) - target.get(b)) || a.localeCompare(b));
      // push apart so each part's top >= previous bottom + gap
      let cursor = -Infinity;
      for (const id of list) {
        const e = extents.get(id);
        const top = Math.max(target.get(id), cursor);
        y.set(id, grid(top));
        cursor = y.get(id) + e.h + gap;
      }
    }
  }
  return y;
}

/** Choose 0° or 90° for a 2-pin part so it faces its partner. */
function orientTwoPin(part, sym, neighbours, placementsById) {
  if (sym.pins.length !== 2 || part.rotationExplicit) return 0;
  const n = neighbours.map((id) => placementsById.get(id)).filter(Boolean);
  if (!n.length) return 0;
  let dx = 0; let dy = 0;
  for (const p of n) { dx += Math.abs(p.x - part.__x); dy += Math.abs(p.y - part.__y); }
  return dy > dx * 1.15 ? 90 : 0;
}

function layoutLayered(d, lib) {
  const L = d.layout;
  const powerNets = new Set([...(d.powerNets ? d.powerNets.keys() : [])]);
  // Pack blocks into a near-square (√N × √N) grid — N is the count of blocks
  // ON THIS SHEET (see layoutSchematic in design.js for the same fix).
  const blocksPerSheet = new Map();
  for (const b of d.blocks) blocksPerSheet.set(b.sheet, (blocksPerSheet.get(b.sheet) || 0) + 1);

  const placements = [];
  const blocks = [];
  let cursorX = 0;
  let colInRow = 0;
  let rowBaseY = 100;
  let rowMaxH = 0;
  let currentSheet = 0;
  let colsPerRow = 1;

  for (const block of d.blocks) {
    if (block.sheet !== currentSheet) {
      currentSheet = block.sheet;
      colsPerRow = Math.max(1, Math.ceil(Math.sqrt(blocksPerSheet.get(block.sheet) || 1)));
      cursorX = 0;
      rowBaseY = 100;
      rowMaxH = 0;
      colInRow = 0;
    }
    const members = block.parts.map((id) => d.parts.find((p) => p.id === id)).filter(Boolean);
    if (!members.length) continue;

    const graph = blockGraph(members, powerNets);
    const { layer, adj, components } = assignLayers(members, graph);
    const byId = new Map(members.map((p) => [p.id, p]));

    // per part: symbol + extent (rotation chosen later; measure both 0 and 90)
    const syms = new Map();
    const sizes = new Map();
    for (const p of members) {
      const sym = lib.symbolOf(p);
      syms.set(p.id, sym);
      const e0 = partExtent(sym, 0, 0, 0);
      const e90 = partExtent(sym, 0, 0, 90);
      const twoPin = sym.pins.length === 2 && !p.rotationExplicit && !p.rotationTidied;
      sizes.set(p.id, {
        w: twoPin ? Math.min(e0.x2 - e0.x1, e90.x2 - e90.x1) : e0.x2 - e0.x1,
        h: twoPin ? Math.min(e0.y2 - e0.y1, e90.y2 - e90.y1) : e0.y2 - e0.y1,
        minX0: e0.x1, minY0: e0.y1,
        minX90: e90.x1, minY90: e90.y1,
        e0, e90,
        twoPin
      });
    }

    // group ids per layer, per component (components stack vertically)
    const compOf = new Map();
    components.forEach((c) => c.members.forEach((id) => compOf.set(id, c.index)));
    const layerIds = new Map();
    for (const p of members) {
      const k = `${compOf.get(p.id)}:${layer.get(p.id)}`;
      if (!layerIds.has(k)) layerIds.set(k, []);
      layerIds.get(k).push(p.id);
    }
    for (const list of layerIds.values()) list.sort((a, b) => a.localeCompare(b));
    orderLayers(layerIds, adj);

    // extents for alignment: uniform size per part (orientation-independent)
    const extents = new Map();
    for (const [id, sz] of sizes) extents.set(id, { w: sz.w, h: sz.h, minY: 0 });
    const ys = alignRows(layerIds, adj, extents, ROW_GAP);

    // x: columns by (component, layer) in layer order
    const colKeys = [...layerIds.keys()].sort((a, b) => {
      const [ca, la] = a.split(':').map(Number);
      const [cb, lb] = b.split(':').map(Number);
      return (ca - cb) || (la - lb);
    });
    const colWidth = new Map();
    for (const k of colKeys) {
      let w = 0;
      for (const id of layerIds.get(k)) w = Math.max(w, sizes.get(id).w);
      colWidth.set(k, w);
    }
    // column strip dimensions before wrapping
    const stripW = colKeys.reduce((n, k) => n + colWidth.get(k) + LAYER_GAP, 0) - LAYER_GAP;
    const colHeight = (k) => {
      let h = 0;
      const ids = layerIds.get(k);
      for (const id of ids) h += sizes.get(id).h;
      return h + ROW_GAP * Math.max(0, ids.length - 1);
    };
    const stripH = Math.max(0, ...colKeys.map(colHeight));
    // WRAP: a column strip that is a sliver (aspect beyond 2.2:1 either way)
    // is folded into several rows of columns — the page-filling shape the
    // quality metric rewards. Deterministic: split evenly, keep order.
    const aspect = stripH > 0 ? stripW / stripH : 1;
    // too WIDE → fold into a grid of rows (aim at ~2.2:1, never 1-per-row);
    // too TALL → fold columns into more rows (shorter, wider)
    let rows = 1;
    if (aspect > 2.2) rows = Math.max(1, Math.round(stripW / (2.2 * stripH)));
    else if (aspect < 1 / 2.2) rows = Math.max(1, Math.ceil(stripH / (2.2 * stripW)));
    rows = Math.min(rows, colKeys.length);
    const perRow = Math.ceil(colKeys.length / rows);
    const colX = new Map();
    const colY = new Map();
    let rowY = 0;
    for (let r = 0; r < rows; r += 1) {
      const slice = colKeys.slice(r * perRow, (r + 1) * perRow);
      let x = 0;
      let rowH = 0;
      for (const k of slice) {
        colX.set(k, x);
        colY.set(k, rowY);
        x += colWidth.get(k) + LAYER_GAP;
        rowH = Math.max(rowH, colHeight(k));
      }
      rowY += rowH + 100;
    }

    // place: x by column, y from alignment; rotation for 2-pin parts
    const draft = new Map();
    for (const p of members) {
      const k = `${compOf.get(p.id)}:${layer.get(p.id)}`;
      const sz = sizes.get(p.id);
      const x = colX.get(k);
      const y = ys.get(p.id) + (colY.get(k) || 0);
      draft.set(p.id, { part: p, sym: syms.get(p.id), x, y, sz });
    }
    for (const p of members) {
      const dr = draft.get(p.id);
      p.__x = dr.x;
      p.__y = dr.y;
    }
    for (const p of members) {
      const dr = draft.get(p.id);
      const nbrIds = (adj.get(p.id) || []).map((e) => e.id);
      const rot = dr.sz.twoPin ? orientTwoPin(p, dr.sym, nbrIds, draft) : (p.rotation || 0);
      // origin = desired body position minus the extent's own offset
      const minX = rot === 90 ? dr.sz.minX90 : dr.sz.minX0;
      const minY = rot === 90 ? dr.sz.minY90 : dr.sz.minY0;
      dr.rotation = rot;
      dr.originX = grid(dr.x - minX);
      dr.originY = grid(dr.y - minY);
    }

    let box = null;
    for (const p of members) {
      const dr = draft.get(p.id);
      const pl = {
        part: p, sym: dr.sym,
        x: dr.originX + cursorX, y: dr.originY + rowBaseY,
        rotation: dr.rotation, block, sheet: currentSheet
      };
      pl.extent = partExtent(pl.sym, pl.x, pl.y, pl.rotation);
      placements.push(pl);
      box = box ? unionRect(box, pl.extent) : pl.extent;
    }
    void byId;

    const rect = {
      x1: grid(box.x1 - BLOCK_PAD),
      y1: grid(box.y1 - BLOCK_PAD),
      x2: grid(box.x2 + BLOCK_PAD),
      y2: grid(box.y2 + BLOCK_PAD + BLOCK_TITLE_H)
    };
    blocks.push({ title: block.title, desc: block.desc, sheet: block.sheet, rect, members: members.map((p) => p.id) });
    rowMaxH = Math.max(rowMaxH, rect.y2 - rowBaseY);
    cursorX = rect.x2 + 110;
    colInRow += 1;
    if (colInRow >= colsPerRow) {
      cursorX = 0;
      rowBaseY += rowMaxH + 100;
      rowMaxH = 0;
      colInRow = 0;
    }
  }
  // strip temporary coordinates
  for (const p of d.parts) { delete p.__x; delete p.__y; }
  return { placements, blocks };
}

function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2)
  };
}

module.exports = { layoutLayered, blockGraph, assignLayers, orderLayers, alignRows };
