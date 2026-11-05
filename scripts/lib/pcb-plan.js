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

/**
 * @param design  normalized design
 * @param lib     {footprintOf}
 * @param schematicPlacements  used only for ordering
 * @returns {{placements:[{part, pcbPos:[x,y,angle]}], required:{width,height}}}
 */
function planPcb(design, lib, schematicPlacements) {
  // Spacing scales down only when the build has to hit a tight board target
  // (design.gapScale < 1, set by build.js's board sizing). The defaults are
  // the routing-friendly spacing; 30 mil is the floor that still clears the
  // 12 mil board-edge rule.
  const scale = Math.max(0.2, Math.min(1, Number(design.gapScale) || 1));
  const EDGE = Math.max(30, Math.round(150 * scale));
  const GAP_MIN = Math.max(30, Math.round(140 * scale));
  const GAP_MAX = Math.max(70, Math.round(260 * scale));
  const gapFor = (size) => Math.round(Math.max(GAP_MIN, Math.min(GAP_MAX, size)));
  const INTRA_GAP = Math.max(25, Math.round(60 * scale));    // inside one module
  const BLOCK_GAP = Math.max(60, Math.round(300 * scale));   // between modules
  const explicit = (design.pcbSpec && design.pcbSpec.place) || {};
  const order = schematicPlacements && schematicPlacements.length
    ? schematicPlacements.map((p) => p.part)
    : design.parts;
  const groundNets = new Set([...(design.powerNets || [])]
    .filter(([, v]) => v === 'down').map(([n]) => n));

  // ---- pass 1: resolve every part's footprint and extent ------------------
  // Multi-unit components (U34A/U34B/…) place ONE footprint per base: the
  // first unit stands in for the whole component (id = base, pins = union of
  // every unit), so the board never gets N overlapping copies of one BGA.
  const items = [];
  const seenBase = new Set();
  for (const rawPart of order) {
    let part = rawPart;
    if (rawPart.multiUnitBase) {
      if (seenBase.has(rawPart.multiUnitBase)) continue;
      seenBase.add(rawPart.multiUnitBase);
      const units = (design.parts || []).filter((q) => q.multiUnitBase === rawPart.multiUnitBase);
      const merged = {};
      for (const u of units) Object.assign(merged, u.pins);
      part = Object.assign({}, rawPart, { id: rawPart.multiUnitBase, pins: merged });
    }
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
  const isConnector = (it) => /^(J|CN|USB)\d/i.test(it.part.id);
  const connectors = items.filter((it) => !it.explicit && isConnector(it));
  const rest = items.filter((it) => !it.explicit && !isConnector(it));
  const placed = [];          // {ref, ext} for overlap/refinement checks
  for (const it of items) {
    if (it.explicit && it.ext) placed.push({ ref: it.part.id, ext: it.ext });
  }

  // connectors first: along the bottom edge, wrapping upward into further
  // edge rows when the declared board is too narrow for one row (S3: many
  // pin headers used to march past the board outline). Explicit placements
  // (a hand-placed USB-C at the board edge, say) are respected: connectors
  // skip past their footprints instead of stacking on them.
  const explicitBoxes = items.filter((it) => it.explicit && it.ext).map((it) => it.ext);
  let cursorX = EDGE;
  let rowBase = 0;      // y offset of the CURRENT connector row's base
  let rowHConn = 0;     // tallest extent in the current row
  let connBand = 0;     // total connector band height (grid starts above it)
  for (const it of connectors) {
    it.angle = connectorAngle(it.fp);
    it.ext = footprintExtent(it.fp, it.angle);
    const w = it.ext.x2 - it.ext.x1;
    if (cursorX > EDGE && cursorX + w > design.board.width - EDGE) {
      cursorX = EDGE;
      rowBase += rowHConn + GAP_MAX;
      rowHConn = 0;
    }
    let x = cursorX - it.ext.x1;
    const y = EDGE + rowBase - it.ext.y1;   // extent bottom sits EDGE above the row base
    // slide right past any explicit footprint already sitting in this band
    for (let guard = 0; guard < 16; guard += 1) {
      const box = G.translateBox(it.ext, x, y);
      const hit = explicitBoxes.find((o) => G.rectsOverlap(box, G.expand(o, 10)));
      if (!hit) break;
      x = hit.x2 + gapFor(w) - it.ext.x1;
    }
    it.x = G.round(x);
    it.y = G.round(y);
    placed.push({ ref: it.part.id, ext: G.translateBox(it.ext, it.x, it.y) });
    cursorX = it.x + it.ext.x1 + w + gapFor(w);
    rowHConn = Math.max(rowHConn, it.ext.y2 - it.ext.y1);
    connBand = rowBase + rowHConn;
  }

  // ---- module clusters ----------------------------------------------------
  // Every schematic block becomes ONE PCB cluster laid out around its anchor
  // (the member with the most pads — normally the IC). Each further member
  // takes the free spot beside the cluster that is closest to the pads it
  // shares a net with, so a decoupling cap lands next to the supply pin it
  // serves and a pull-up next to the signal it pulls. Ground never attracts
  // (every part touches it). Clusters are then shelf-packed in block order —
  // the schematic's signal flow — with a routing channel between modules.
  const padsAt = (it, x, y) => (it.fp.pads || []).map((p) => {
    const r = G.rotate(p.x, p.y, it.angle || 0);
    return { net: (it.part.pins || {})[String(p.num)] || null, x: x + r.x, y: y + r.y };
  });
  const tieNets = (it) => new Set(Object.values(it.part.pins || {})
    .filter((n) => n && !groundNets.has(n) && !/^(NC|DNCd*)$/i.test(n)));
  const centre = (r) => ({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 });
  const unionAll = (boxes) => boxes.reduce((u, r) => (u ? G.rect(Math.min(u.x1, r.x1), Math.min(u.y1, r.y1),
    Math.max(u.x2, r.x2), Math.max(u.y2, r.y2)) : r), null);

  for (const it of rest) it.ext = footprintExtent(it.fp, it.angle);
  const byBlock = new Map();
  for (const it of rest) {
    const k = it.part.blockIndex === undefined ? -1 : it.part.blockIndex;
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(it);
  }

  const clusters = [];
  for (const [, members] of [...byBlock.entries()].sort((p, q) => p[0] - q[0])) {
    const padCount = (it) => (it.fp.pads || []).length;
    const anchor = members.slice().sort((p, q) => padCount(q) - padCount(p))[0];
    const local = [{ it: anchor, x: 0, y: 0, box: anchor.ext }];
    const ac = centre(anchor.ext);
    const remaining = members.filter((it) => it !== anchor);
    while (remaining.length) {
      // strongest tie to what is already placed goes next
      let pick = 0;
      let pickTie = -1;
      remaining.forEach((it, i) => {
        const nets = tieNets(it);
        let tie = 0;
        for (const q of local) for (const p of padsAt(q.it, q.x, q.y)) if (p.net && nets.has(p.net)) tie += 1;
        if (tie > pickTie) { pickTie = tie; pick = i; }
      });
      const it = remaining.splice(pick, 1)[0];
      const nets = tieNets(it);
      const targets = [];
      for (const q of local) for (const p of padsAt(q.it, q.x, q.y)) if (p.net && nets.has(p.net)) targets.push(p);
      const attract = targets.length
        ? { x: targets.reduce((n, p) => n + p.x, 0) / targets.length, y: targets.reduce((n, p) => n + p.y, 0) / targets.length }
        : ac;
      const w = it.ext.x2 - it.ext.x1;
      const h = it.ext.y2 - it.ext.y1;
      const cands = [];
      for (const q of local) {
        const r = q.box;
        for (const y1 of [r.y1, (r.y1 + r.y2) / 2 - h / 2, r.y2 - h, attract.y - h / 2]) {
          cands.push({ x1: r.x2 + INTRA_GAP, y1 }, { x1: r.x1 - INTRA_GAP - w, y1 });
        }
        for (const x1 of [r.x1, (r.x1 + r.x2) / 2 - w / 2, r.x2 - w, attract.x - w / 2]) {
          cands.push({ x1, y1: r.y2 + INTRA_GAP }, { x1, y1: r.y1 - INTRA_GAP - h });
        }
      }
      let best = null;
      for (const c of cands) {
        const ox = G.round(c.x1 - it.ext.x1);
        const oy = G.round(c.y1 - it.ext.y1);
        const box = G.translateBox(it.ext, ox, oy);
        if (local.some((q) => G.rectsOverlap(G.expand(q.box, INTRA_GAP - 0.5), box))) continue;
        const m = centre(box);
        const cost = Math.hypot(m.x - attract.x, m.y - attract.y) + 0.35 * Math.hypot(m.x - ac.x, m.y - ac.y);
        if (!best || cost < best.cost - 1e-6) best = { ox, oy, box, cost };
      }
      if (!best) {
        const u = unionAll(local.map((q) => q.box));
        const ox = G.round(u.x2 + INTRA_GAP - it.ext.x1);
        const oy = G.round(u.y1 - it.ext.y1);
        best = { ox, oy, box: G.translateBox(it.ext, ox, oy) };
      }
      local.push({ it, x: best.ox, y: best.oy, box: best.box });
    }
    clusters.push({ local, bbox: unionAll(local.map((q) => q.box)) });
  }

  // shelf-pack the clusters in block order; an undeclared board aims for a
  // roughly square layout, a declared one fills its width
  let neededW = 0;
  let neededH = 0;
  const totalArea = clusters.reduce((n, c) => n
    + (c.bbox.x2 - c.bbox.x1 + BLOCK_GAP) * (c.bbox.y2 - c.bbox.y1 + BLOCK_GAP), 0);
  const widest = clusters.reduce((n, c) => Math.max(n, c.bbox.x2 - c.bbox.x1), 0);
  const rowLimit = Math.max(widest, design.boardDeclared || design.boardFixed
    ? design.board.width - 2 * EDGE
    : Math.sqrt(totalArea) * 1.25);
  let packX = 0;
  let packY = EDGE + (connectors.length ? connBand + GAP_MAX : 0);
  let packRowH = 0;
  for (const c of clusters) {
    const w = c.bbox.x2 - c.bbox.x1;
    const h = c.bbox.y2 - c.bbox.y1;
    let at = null;
    for (let guard = 0; guard < 24 && !at; guard += 1) {
      if (packX > 0 && packX + w > rowLimit) {
        packX = 0;
        packY += packRowH + BLOCK_GAP;
        packRowH = 0;
      }
      const dx = EDGE + packX - c.bbox.x1;
      const dy = packY - c.bbox.y1;
      const boxes = c.local.map((q) => G.translateBox(q.box, dx, dy));
      // explicit `pcb.place` parts are keepouts for the auto placer
      const hit = explicitBoxes.find((o) => boxes.some((r) => G.rectsOverlap(r, G.expand(o, 10))));
      if (!hit) at = { dx, dy };
      else packX = hit.x2 - EDGE + BLOCK_GAP;
    }
    if (!at) {
      packX = 0;
      packY = Math.max(packY, ...explicitBoxes.map((r) => r.y2)) + BLOCK_GAP;
      at = { dx: EDGE - c.bbox.x1, dy: packY - c.bbox.y1 };
    }
    for (const q of c.local) {
      q.it.x = G.round(q.x + at.dx);
      q.it.y = G.round(q.y + at.dy);
      placed.push({ ref: q.it.part.id, ext: G.translateBox(q.it.ext, q.it.x, q.it.y) });
    }
    packX += w + BLOCK_GAP;
    packRowH = Math.max(packRowH, h);
  }

  // ---- required board size from the FINAL extents -------------------------
  // (explicit placements included — a wide part at a hand-written [x,y] must
  // not stick past the outline the way the old x+EDGE heuristic allowed.
  // Explicit extents were ALREADY translated to absolute in pass 1 —
  // translating again here doubled the board, 3540 → 6850/13666 mil.)
  for (const it of items) {
    if (!it.ext) continue;
    const box = it.explicit ? it.ext : G.translateBox(it.ext, it.x, it.y);
    neededW = Math.max(neededW, box.x2 + EDGE);
    neededH = Math.max(neededH, box.y2 + EDGE);
  }

  return {
    placements: items.map((it) => ({ part: it.part, pcbPos: [it.x, it.y, it.angle] })),
    required: { width: Math.ceil(neededW), height: Math.ceil(neededH) }
  };
}

module.exports = { planPcb, footprintExtent, EDGE, GAP_MIN, GAP_MAX };
