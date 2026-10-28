'use strict';
/**
 * route.js — schematic auto-wiring.
 *
 * The whole point of this module is that an agent should never hand-compute a
 * pin coordinate again. Given absolute placements, it derives every connection
 * point, decides wire vs. stub+label, and emits orthogonal geometry that lands
 * exactly on pin tips.
 *
 * Encoding ladder (weakest-to-strongest, mirrors SKILL.md's rules):
 *   1. straight wire        — pins share an axis, nothing between them
 *   2. L / Z wire           — stubs out of both pins, then orthogonal
 *   3. trunk wire           — a bus above/below the blocks, one drop per pin
 *   4. stub + net label     — same sheet, too far or unavoidably blocked
 *   5. stub + power flag    — nets declared with a power style
 *
 * Every path leaves its pin through a stub first: that is what keeps a route
 * from cutting across its own symbol, which is the failure mode that silently
 * shorts two nets together in the netlist.
 */

const G = require('./geom');

const STUB = 40;
const TRUNK_OFFSET = 60;
const LABEL_DISTANCE = 900; // mil: beyond this, prefer a label over a long wire

/** Unit vector pointing away from the component body at this pin tip.
 *  Derived from the pin's own stub geometry when available: the tip sits
 *  `length` beyond the pin base opposite the pin rotation, so the exit
 *  direction continues that way (then the placement rotation is applied).
 *  A large IC (60 mil wide, 700 mil tall) must not let the |dx| vs |dy|
 *  heuristic call a right-facing pin "vertical". */
function exitDir(pl, tip, pin) {
  if (pin && pin.length > 0) {
    const v = G.rotate(-Math.cos(((pin.rotation || 0) * Math.PI) / 180),
      -Math.sin(((pin.rotation || 0) * Math.PI) / 180), pl.rotation || 0);
    return { x: Math.abs(v.x) < 1e-9 ? 0 : Math.sign(v.x), y: Math.abs(v.y) < 1e-9 ? 0 : Math.sign(v.y) };
  }
  const dx = tip.x - pl.x;
  const dy = tip.y - pl.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) || -1 };
}

/** Collected connection points per net. */
function collectNodes(d, placements) {
  const nets = new Map();
  for (const pl of placements) {
    for (const pin of pl.sym.pins) {
      const net = pl.part.pins[String(pin.num)];
      if (!net) continue;
      const tip = G.pinTip(pin, pl.x, pl.y, pl.rotation || 0);
      if (!nets.has(net)) nets.set(net, []);
      nets.get(net).push({
        net,
        part: pl.part.id,
        pin: String(pin.num),
        tip,
        dir: exitDir(pl, tip, pin),
        placement: pl,
        sheet: pl.sheet || 1,
        block: pl.block ? pl.block.title : null
      });
    }
  }
  return nets;
}

function stubPoint(node) {
  return {
    x: G.round(node.tip.x + node.dir.x * STUB),
    y: G.round(node.tip.y + node.dir.y * STUB)
  };
}

function segHitsRect(seg, r) {
  const probes = [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => ({
    x: seg.x1 + (seg.x2 - seg.x1) * t,
    y: seg.y1 + (seg.y2 - seg.y1) * t
  }));
  return probes.some((p) => G.rectContains(r, p));
}

function countBlocked(segs, obstacles, ignore) {
  let n = 0;
  for (const seg of segs) {
    for (const o of obstacles) {
      if (ignore.has(o.part)) continue;
      if (segHitsRect(seg, G.expand(o.rect, 6))) n += 1;
    }
  }
  return n;
}

/**
 * Points a segment occupies: both ends plus the midpoint. Different nets must
 * never share one of these — the client treats a point on two wires as a
 * connection, which would silently merge two nets.
 */
