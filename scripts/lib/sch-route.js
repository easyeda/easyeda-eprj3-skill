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

function scoreOf(route, obstacles, usedPoints) {
  // Only the MIDDLE of a route may be checked against part extents: the stubs
  // necessarily start right at their own symbol's pins. Everything else is a
  // bug waiting to short two nets together.
  const blocked = countBlocked(route.main, obstacles, new Set());
  const all = route.stubs.concat(route.main);
  const len = all.reduce((n, s) => n + G.segLen(s), 0);
  const shared = usedPoints ? countShared(all, usedPoints) : 0;
  return {
    blocked,
    shared,
    len,
    bends: G.bends(all),
    score: blocked * 1000000 + shared * 2000000 + len + G.bends(all) * 40
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

/** All candidate routes between two nodes, cheapest first. */
function bestRoute(a, b, obstacles, usedPoints) {
  const makers = [
    (pa, pb) => straight(pa, pb),
    lPath,
    lPath2
  ];
  const candidates = [];
  for (const m of makers) candidates.push(stubRoute(a, b, m));

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
    const s = scoreOf(route, obstacles, usedPoints);
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

function labelEncoding(nodes, net, issues, why) {
  const wires = [];
  const labels = [];
  for (const node of nodes) {
    const p = stubPoint(node);
    if (Math.abs(p.x - node.tip.x) > G.EPS || Math.abs(p.y - node.tip.y) > G.EPS) {
      wires.push([{ x1: node.tip.x, y1: node.tip.y, x2: p.x, y2: p.y }]);
    }
    labels.push({ net, x: p.x, y: p.y });
  }
  if (why) issues.push(why);
  return { wires, labels };
}

function commitSegs(segs, usedPoints) {
  if (!usedPoints) return;
  for (const seg of segs) for (const k of segPointKeys(seg)) usedPoints.add(k);
}

/**
 * Route one net. Returns { wires:[[segs]], flags:[], labels:[], issues:[] }.
 */
function routeNet(net, nodes, ctx) {
  const wires = [];
  const flags = [];
  const labels = [];
  const issues = [];
  const obstacles = ctx.obstacles;
  const used = ctx.usedPoints;
  const style = ctx.powerStyle(net);

  if (style) {
    for (const node of nodes) {
      const ignore = new Set([node.part]);
      let flag = null;
      for (let k = 1; k <= 4 && !flag; k += 1) {
        const pos = {
          x: G.round(node.tip.x + node.dir.x * (STUB * k)),
          y: G.round(node.tip.y + node.dir.y * (STUB * k))
        };
        const box = G.rect(pos.x - 12, pos.y - 22, pos.x + 12, pos.y + 22);
        const clash = used && [`${pos.x},${pos.y}`].some((key) => used.has(key));
        if (!overlapsAny(box, obstacles, ignore) && !clash) flag = pos;
      }
      if (!flag) {
        flag = stubPoint(node);
        issues.push(`net "${net}": power flag for ${node.part}.${node.pin} may overlap a neighbouring part`);
      }
      flags.push({ net, x: flag.x, y: flag.y, style });
      if (Math.abs(flag.x - node.tip.x) > G.EPS || Math.abs(flag.y - node.tip.y) > G.EPS) {
        const segs = [{ x1: node.tip.x, y1: node.tip.y, x2: flag.x, y2: flag.y }];
        wires.push(segs);
        commitSegs(segs, used);
      }
    }
    return { wires, flags, labels, issues };
  }

  if (nodes.length === 1) {
    // NC/DNC nets are the deliberate no-connect convention — encode silently.
    const isNC = /^(NC|DNC\d*)$/i.test(net);
    const enc = labelEncoding(nodes, net, issues, isNC ? null :
      `net "${net}" has a single pin (${nodes[0].part}.${nodes[0].pin}) — labelled as a dead end`);
    enc.wires.forEach((w) => commitSegs(w, used));
    return { wires: enc.wires, flags, labels: enc.labels, issues };
  }

  if (/^(NC|DNC\d*)$/i.test(net)) {
    // Several pins may share the NC name; they are NOT connected to each
    // other — wiring them (MST) would short every no-connected pin together.
    // Each pin gets its own stub + NC label instead.
    const enc = labelEncoding(nodes, net, issues, null);
    enc.wires.forEach((w) => commitSegs(w, used));
    return { wires: enc.wires, flags, labels: enc.labels, issues };
  }

  const edges = manhattanMst(nodes);
  for (const [a, b] of edges) {
    const ignore = new Set([a.part, b.part]);
    const manhattan = Math.abs(a.tip.x - b.tip.x) + Math.abs(a.tip.y - b.tip.y);
    if (a.block !== b.block && manhattan > LABEL_DISTANCE) {
      const enc = labelEncoding([a, b], net, issues);
      enc.wires.forEach((w) => commitSegs(w, used));
      wires.push(...enc.wires);
      labels.push(...enc.labels);
      continue;
    }
    const best = bestRoute(a, b, obstacles, used);
    if (!best || best.blocked > 0 || best.shared > 0) {
      const enc = labelEncoding([a, b], net, issues,
        `net "${net}": ${a.part}.${a.pin} → ${b.part}.${b.pin} has no clear route → encoded as stub+label`);
      enc.wires.forEach((w) => commitSegs(w, used));
      wires.push(...enc.wires);
      labels.push(...enc.labels);
      continue;
    }
    const segs = flatten(best.route);
    wires.push(segs);
    commitSegs(segs, used);
  }
  return { wires, flags, labels, issues };
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
            commitSegs(segs, ctx.usedPoints);
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
