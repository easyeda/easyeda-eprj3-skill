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

/** Other nets' flag/port/pin points that a route must not touch. */
function foreignContacts(segs, ctx, net) {
  let n = 0;
  const flags = ctx.flagPoints || [];
  const ports = ctx.portPoints || [];
  const pins = ctx.pinPoints || [];
  // exact contact only — matching countCrossNetContacts (the client merges two
  // nets only when a wire touches a flag/port/pin point). A wider threshold here
  // over-rejects routes that merely pass NEAR a flag and needlessly degrades
  // every short net into stub+label.
  for (const f of flags) {
    if (f.net === net) continue;
    for (const s of segs) if (G.pointSegDist({ x: f.x, y: f.y }, s) < 0.01) n += 1;
  }
  for (const p of ports) {
    if (p.net === net) continue;
    for (const s of segs) if (G.pointSegDist({ x: p.x, y: p.y }, s) < 0.01) n += 1;
  }
  for (const p of pins) {
    if (p.net === net) continue;
    for (const s of segs) if (G.pointSegDist({ x: p.x, y: p.y }, s) < 0.01) n += 1;
  }
  return n;
}

function scoreOf(route, obstacles, usedPoints, committedSegs, net, ctx) {
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
  // Foreign flags/ports/pins: a trunk drawn THROUGH another net's power flag,
  // net port or (not-yet-wired) pin shorts two nets, so reject-tier too.
  const foreign = ctx ? foreignContacts(all, ctx, net) : 0;
  return {
    blocked,
    shared,
    len,
    bends: G.bends(all),
    crossNet: crossNet + foreign,
    score: blocked * 1000000 + shared * 2000000 + (crossNet + foreign) * 2000000 + len + G.bends(all) * 40
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
function bestRoute(a, b, obstacles, usedPoints, committedSegs, ctx) {
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
    const s = scoreOf(route, obstacles, usedPoints, committedSegs, a.net, ctx);
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
      if (crossClash(first)) {
        // The pin's exit direction is blocked by a facing foreign wire (two
        // pins of different nets meet in the middle). A label alone would not
        // connect the pin (the netlist only unions a pin where a WIRE endpoint
        // lands on it), so step PERPENDICULAR straight from the tip instead —
        // any clean stub carries the net name and connects the pin.
        let alt = null;
        for (const pd of [{ x: node.dir.y, y: -node.dir.x }, { x: -node.dir.y, y: node.dir.x }]) {
          for (const len of [20, 30]) {
            const s = { x1: node.tip.x, y1: node.tip.y, x2: G.round(node.tip.x + pd.x * len), y2: G.round(node.tip.y + pd.y * len) };
            if (!crossClash(s) && !sameClash(s)) { alt = s; break; }
          }
          if (alt) break;
        }
        if (alt) {
          chosen = alt;
        } else {
          chosen = { x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y };
          issues.push(`net "${net}": pin ${node.part}.${node.pin} has no clean exit — check for neighbouring wires/flags`);
        }
      } else {
        chosen = second;
        if (crossClash(second)) issues.push(`net "${net}": stub for ${node.part}.${node.pin} could not avoid neighbouring wires — check the label placement`);
        wires.push([first]);
        commitSegs([first], net, used, committed);
      }
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

/** Group a net's nodes by their block title (deterministic order). */
function groupByBlock(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const b = node.block || '';
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(node);
  }
  return [...groups.values()].sort((a, b) => (a[0].block || '').localeCompare(b[0].block || ''));
}

/**
 * N-node trunk polyline: every pin escapes to its stub point, then drops onto
 * one shared horizontal spine at `busY`. Returns {stubs, main} (same shape as
 * stubRoute) so scoreOf/flatten see it unchanged.
 */
function trunkNetPathH(nodes, busY) {
  const stubs = [];
  const main = [];
  const xs = [];
  for (const node of nodes) {
    const p = stubPoint(node);
    if (Math.abs(p.x - node.tip.x) > G.EPS || Math.abs(p.y - node.tip.y) > G.EPS) {
      stubs.push({ x1: node.tip.x, y1: node.tip.y, x2: p.x, y2: p.y });
    }
    if (Math.abs(p.y - busY) > G.EPS) main.push({ x1: p.x, y1: p.y, x2: p.x, y2: busY });
    xs.push(p.x);
  }
  if (xs.length) {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (hi - lo > G.EPS) main.push({ x1: lo, y1: busY, x2: hi, y2: busY });
  }
  return { stubs: stubs.filter((s) => G.segLen(s) > G.EPS), main: main.filter((s) => G.segLen(s) > G.EPS) };
}

/** N-node trunk polyline onto one shared vertical spine at `busX`. */
function trunkNetPathV(nodes, busX) {
  const stubs = [];
  const main = [];
  const ys = [];
  for (const node of nodes) {
    const p = stubPoint(node);
    if (Math.abs(p.x - node.tip.x) > G.EPS || Math.abs(p.y - node.tip.y) > G.EPS) {
      stubs.push({ x1: node.tip.x, y1: node.tip.y, x2: p.x, y2: p.y });
    }
    if (Math.abs(p.x - busX) > G.EPS) main.push({ x1: p.x, y1: p.y, x2: busX, y2: p.y });
    ys.push(p.y);
  }
  if (ys.length) {
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    if (hi - lo > G.EPS) main.push({ x1: busX, y1: lo, x2: busX, y2: hi });
  }
  return { stubs: stubs.filter((s) => G.segLen(s) > G.EPS), main: main.filter((s) => G.segLen(s) > G.EPS) };
}

/**
 * Best clean trunk for a ≥3-pin group: enumerate horizontal spines above/below
 * every obstacle and vertical spines left/right of them, score each by the same
 * cost model as bestRoute, and return the cheapest (caller still checks the
 * blocked/shared/crossNet flags — a trunk may simply not fit).
 */
function bestTrunkRoute(nodes, net, ctx) {
  const obstacles = ctx.obstacles;
  const used = ctx.usedPoints;
  const committed = ctx.committedSegs;
  const candidates = [];
  // LOCAL candidates first: a trunk near the net's own nodes keeps the drops
  // short. A whole-sheet edge trunk forces a long vertical drop that sweeps
  // across other pins/flags (the crystal XIN-vs-GND collinear contact).
  const nys = nodes.map((n) => n.tip.y);
  const nxs = nodes.map((n) => n.tip.x);
  const yTop = Math.min(...nys);
  const yBot = Math.max(...nys);
  const xLft = Math.min(...nxs);
  const xRgt = Math.max(...nxs);
  for (const busY of [yTop - 30, yBot + 30, Math.round((yTop + yBot) / 2), yTop - 60, yBot + 60]) {
    candidates.push(trunkNetPathH(nodes, busY));
  }
  for (const busX of [xLft - 30, xRgt + 30, Math.round((xLft + xRgt) / 2), xLft - 60, xRgt + 60]) {
    candidates.push(trunkNetPathV(nodes, busX));
  }
  // sheet-edge trunks as a fallback (clear of every part, at the cost of long
  // drops) — still useful when the local channels are all blocked.
  const ys = obstacles.map((o) => [o.rect.y1, o.rect.y2]);
  if (ys.length) {
    const top = Math.max(...ys.map((y) => y[1])) + TRUNK_OFFSET;
    const bottom = Math.min(...ys.map((y) => y[0])) - TRUNK_OFFSET;
    for (let k = 0; k < 3; k += 1) {
      for (const busY of [top + k * 24, bottom - k * 24]) candidates.push(trunkNetPathH(nodes, busY));
    }
  }
  const xs = obstacles.map((o) => [o.rect.x1, o.rect.x2]);
  if (xs.length) {
    const right = Math.max(...xs.map((x) => x[1])) + TRUNK_OFFSET;
    const left = Math.min(...xs.map((x) => x[0])) - TRUNK_OFFSET;
    for (let k = 0; k < 3; k += 1) {
      for (const busX of [right + k * 24, left - k * 24]) candidates.push(trunkNetPathV(nodes, busX));
    }
  }
  let best = null;
  for (const route of candidates) {
    if (!flatten(route).length) continue;
    const s = scoreOf(route, obstacles, used, committed, net, ctx);
    if (!best || s.score < best.score) best = Object.assign({ route }, s);
  }
  return best;
}

/**
 * Route one block's sub-net (same block, same sheet). ≥3 pins try a shared
 * trunk first; fall back to an MST of per-edge bestRoute, then to stub+label.
 * Commits every emitted segment so the cross-net contact safety net sees it.
 */
function routeGroup(nodes, net, ctx, issues) {
  const out = { wires: [], labels: [] };
  const obstacles = ctx.obstacles;
  const used = ctx.usedPoints;
  const committed = ctx.committedSegs;
  let segs = null;
  if (nodes.length >= 3) {
    // Trunk only for HORIZONTAL-dominant nets: a vertical stack of pins needs a
    // long vertical spine that sweeps across other pins/flags (the crystal
    // XIN-vs-GND collinear contact). Vertical-dominant nets keep the MST of
    // short per-edge L/Z routes instead.
    const nxs = nodes.map((n) => n.tip.x);
    const nys = nodes.map((n) => n.tip.y);
    const xSpan = Math.max(...nxs) - Math.min(...nxs);
    const ySpan = Math.max(...nys) - Math.min(...nys);
    if (xSpan >= ySpan) {
      const tr = bestTrunkRoute(nodes, net, ctx);
      if (tr && tr.blocked === 0 && tr.shared === 0 && tr.crossNet === 0) segs = flatten(tr.route);
    }
  }
  if (segs && segs.length) {
    commitSegs(segs, net, used, committed);
    out.wires.push(segs);
    return out;
  }
  const edges = manhattanMst(nodes);
  for (const [a, b] of edges) {
    const best = bestRoute(a, b, obstacles, used, committed, ctx);
    if (!best || best.blocked > 0 || best.shared > 0 || best.crossNet > 0) {
      const enc = labelEncoding([a, b], net, issues,
        `net "${net}": ${a.part}.${a.pin} → ${b.part}.${b.pin} has no clear route → encoded as stub+label`, ctx);
      enc.wires.forEach((w) => commitSegs(w, net, used, committed));
      out.wires.push(...enc.wires);
      out.labels.push(...enc.labels);
      continue;
    }
    const fs = flatten(best.route);
    commitSegs(fs, net, used, committed);
    out.wires.push(fs);
  }
  return out;
}

/** Adaptive stub + net-port for a lone node (mirrors the old connector path). */
function placeNodePort(node, net, ctx) {
  const committed = ctx.committedSegs;
  const used = ctx.usedPoints;
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
    // a net port dropped onto another net's (not-yet-wired) pin tip shorts the
    // two nets when that pin's stub is later drawn there
    const pinHit = (ctx.pinPoints || []).some((f) => f.net !== net && G.pointSegDist({ x: f.x, y: f.y }, seg) < 0.01);
    const partHit = overlapsAny(box, ctx.obstacles, new Set([node.part]));
    if (!wireHit && !portHit && !pinHit && !partHit) { chosen = seg; break; }
  }
  if (!chosen) chosen = { x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y };
  const wire = (Math.abs(chosen.x2 - node.tip.x) > G.EPS || Math.abs(chosen.y2 - node.tip.y) > G.EPS) ? [chosen] : [];
  return { wire, port: { net, x: chosen.x2, y: chosen.y2 } };
}

/**
 * Route a non-power, non-NC signal net with ≥2 nodes, block-aware (report
 * §5.2/§5.3/§8.2): same-block pins are wired with a visible trunk, and a net
 * spanning multiple blocks crosses each boundary with ONE net-port per block.
 * Returns { wires:[[segs]], labels:[], ports:[], issues:[] }.
 */
function routeSignalNet(net, nodes, ctx) {
  const wires = [];
  const labels = [];
  const ports = [];
  const issues = [];
  const used = ctx.usedPoints;
  const committed = ctx.committedSegs;
  const groups = groupByBlock(nodes);
  const multiBlock = groups.length > 1;

  for (const G of groups) {
    if (G.length === 1) {
      if (multiBlock) {
        const pr = placeNodePort(G[0], net, ctx);
        if (pr.wire.length) { wires.push(pr.wire); commitSegs(pr.wire, net, used, committed); }
        ports.push(pr.port);
      }
      continue; // lone node on a single-block net is handled by the caller
    }
    const segs = routeGroup(G, net, ctx, issues);
    wires.push(...segs.wires);
    labels.push(...segs.labels);
    if (multiBlock) {
      // one port per block, anchored on the group's first stub (already on the
      // trunk for ≥2 pins) — the netlist merges ports by name across blocks
      const p = stubPoint(G[0]);
      ports.push({ net, x: p.x, y: p.y });
    }
  }
  return { wires, flags: [], labels, ports, issues };
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
        // the stub must also clear every foreign pin tip and net port: a flag
        // drawn THROUGH another net's port or (not-yet-wired) pin shorts two
        // nets the moment that net's stub is later drawn there.
        const foreign = foreignContacts([seg], ctx, net);
        if (!wireClash(seg) && !flagClash(pos) && foreign === 0 && !overlapsAny(box, obstacles, ignore)) {
          placed = pos;
          wire = seg;
          break;
        }
      }
      if (!placed) {
        // jog: 10 along the pin, then lateral (perpendicular) up to 20/40 on
        // either side — a long trunk drop blocks the straight exit, so the flag
        // must step off that column (crystal XIN-vs-GND collinear contact).
        const first = { x1: node.tip.x, y1: node.tip.y, x2: G.round(node.tip.x + node.dir.x * 10), y2: G.round(node.tip.y + node.dir.y * 10) };
        const perps = [{ x: node.dir.y, y: -node.dir.x }, { x: -node.dir.y, y: node.dir.x }];
        let second = null;
        let pos = null;
        let clean = false;
        for (const pd of perps) {
          for (const len of [20, 40]) {
            const seg2 = { x1: first.x2, y1: first.y2, x2: G.round(first.x2 + pd.x * len), y2: G.round(first.y2 + pd.y * len) };
            const p2 = { x: seg2.x2, y: seg2.y2 };
            const box = G.rect(p2.x - 12, p2.y - 22, p2.x + 12, p2.y + 22);
            if (!wireClash(first) && !wireClash(seg2) && !flagClash(p2) && foreignContacts([first, seg2], ctx, net) === 0 && !overlapsAny(box, obstacles, ignore)) {
              second = seg2; pos = p2; clean = true;
              break;
            }
          }
          if (clean) break;
        }
        if (clean) {
          placed = pos;
          wire = first;
          wires.push([second]);
          commitSegs([second], net, used, committed);
        } else {
          // no clean exit: the flag sits directly ON the pin — co-located, so the
          // netlist unions it as a connection. Never emit a clashing lateral stub
          // (that would short the pin to a foreign net).
          placed = { x: node.tip.x, y: node.tip.y };
          wire = null;
          issues.push(`net "${net}": power flag for ${node.part}.${node.pin} placed on the pin — check for neighbouring wires/flags`);
        }
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

  // ------------------------------------------------- signal routing
  // NC nets are the deliberate no-connect convention: several pins may share
  // the name but must NOT be wired together — each gets its own stub + label.
  if (/^(NC|DNC\d*)$/i.test(net)) {
    const enc = labelEncoding(nodes, net, issues, null, ctx);
    enc.wires.forEach((w) => commitSegs(w, net, used, committed));
    return { wires: enc.wires, flags, labels: enc.labels, ports, issues };
  }

  if (nodes.length === 1) {
    const enc = labelEncoding(nodes, net, issues, null, ctx);
    enc.wires.forEach((w) => commitSegs(w, net, used, committed));
    return { wires: enc.wires, flags, labels: enc.labels, ports, issues };
  }

  const sig = routeSignalNet(net, nodes, ctx);
  return { wires: sig.wires, flags, labels: sig.labels, ports: sig.ports, issues: sig.issues };
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
  // A net is cross-sheet when its pins are not all on one page. This must be
  // computed over the WHOLE design: collectNodes() below is called per sheet
  // and can only ever see one page, so a per-sheet `onSheets.size > 1` test
  // never fires (it was dead code, and cross-sheet pins silently fell through
  // to single-sheet routing).
  const crossSheet = new Set();
  for (const [net, nodes] of collectNodes(d, placements)) {
    if (new Set(nodes.map((n) => n.sheet || 1)).size > 1) crossSheet.add(net);
  }
  let totalNets = 0;
  for (const sheet of sheets) {
    const pls = placements.filter((p) => (p.sheet || 1) === sheet);
    const nets = collectNodes(d, pls);
    totalNets += nets.size;
    // every pin tip on this sheet (with its net) — the router must not draw a
    // trunk THROUGH another net's not-yet-wired pin (a later stub would cross it)
    const pinPoints = [];
    for (const [net, nodes] of nets) {
      for (const n of nodes) pinPoints.push({ net, x: n.tip.x, y: n.tip.y });
    }
    const ctx = {
      obstacles: pls.map((pl) => ({ part: pl.part.id, rect: pl.extent })),
      usedPoints: new Set(),
      committedSegs: [],
      flagPoints: [],
      portPoints: [],
      pinPoints,
      powerStyle: (net) => d.powerNets.get(net) || null
    };
    for (const [net, nodes] of nets) {
      // Power nets keep their flags on every sheet (routeNet handles them) —
      // turning GND into a port would drop the flag convention for nothing.
      // NC nets are the deliberate no-connect convention even across sheets:
      // they must never get a net port (a port merges them into one net), so
      // fall through to routeNet's labelEncoding stub+label path instead.
      if (crossSheet.has(net) && !ctx.powerStyle(net) && !/^(NC|DNC\d*)$/i.test(net)) {
        // cross-sheet: every node on THIS sheet gets its own stub + net port.
        // The stub must clear foreign committed wires AND every foreign pin
        // tip / port (a port dropped onto another net's wire shorts them); if
        // no clean stub fits, the port sits directly on the pin tip.
        for (const node of nodes) {
          const p = stubPoint(node);
          const hasStub = Math.abs(p.x - node.tip.x) > G.EPS || Math.abs(p.y - node.tip.y) > G.EPS;
          const seg = { x1: node.tip.x, y1: node.tip.y, x2: p.x, y2: p.y };
          const wireHit = hasStub && ctx.committedSegs.some((c) => c.net !== net && G.segsIntersect(seg, c.seg, true));
          const foreign = hasStub ? foreignContacts([seg], ctx, net) : 0;
          if (hasStub && !wireHit && foreign === 0) {
            out.wires.push({ net, sheet, segs: [seg] });
            commitSegs([seg], net, ctx.usedPoints, ctx.committedSegs);
            out.ports.push({ net, x: p.x, y: p.y, sheet });
            ctx.portPoints.push({ net, x: p.x, y: p.y });
          } else {
            out.ports.push({ net, x: node.tip.x, y: node.tip.y, sheet });
            ctx.portPoints.push({ net, x: node.tip.x, y: node.tip.y });
          }
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
      for (const p of r.ports) ctx.portPoints.push({ net: p.net, x: p.x, y: p.y });
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

/**
 * Count places where wires/ports of DIFFERENT nets touch — the client merges
 * nets at any contact, so a non-zero count means the drawn sheet would be
 * electrically wrong (shorted nets). The builder treats it as a hard failure
 * after retrying with a looser layout grid (report P2: tight cells let two
 * nets' stubs meet).
 */
function countCrossNetContacts(routed) {
  // Sheets are independent coordinate spaces (separate .esch2 documents): a
  // segment on P1 can never merge with a segment on P2, however their global
  // coordinates overlap. Comparing them would reject every multi-sheet design.
  const segs = [];
  for (const w of routed.wires || []) {
    for (const s of w.segs || []) segs.push({ net: w.net, sheet: w.sheet || 1, s });
  }
  const hits = [];
  let n = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].sheet !== segs[j].sheet) continue;
      if (segs[i].net === segs[j].net) continue;
      if (G.segsIntersect(segs[i].s, segs[j].s, true)) { n += 1; hits.push({ a: segs[i].net, b: segs[j].net, s1: segs[i].s, s2: segs[j].s, sheet: segs[i].sheet }); }
    }
  }
  for (const p of routed.ports || []) {
    for (const sg of segs) {
      if (sg.sheet !== (p.sheet || 1)) continue;
      if (sg.net === p.net) continue;
      if (G.pointSegDist({ x: p.x, y: p.y }, sg.s) < 0.01) { n += 1; hits.push({ a: `port(${p.net})`, b: sg.net, at: { x: p.x, y: p.y }, seg: sg.s, sheet: p.sheet || 1 }); }
    }
  }
  for (const f of routed.flags || []) {
    for (const sg of segs) {
      if (sg.sheet !== (f.sheet || 1)) continue;
      if (sg.net === f.net) continue;
      if (G.pointSegDist({ x: f.x, y: f.y }, sg.s) < 0.01) { n += 1; hits.push({ a: `flag(${f.net})`, b: sg.net, at: { x: f.x, y: f.y }, seg: sg.s, sheet: f.sheet || 1 }); }
    }
  }
  if (process.env.EPRJ3_DEBUG_CONTACTS && n > 0) {
    // debug-only: dump the offending nets + geometry so a routing collision
    // can be traced to its cause (this is not part of normal builds)
    process.stderr.write(`\n[CROSS-NET CONTACTS] ${n}:\n`);
    for (const h of hits) {
      const s = h.s1 || h.seg;
      process.stderr.write(`  ${h.sheet}  ${h.a} x ${h.b}  ${s ? `seg(${s.x1},${s.y1})-(${s.x2},${s.y2})` : ''}${h.at ? ` at(${h.at.x},${h.at.y})` : ''}\n`);
    }
  }
  return n;
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
  stubPoint,
  countCrossNetContacts
};