function segPointKeys(seg) {
  const mid = { x: G.round((seg.x1 + seg.x2) / 2), y: G.round((seg.y1 + seg.y2) / 2) };
  return [
    `${G.round(seg.x1)},${G.round(seg.y1)}`,
    `${mid.x},${mid.y}`,
    `${G.round(seg.x2)},${G.round(seg.y2)}`
  ];
}

function countShared(segs, usedPoints) {
  let n = 0;
  for (const seg of segs) {
    for (const k of segPointKeys(seg)) if (usedPoints.has(k)) n += 1;
  }
  return n;
}

function scoreOf(route, obstacles, usedPoints, committedSegs, net) {
  // Only the MIDDLE of a route may be checked against part extents: the stubs
  // necessarily start right at their own symbol's pins. Everything else is a
  // bug waiting to short two nets together.
  const blocked = countBlocked(route.main, obstacles, new Set());
  const all = route.stubs.concat(route.main);
  const len = all.reduce((n, s) => n + G.segLen(s), 0);
  const shared = usedPoints ? countShared(all, usedPoints) : 0;
  // Contact with OTHER nets' committed segments — at ANY point along the
  // segment, not just the 3 sampled keys of `shared`: the client merges nets
  // wherever a wire touches another wire (T junction included), so at tight
  // layout density an unsampled touch silently shorts two nets. Same-net
  // contacts are legitimate junctions (MST edges meet at their stubs) and are
  // exempt. Any cross-net contact is reject-tier.
  let crossNet = 0;
  if (committedSegs && committedSegs.length) {
    for (const c of committedSegs) {
      if (c.net === net) continue;
      for (const s of all) {
        if (G.segsIntersect(s, c.seg, true)) crossNet += 1;
      }
    }
  }
  return {
    blocked,
    shared,
    len,
    bends: G.bends(all),
    crossNet,
    score: blocked * 1000000 + shared * 2000000 + crossNet * 2000000 + len + G.bends(all) * 40
  };
}

const pad = (n) => G.round(n);

/** Stub out of each pin, then the two stubs joined by an orthogonal path. */
function stubRoute(a, b, middle) {
  const pa = stubPoint(a);
  const pb = stubPoint(b);
  const stubs = [];
  if (Math.abs(pa.x - a.tip.x) > G.EPS || Math.abs(pa.y - a.tip.y) > G.EPS) {
    stubs.push({ x1: a.tip.x, y1: a.tip.y, x2: pa.x, y2: pa.y });
  }
  if (Math.abs(pb.x - b.tip.x) > G.EPS || Math.abs(pb.y - b.tip.y) > G.EPS) {
    stubs.push({ x1: pb.x, y1: pb.y, x2: b.tip.x, y2: b.tip.y });
  }
  const main = middle(pa, pb).filter((s) => G.segLen(s) > G.EPS);
  return { stubs: stubs.filter((s) => G.segLen(s) > G.EPS), main };
}

function flatten(route) {
  return route.stubs.concat(route.main);
}

function straight(pa, pb) {
  if (Math.abs(pa.x - pb.x) < G.EPS || Math.abs(pa.y - pb.y) < G.EPS) {
    return [{ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }];
  }
  return [];
}

function lPath(pa, pb) {
  const out = [];
  const c1 = { x: pb.x, y: pa.y };
  if (Math.abs(pa.x - c1.x) > G.EPS) out.push({ x1: pa.x, y1: pa.y, x2: c1.x, y2: c1.y });
  if (Math.abs(c1.y - pb.y) > G.EPS) out.push({ x1: c1.x, y1: c1.y, x2: pb.x, y2: pb.y });
  return out;
}

function lPath2(pa, pb) {
  const out = [];
  const c1 = { x: pa.x, y: pb.y };
  if (Math.abs(pa.y - c1.y) > G.EPS) out.push({ x1: pa.x, y1: pa.y, x2: c1.x, y2: c1.y });
  if (Math.abs(c1.x - pb.x) > G.EPS) out.push({ x1: c1.x, y1: c1.y, x2: pb.x, y2: pb.y });
  return out;
}

/** Route over (or under) everything: drop from each stub onto one horizontal bus. */
function trunkPath(pa, pb, busY) {
  const out = [];
  if (Math.abs(pa.y - busY) > G.EPS) out.push({ x1: pa.x, y1: pa.y, x2: pa.x, y2: busY });
  if (Math.abs(pb.y - busY) > G.EPS) out.push({ x1: pb.x, y1: pb.y, x2: pb.x, y2: busY });
  if (Math.abs(pa.x - pb.x) > G.EPS) out.push({ x1: pa.x, y1: busY, x2: pb.x, y2: busY });
  return out;
}

/** Z-shaped path through a horizontal channel at midY. */
function zPath(pa, pb, midY) {
  if (Math.abs(pa.y - midY) < G.EPS && Math.abs(pb.y - midY) < G.EPS) {
    return Math.abs(pa.x - pb.x) > G.EPS ? [{ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }] : [];
  }
  const out = [];
  if (Math.abs(pa.y - midY) > G.EPS) out.push({ x1: pa.x, y1: pa.y, x2: pa.x, y2: midY });
  if (Math.abs(pa.x - pb.x) > G.EPS) out.push({ x1: pa.x, y1: midY, x2: pb.x, y2: midY });
  if (Math.abs(pb.y - midY) > G.EPS) out.push({ x1: pb.x, y1: midY, x2: pb.x, y2: pb.y });
  return out;
}

/** All candidate routes between two nodes, cheapest first. */
function bestRoute(a, b, obstacles, usedPoints, committedSegs) {
  const makers = [
    (pa, pb) => straight(pa, pb),
    lPath,
    lPath2
  ];
  const candidates = [];
  for (const m of makers) candidates.push(stubRoute(a, b, m));

  // Z candidates through a few horizontal channels: the straight-L forms only
  // hug one of the two endpoints' rows; mid channels give the router a way to
  // slip between rows instead of wrapping around everything.
  const pa0 = stubPoint(a);
  const pb0 = stubPoint(b);
  const midY = Math.round((pa0.y + pb0.y) / 2);
  for (const my of [midY, midY - STUB, midY + STUB]) {
    candidates.push(stubRoute(a, b, (pa, pb) => zPath(pa, pb, my)));
  }

  // Trunk candidates: one bus above and one below every obstacle on the sheet,
  // stepped per net via `usedPoints` scoring so two nets never share a bus.
  const ys = obstacles.map((o) => [o.rect.y1, o.rect.y2]);
  if (ys.length) {
    const top = Math.max(...ys.map((y) => y[1])) + TRUNK_OFFSET;
    const bottom = Math.min(...ys.map((y) => y[0])) - TRUNK_OFFSET;
    for (let k = 0; k < 4; k += 1) {
      for (const busY of [top + k * 24, bottom - k * 24]) {
        candidates.push(stubRoute(a, b, (pa, pb) => trunkPath(pa, pb, busY)));
      }
    }
  }

  const pa = stubPoint(a);
  const pb = stubPoint(b);
  const coincident = Math.abs(pa.x - pb.x) < G.EPS && Math.abs(pa.y - pb.y) < G.EPS;

  let best = null;
  for (const route of candidates) {
    if (!flatten(route).length) continue;
    // A candidate with an EMPTY middle does not connect anything: it is two
    // stubs that are cheaper than every real path, so it would win every time
    // and silently leave the net in two pieces. Accept it only when the two
    // stub points are literally the same point.
    if (!route.main.length && !coincident) continue;
    const s = scoreOf(route, obstacles, usedPoints, committedSegs, a.net);
    if (!best || s.score < best.score) best = Object.assign({ route }, s);
  }
  return best;
}

/** Manhattan MST (Prim) over node tips. */
function manhattanMst(nodes) {
  if (nodes.length < 2) return [];
  const inTree = [0];
  const out = [];
  const dist = (a, b) => Math.abs(a.tip.x - b.tip.x) + Math.abs(a.tip.y - b.tip.y);
  const rest = new Set(nodes.map((_, i) => i));
  rest.delete(0);
  while (rest.size) {
    let best = null;
    for (const i of inTree) {
      for (const j of rest) {
        const d = dist(nodes[i], nodes[j]);
        if (!best || d < best.d) best = { i, j, d };
      }
    }
    if (!best) break;
    out.push([nodes[best.i], nodes[best.j]]);
    inTree.push(best.j);
    rest.delete(best.j);
  }
  return out;
}

function segKey(s) {
  const a = `${G.round(s.x1)},${G.round(s.y1)}`;
  const b = `${G.round(s.x2)},${G.round(s.y2)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function overlapsAny(rect, obstacles, ignore) {
  return obstacles.some((o) => !ignore.has(o.part) && G.rectsOverlap(rect, G.expand(o.rect, 6)));
}

function labelEncoding(nodes, net, issues, why, ctx) {
  const wires = [];
  const labels = [];
  const committed = (ctx && ctx.committedSegs) || [];
  const used = (ctx && ctx.usedPoints) || null;
  for (const node of nodes) {
    // already connected to this net by an earlier edge? then the wire carries
    // the NET attr already — a second stub would only duplicate it
    if (committed.some((c) => c.net === net && G.pointSegDist(node.tip, c.seg) < 0.01)) continue;
    // Adaptive stub: facing pins of DIFFERENT nets sit close together at
    // tight layout — a fixed 40 mil stub from both sides meets in the middle
    // and the client merges the two nets at that contact. Try 40 → 10 and
    // keep the longest stub with no CROSS-NET contact (labels may sit right
    // at the hotspot as a last resort). A same-net collision (this net's
    // other edge already drew that stub) is not an error — it just looks
    // like a duplicate, so prefer a shorter distinct stub when one exists.
    const crossClash = (seg) => committed.some((c) => c.net !== net && G.segsIntersect(seg, c.seg, true));
    const sameClash = (seg) => committed.some((c) => c.net === net && G.segsIntersect(seg, c.seg, true));
    if (process.env.SCH_ROUTE_DEBUG) console.error('ADAPTIVE', net, node.part+'.'+node.pin, 'tip', node.tip.x+','+node.tip.y, 'committed', committed.length);
    let chosen = null;
    for (const len of [STUB, 30, 20, 10]) {
      const seg = {
        x1: node.tip.x, y1: node.tip.y,
        x2: G.round(node.tip.x + node.dir.x * len),
        y2: G.round(node.tip.y + node.dir.y * len)
      };
      const xclash = crossClash(seg), sclash = sameClash(seg);
      if (process.env.SCH_ROUTE_DEBUG) console.error('  ADAPTIVE', net, node.part + '.' + node.pin, 'len', len, 'cross', xclash, 'same', sclash);
      if (!crossClash(seg) && !sameClash(seg)) { chosen = seg; break; }
      if (!chosen && !crossClash(seg)) chosen = seg;   // cross-net-clean fallback
    }
    if (!chosen) {
      // last resort: a short jog — 10 along the pin, then 20 perpendicular
      const first = { x1: node.tip.x, y1: node.tip.y, x2: G.round(node.tip.x + node.dir.x * 10), y2: G.round(node.tip.y + node.dir.y * 10) };
      const second = { x1: first.x2, y1: first.y2, x2: first.x2, y2: first.y2 + 20 };
      const jogClash = crossClash(first) || crossClash(second);
      chosen = second;
      if (jogClash) issues.push(`net "${net}": stub for ${node.part}.${node.pin} could not avoid neighbouring wires — check the label placement`);
      wires.push([first]);
      commitSegs([first], net, used, committed);
    }
    if (Math.abs(chosen.x2 - node.tip.x) > G.EPS || Math.abs(chosen.y2 - node.tip.y) > G.EPS) {
      wires.push([chosen]);
    }
    labels.push({ net, x: chosen.x2, y: chosen.y2 });
  }
  if (why) issues.push(why);
  return { wires, labels };
}

function commitSegs(segs, net, usedPoints, committedSegs) {
  for (const seg of segs) {
    if (usedPoints) for (const k of segPointKeys(seg)) usedPoints.add(k);
    if (committedSegs) committedSegs.push({ seg, net });
  }
}

/**
 * Route one net. Returns { wires:[[segs]], flags:[], labels:[], issues:[] }.
 */
function routeNet(net, nodes, ctx) {
  const wires = [];
  const flags = [];
  const labels = [];
  const ports = [];
  const issues = [];
  const obstacles = ctx.obstacles;
  const used = ctx.usedPoints;
  const committed = ctx.committedSegs || (ctx.committedSegs = []);
  const style = ctx.powerStyle(net);

  if (style) {
    for (const node of nodes) {
      const ignore = new Set([node.part]);
      // adaptive flag placement: the stub wire must not touch a foreign net's
      // committed segments at ANY point (collinear overlap included — the
      // client merges nets at any contact), the flag symbol must not sit on a
      // foreign flag, and stub points must be free. Lengths 40 → 10, then a
      // jog, then the flag sits directly on the pin (the netlist unions
      // co-located pins).
      const wireClash = (seg) => committed.some((c) => c.net !== net && G.segsIntersect(seg, c.seg, true))
        || (used && segPointKeys(seg).some((key) => used.has(key)));
      const flagClash = (pos) => (ctx.flagPoints || []).some((f) => f.net !== net
        && (Math.hypot(f.x - pos.x, f.y - pos.y) < 30
          || G.segsIntersect({ x1: node.tip.x, y1: node.tip.y, x2: pos.x, y2: pos.y }, { x1: f.x, y1: f.y, x2: f.x, y2: f.y }, true)));
      let placed = null;
      let wire = null;
      for (const len of [STUB, 30, 20, 10]) {
        const pos = {
          x: G.round(node.tip.x + node.dir.x * len),
          y: G.round(node.tip.y + node.dir.y * len)
        };
        const seg = { x1: node.tip.x, y1: node.tip.y, x2: pos.x, y2: pos.y };
        const box = G.rect(pos.x - 12, pos.y - 22, pos.x + 12, pos.y + 22);
        if (!wireClash(seg) && !flagClash(pos) && !overlapsAny(box, obstacles, ignore)) {
          placed = pos;
          wire = seg;
          break;
        }
      }
      if (!placed) {
        // jog: 10 along the pin, then 20 perpendicular, flag at the corner end
        const first = { x1: node.tip.x, y1: node.tip.y, x2: G.round(node.tip.x + node.dir.x * 10), y2: G.round(node.tip.y + node.dir.y * 10) };
        const second = { x1: first.x2, y1: first.y2, x2: first.x2, y2: first.y2 + 20 };
        const pos = { x: second.x2, y: second.y2 };
        const box = G.rect(pos.x - 12, pos.y - 22, pos.x + 12, pos.y + 22);
        const jogClash = wireClash(first) || wireClash(second) || flagClash(pos) || overlapsAny(box, obstacles, ignore);
        placed = pos;
        wire = first;
        wires.push([second]);
        commitSegs([second], net, used, committed);
        if (jogClash) issues.push(`net "${net}": power flag for ${node.part}.${node.pin} placed on the pin — check for neighbouring wires/flags`);
      }
      flags.push({ net, x: placed.x, y: placed.y, style });
      (ctx.flagPoints || []).push({ net, x: placed.x, y: placed.y });
      if (wire && (Math.abs(wire.x2 - node.tip.x) > G.EPS || Math.abs(wire.y2 - node.tip.y) > G.EPS)) {
        wires.push([wire]);
        commitSegs([wire], net, used, committed);
      }
    }
    return { wires, flags, labels, ports, issues };
  }

  // ------------------------------------------------- connector encoding
  // The human pattern (hand-drawn esp32-s31 sample): signals that cross module
  // boundaries are NEVER routed as long wires — every pin gets a short stub +
  // a named net-port connector, and the netlist merges by name. Long wires are
  // the source of every 弯绕/交叉 problem; only SHORT local same-block nets
  // deserve visible wires.
  const blocksOf = new Set(nodes.map((n) => n.block));
  const xs = nodes.map((n) => n.tip.x), ys = nodes.map((n) => n.tip.y);
  const span = (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
  if (blocksOf.size > 1 || span > 500) {
    for (const node of nodes) {
      const foreign = committed.filter((c) => c.net !== net);
      let chosen = null;
      for (const len of [STUB, 30, 20, 10]) {
        const seg = {
          x1: node.tip.x, y1: node.tip.y,
          x2: G.round(node.tip.x + node.dir.x * len),
          y2: G.round(node.tip.y + node.dir.y * len)
        };
        const pos = { x: seg.x2, y: seg.y2 };
        const box = G.rect(pos.x - 14, pos.y - 12, pos.x + 14, pos.y + 12);
        const wireHit = foreign.some((c) => G.segsIntersect(seg, c.seg, true))
          || (used && segPointKeys(seg).some((key) => used.has(key)));
        const portHit = (ctx.portPoints || []).some((f) => f.net !== net
          && (Math.hypot(f.x - pos.x, f.y - pos.y) < 34 || G.segsIntersect(seg, { x1: f.x, y1: f.y, x2: f.x, y2: f.y }, true)));
        const partHit = overlapsAny(box, ctx.obstacles, new Set([node.part]));
        if (!wireHit && !portHit && !partHit) { chosen = seg; break; }
      }
      if (!chosen) {
        // last resort: the port sits directly ON the hotspot — the netlist
        // unions co-located pins, so this stays electrically clean without a
        // wire that could touch a foreign net
        chosen = { x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y };
      }
      if (Math.abs(chosen.x2 - node.tip.x) > G.EPS || Math.abs(chosen.y2 - node.tip.y) > G.EPS) {
        wires.push([chosen]);
        commitSegs([chosen], net, used, committed);
      }
      ports.push({ net, x: chosen.x2, y: chosen.y2, sheet: node.sheet || 1 });
    }
    return { wires, flags, labels, ports, issues };
  }

    if (nodes.length === 1) {
    // NC/DNC nets are the deliberate no-connect convention — encode silently.
    const isNC = /^(NC|DNC\d*)$/i.test(net);
    const enc = labelEncoding(nodes, net, issues, isNC ? null : null, ctx);
    enc.wires.forEach((w) => commitSegs(w, net, used, committed));
    return { wires: enc.wires, flags, labels: enc.labels, ports, issues };
  }

  if (/^(NC|DNC\d*)$/i.test(net)) {
    // Several pins may share the NC name; they are NOT connected to each
    // other — wiring them (MST) would short every no-connected pin together.
    // Each pin gets its own stub + NC label instead.
    const enc = labelEncoding(nodes, net, issues, null);
    enc.wires.forEach((w) => commitSegs(w, net, used, committed));
    return { wires: enc.wires, flags, labels: enc.labels, ports, issues };
  }

  const edges = manhattanMst(nodes);
  for (const [a, b] of edges) {
    const ignore = new Set([a.part, b.part]);
    const manhattan = Math.abs(a.tip.x - b.tip.x) + Math.abs(a.tip.y - b.tip.y);
    if (a.block !== b.block && manhattan > LABEL_DISTANCE) {
      const enc = labelEncoding([a, b], net, issues, null, ctx);
      enc.wires.forEach((w) => commitSegs(w, net, used, committed));
      wires.push(...enc.wires);
      labels.push(...enc.labels);
      continue;
    }
    const best = bestRoute(a, b, obstacles, used, committed);
    if (!best || best.blocked > 0 || best.shared > 0 || best.crossNet > 0) {
      const enc = labelEncoding([a, b], net, issues,
        `net "${net}": ${a.part}.${a.pin} → ${b.part}.${b.pin} has no clear route → encoded as stub+label`, ctx);
      enc.wires.forEach((w) => commitSegs(w, net, used, committed));
      wires.push(...enc.wires);
      labels.push(...enc.labels);
      continue;
    }
    const segs = flatten(best.route);
    wires.push(segs);
    commitSegs(segs, net, used, committed);
  }
  return { wires, flags, labels, ports, issues };
}

/**
 * Route every net. Power nets get flags, everything else gets wires/labels.
 * A shared point registry keeps two nets from ever touching.
 */
function routeSchematic(d, placements) {
  const out = { wires: [], flags: [], labels: [], ports: [], issues: [] };
  // Per-sheet routing: sheets are independent coordinate spaces (obstacles
  // and the shared-point registry never cross sheets). A net whose pins sit
  // on MORE THAN ONE sheet is a cross-sheet net — each sheet gets its own
  // stub + net port (the netlist merges ports by name globally).
  const sheets = [...new Set(placements.map((p) => p.sheet || 1))].sort((a, b) => a - b);
  let totalNets = 0;
  for (const sheet of sheets) {
    const pls = placements.filter((p) => (p.sheet || 1) === sheet);
    const ctx = {
      obstacles: pls.map((pl) => ({ part: pl.part.id, rect: pl.extent })),
      usedPoints: new Set(),
      committedSegs: [],
      flagPoints: [],
      powerStyle: (net) => d.powerNets.get(net) || null
    };
    const nets = collectNodes(d, pls);
    totalNets += nets.size;
    for (const [net, nodes] of nets) {
      const onSheets = new Set(nodes.map((n) => n.sheet || 1));
      if (onSheets.size > 1) {
        // cross-sheet: every node gets its own stub + net port
        for (const node of nodes) {
          const p = stubPoint(node);
          if (Math.abs(p.x - node.tip.x) > G.EPS || Math.abs(p.y - node.tip.y) > G.EPS) {
            const segs = [{ x1: node.tip.x, y1: node.tip.y, x2: p.x, y2: p.y }];
            out.wires.push({ net, sheet, segs });
            commitSegs(segs, net, ctx.usedPoints, ctx.committedSegs);
          }
          out.ports.push({ net, x: p.x, y: p.y, sheet });
        }
        continue;
      }
      const r = routeNet(net, nodes, ctx);
      for (const segs of r.wires) {
        const seen = new Set();
        const clean = segs.filter((s) => {
          if (G.segLen(s) < G.EPS) return false;
          const k = segKey(s);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (clean.length) out.wires.push({ net, sheet, segs: clean });
      }
      out.flags.push(...r.flags.map((f) => Object.assign({ sheet }, f)));
      out.ports.push(...r.ports.map((p) => Object.assign({ sheet }, p)));
      out.labels.push(...r.labels);
      out.issues.push(...r.issues);
    }
  }
  out.stats = {
    nets: totalNets,
    sheets: sheets.length,
    wires: out.wires.length,
    segments: out.wires.reduce((n, w) => n + w.segs.length, 0),
    flags: out.flags.length,
    labels: out.labels.length,
    ports: out.ports.length
  };
  return out;
}

module.exports = {
  STUB,
  TRUNK_OFFSET,
  LABEL_DISTANCE,
  routeSchematic,
  routeNet,
  collectNodes,
  manhattanMst,
  exitDir,
  stubPoint
};
