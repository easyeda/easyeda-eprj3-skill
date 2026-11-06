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
const T = require('./sch-tokens');

const STUB = T.STUB;
const TRUNK_OFFSET = T.TRUNK_OFFSET;
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
    let dir = { x: Math.abs(v.x) < 1e-9 ? 0 : Math.sign(v.x), y: Math.abs(v.y) < 1e-9 ? 0 : Math.sign(v.y) };
    // The pin's own rotation says which way it is drawn, but library symbols
    // disagree on the convention: a 0402 cap whose pins sit 10 mil apart got
    // its "outward" direction pointing INTO the part, so the GND stub ran
    // straight through the other pin and shorted the two nets. Step both ways
    // and keep the direction that moves AWAY from the body centre.
    if (pl.extent) {
      const step = Math.max(40, (pin.length || 0) * 2);
      const away = Math.hypot(tip.x + dir.x * step - pl.x, tip.y + dir.y * step - pl.y);
      const into = Math.hypot(tip.x - dir.x * step - pl.x, tip.y - dir.y * step - pl.y);
      if (away + 1 < into) dir = { x: -dir.x, y: -dir.y };
    }
    return dir;
  }
  const dx = tip.x - pl.x;
  const dy = tip.y - pl.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) || -1 };
}

/**
 * Electrical direction of one pin, seen from its own part: 'I' (the part
 * receives), 'O' (the part drives), 'B' (both / bus) or null (unknown).
 * Order of evidence: the design's declared pin direction, the symbol's Pin
 * Type, then the pin NAME (TX/OUT/DOUT drive, RX/IN/EN/RST/CS receive).
 * Two-pin passives never decide a direction.
 */
function pinDirection(pl, pin) {
  const declared = pl.part.pinDirs && pl.part.pinDirs[String(pin.num)];
  if (declared === 'I' || declared === 'O') return declared;
  if (declared === 'B' || declared === 'T' || declared === 'C') return 'B';
  const t = String(pin.type || '').toUpperCase();
  if (t === 'IN' || t === 'INPUT') return 'I';
  if (t === 'OUT' || t === 'OUTPUT') return 'O';
  if (t === 'BI' || t === 'IO' || t === 'I/O') return 'B';
  if ((pl.sym.pins || []).length <= 2) return null;
  const n = `_${String(pin.name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
  if (/_(TXD?|DOUT|SDO|OUT|INT|IRQ|TX_?OUT)\d*_/.test(n)) return 'O';
  if (/_(RXD?|DIN|SDI|IN|EN|CE|RST|RESET|NRST|CS|NCS)\d*_/.test(n)) return 'I';
  return null;
}

/**
 * Port preset for one block's side of a net: OUT when that block only drives
 * it, IN when it only receives it, BI otherwise (mixed, bus or unknown).
 */
function portKind(nodes) {
  const ds = nodes.map((n) => n.pdir).filter(Boolean);
  const hasO = ds.includes('O');
  const hasI = ds.includes('I');
  if (!ds.length || ds.includes('B') || (hasO && hasI)) return 'BI';
  return hasO ? 'OUT' : 'IN';
}

/**
 * Is this pin one of a dense column (another pin tip within 16 units along the
 * perpendicular axis)? A port body + printed name is ~14 units tall, so at a
 * 100-mil pin pitch two stacked ports overlap; such pins take a stub + global
 * net label instead (labels print above the wire and fit the row pitch).
 */
function densePin(node, ctx) {
  return (ctx.pinPoints || []).some((p) => {
    if (p.x === node.tip.x && p.y === node.tip.y) return false;
    if (node.dir.x !== 0) return Math.abs(p.x - node.tip.x) < 0.01 && Math.abs(p.y - node.tip.y) <= 16;
    return Math.abs(p.y - node.tip.y) < 0.01 && Math.abs(p.x - node.tip.x) <= 16;
  });
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
        pdir: pinDirection(pl, pin),
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

/** Z-shaped path through a vertical channel at midX. */
function zPathV(pa, pb, midX) {
  if (Math.abs(pa.x - midX) < G.EPS && Math.abs(pb.x - midX) < G.EPS) {
    return Math.abs(pa.y - pb.y) > G.EPS ? [{ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }] : [];
  }
  const out = [];
  if (Math.abs(pa.x - midX) > G.EPS) out.push({ x1: pa.x, y1: pa.y, x2: midX, y2: pa.y });
  if (Math.abs(pa.y - pb.y) > G.EPS) out.push({ x1: midX, y1: pa.y, x2: midX, y2: pb.y });
  if (Math.abs(pb.x - midX) > G.EPS) out.push({ x1: midX, y1: pb.y, x2: pb.x, y2: pb.y });
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
  // horizontal channels: the midpoint first, then steps outward on both sides
  const offs = [0, -20, 20, -40, 40, -60, 60, -90, 90];
  for (const o of offs) {
    const my = midY + o;
    candidates.push(stubRoute(a, b, (pa, pb) => zPath(pa, pb, my)));
  }
  // vertical channels: the same detour turned 90° — two pins on facing sides
  // of a part, or stacked parts, often only have a clean VERTICAL corridor
  // (this is what left most in-module signal nets as stub+label)
  const midX = Math.round((pa0.x + pb0.x) / 2);
  for (const o of offs) {
    const mx = midX + o;
    candidates.push(stubRoute(a, b, (pa, pb) => zPathV(pa, pb, mx)));
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
    // the NET attr already — a second stub would only duplicate it. Only an
    // ENDPOINT counts: a wire that merely PASSES OVER this pin (a same-net
    // escape stub crossing a pin column) does not connect it in the client
    // netlist, so those pins still need their own stub.
    const endsAt = (s, t) => (Math.abs(s.x1 - t.x) < 0.01 && Math.abs(s.y1 - t.y) < 0.01)
      || (Math.abs(s.x2 - t.x) < 0.01 && Math.abs(s.y2 - t.y) < 0.01);
    if (committed.some((c) => c.net === net && endsAt(c.seg, node.tip))) continue;
    // Adaptive stub: facing pins of DIFFERENT nets sit close together at
    // tight layout — a fixed 40 mil stub from both sides meets in the middle
    // and the client merges the two nets at that contact. Try 40 → 10 and
    // keep the longest stub with no CROSS-NET contact (labels may sit right
    // at the hotspot as a last resort). A same-net collision (this net's
    // other edge already drew that stub) is not an error — it just looks
    // like a duplicate, so prefer a shorter distinct stub when one exists.
    const crossClash = (seg) => committed.some((c) => c.net !== net && G.segsIntersect(seg, c.seg, true));
    const sameClash = (seg) => committed.some((c) => c.net === net && G.segsIntersect(seg, c.seg, true));
    // the printed label must not land inside a symbol body (lint L009)
    const onPart = (seg) => (ctx.obstacles || []).some((o) => G.rectContains(G.expand(o.rect, 2), { x: seg.x2, y: seg.y2 }));
    // a stub drawn THROUGH another net's pin tip shorts the two nets the moment
    // that pin is later wired (ESP32: a GND stub crossed an AUD_3V3 pin, whose
    // flag then landed on the wire). Same-net pins are allowed on the segment —
    // the contact is electrically harmless — but the skip below only treats a
    // pin as connected when a wire ENDPOINT lands on it, so each crossed pin
    // still emits its own stub.
    const overPin = (seg) => (ctx.pinPoints || []).some((p) => p.net !== net
      && G.pointSegDist({ x: p.x, y: p.y }, seg) < 0.01)
      || (ctx.flagPoints || []).some((f) => f.net !== net
        && G.pointSegDist({ x: f.x, y: f.y }, seg) < 0.01)
      || (ctx.portPoints || []).some((f) => f.net !== net
        && G.pointSegDist({ x: f.x, y: f.y }, seg) < 0.01);
    if (process.env.SCH_ROUTE_DEBUG) console.error('ADAPTIVE', net, node.part+'.'+node.pin, 'tip', node.tip.x+','+node.tip.y, 'committed', committed.length);
    let chosen = null;
    let soft = null;   // cross-net- and pin-clean, but the name would sit on a body
    for (const len of [STUB, 30, 20, 10]) {
      const seg = {
        x1: node.tip.x, y1: node.tip.y,
        x2: G.round(node.tip.x + node.dir.x * len),
        y2: G.round(node.tip.y + node.dir.y * len)
      };
      const xclash = crossClash(seg), sclash = sameClash(seg);
      if (process.env.SCH_ROUTE_DEBUG) console.error('  ADAPTIVE', net, node.part + '.' + node.pin, 'len', len, 'cross', xclash, 'same', sclash,
        xclash ? `hit ${(committed.find((c) => c.net !== net && G.segsIntersect(seg, c.seg, true)) || {}).net} `
          + JSON.stringify((committed.find((c) => c.net !== net && G.segsIntersect(seg, c.seg, true)) || {}).seg) : '');
      if (!crossClash(seg) && !overPin(seg)) {
        if (!sameClash(seg) && !onPart(seg)) { chosen = seg; break; }
        // cross-net-clean fallback: a same-net duplicate or a crowded label is
        // cosmetic, a foreign pin ON the stub is electrical (it shorts the two
        // nets the moment that pin is wired/flagged) — never fall back to it
        if (!soft) soft = seg;
      }
    }
    if (!chosen && soft) {
      // the pin's own axis is clean but the name would land on a symbol body
      // (a neighbouring part sits right in front): step perpendicular from the
      // tip instead — any stub endpoint carries the net name (L009)
      for (const pd of [{ x: node.dir.y, y: -node.dir.x }, { x: -node.dir.y, y: node.dir.x }]) {
        for (const len of [20, 30, 40]) {
          const s = {
            x1: node.tip.x, y1: node.tip.y,
            x2: G.round(node.tip.x + pd.x * len), y2: G.round(node.tip.y + pd.y * len)
          };
          if (!crossClash(s) && !sameClash(s) && !overPin(s) && !onPart(s)) { chosen = s; break; }
        }
        if (chosen) break;
      }
      if (!chosen) chosen = soft;
    }
    if (!chosen) {
      // last resort: a short jog — 10 along the pin, then 20 perpendicular
      const first = { x1: node.tip.x, y1: node.tip.y, x2: G.round(node.tip.x + node.dir.x * 10), y2: G.round(node.tip.y + node.dir.y * 10) };
      const second = { x1: first.x2, y1: first.y2, x2: first.x2, y2: first.y2 + 20 };
      if (crossClash(first) || overPin(first)) {
        // The pin's exit direction is blocked by a facing foreign wire (two
        // pins of different nets meet in the middle). A label alone would not
        // connect the pin (the netlist only unions a pin where a WIRE endpoint
        // lands on it), so step PERPENDICULAR straight from the tip instead —
        // any clean stub carries the net name and connects the pin.
        let alt = null;
        const perps = [{ x: node.dir.y, y: -node.dir.x }, { x: -node.dir.y, y: node.dir.x }];
        // prefer a stub whose name also clears every symbol body; accept an
        // on-body one only when no off-body escape exists (readability, not
        // electrical)
        for (const strict of [true, false]) {
          for (const pd of perps) {
            for (const len of [20, 30]) {
              const s = { x1: node.tip.x, y1: node.tip.y, x2: G.round(node.tip.x + pd.x * len), y2: G.round(node.tip.y + pd.y * len) };
              if (!crossClash(s) && !sameClash(s) && !overPin(s) && (!strict || !onPart(s))) { alt = s; break; }
            }
            if (alt) break;
          }
          if (alt) break;
        }
        if (alt) {
          chosen = alt;
        } else {
          chosen = { x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y };
          issues.push(`net "${net}": pin ${node.part}.${node.pin} has no clean exit — check for neighbouring wires/flags`);
        }
      } else if (!overPin(second) && !onPart(second)) {
        chosen = second;
        if (crossClash(second)) issues.push(`net "${net}": stub for ${node.part}.${node.pin} could not avoid neighbouring wires — check the label placement`);
        wires.push([first]);
        commitSegs([first], net, used, committed);
      } else {
        // the perpendicular jog would cross a foreign pin: keep the clean
        // along-pin stub and put the net name at its end
        chosen = first;
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

/**
 * Group a net's nodes by (sheet, block): one group = one module side of the
 * net. Deterministic order (sheet, then block title).
 */
function groupBySheetBlock(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = `${node.sheet || 1}|${node.block || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

/** Group a net's nodes by sheet (deterministic order). */
function groupBySheet(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const s = node.sheet || 1;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(node);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
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
    if (hi - lo > G.EPS) {
      // Split the spine at every drop: a drop must meet the trunk on a
      // SEGMENT ENDPOINT. A wire end landing mid-segment is not connected by
      // the client's source-API wires (it is the classic "vertical wire does
      // not join the horizontal one" defect), and our own netlist agrees.
      const pts = [...new Set(xs.map((x) => G.round(x)))].sort((a, b) => a - b);
      const stops = pts.filter((x) => x > lo + G.EPS && x < hi - G.EPS);
      const all = [lo, ...stops, hi];
      for (let i = 0; i + 1 < all.length; i += 1) {
        if (all[i + 1] - all[i] > G.EPS) main.push({ x1: all[i], y1: busY, x2: all[i + 1], y2: busY });
      }
    }
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
    if (hi - lo > G.EPS) {
      // split the spine at every drop (see trunkNetPathH): a T contact must be
      // a shared endpoint, not one wire ending inside another
      const pts = [...new Set(ys.map((y) => G.round(y)))].sort((a, b) => a - b);
      const stops = pts.filter((y) => y > lo + G.EPS && y < hi - G.EPS);
      const all = [lo, ...stops, hi];
      for (let i = 0; i + 1 < all.length; i += 1) {
        if (all[i + 1] - all[i] > G.EPS) main.push({ x1: busX, y1: all[i], x2: busX, y2: all[i + 1] });
      }
    }
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

/** Adaptive stub + net-port for a lone node (mirrors the old connector path).
 *  `strict` makes a crowded placement a failure (return null) instead of
 *  forcing the port into another net's wire/designator — the caller then
 *  falls back to a stub + global net label, which is far smaller. */
function placeNodePort(node, net, ctx, kind, strict) {
  const committed = ctx.committedSegs;
  const used = ctx.usedPoints;
  const foreign = committed.filter((c) => c.net !== net);
  const vertical = node.dir.y !== 0;
  const cross = vertical ? node.tip.x : node.tip.y;
  const stair = STUB + (Math.abs(Math.round(cross / 10)) % 4) * 14;
  const lens = [...new Set([STUB, stair, stair - 14, stair - 28, 30, 20, 10].filter((l) => l >= 10))];
  // a chain-internal net leaves sideways so its name never runs through the chain
  const portDir = (ctx.patternPortNets && ctx.patternPortNets.has(net)) ? { x: 1, y: 0 } : node.dir;
  let chosen = null;
  let fallback = null;
  for (const len of lens) {
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
    if (!wireHit && !portHit && !pinHit && !partHit) {
      const labelBox = portLabelBox(net, pos, portDir);
      if (!boxClash(ctx, labelBox)) { chosen = seg; ctx.flagBoxes.push(labelBox); break; }
      if (!fallback) fallback = { seg, labelBox };
    }
  }
  if (!chosen && fallback && !strict) { chosen = fallback.seg; ctx.flagBoxes.push(fallback.labelBox); }
  if (!chosen && !strict) {
    chosen = { x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y, anchor: true };
    ctx.flagBoxes.push(portLabelBox(net, { x: node.tip.x, y: node.tip.y }, portDir));
  }
  if (!chosen) return null;
  const zero = Math.abs(chosen.x2 - node.tip.x) < G.EPS && Math.abs(chosen.y2 - node.tip.y) < G.EPS;
  if (zero) chosen.anchor = true;
  // ALWAYS return the wire: a port dropped directly on the pin needs the
  // zero-length anchor wire to take effect in the client netlist
  return { wire: [chosen], port: { net, x: chosen.x2, y: chosen.y2, dir: portDir, kind: kind || portKind([node]) } };
}

/**
 * Route a non-power, non-NC signal net with ≥2 nodes, sheet-aware (report
 * §5.2/§5.3/§8.2): every pin on one sheet is wired with visible orthogonal
 * routes no matter which module it belongs to; a net spanning sheets crosses
 * each page with ONE net-port (Netport-IN/OUT/BI by that side's pin dirs).
 * Returns { wires:[[segs]], labels:[], ports:[], issues:[] }.
 */
function routeSignalNet(net, nodes, ctx) {
  const wires = [];
  const labels = [];
  const ports = [];
  const issues = [];
  const used = ctx.usedPoints;
  const committed = ctx.committedSegs;
  // Group by (sheet, block): a net that leaves its block is a module-boundary
  // signal. Each block side wires its own pins locally and gets ONE net port,
  // so a wire never runs across the page into another module's frame (the old
  // per-sheet grouping drew long L wires between distant blocks). Cross-sheet
  // nets are already intercepted by routeSchematic and never reach this path.
  const groups = groupBySheetBlock(nodes);
  const multiGroup = groups.length > 1;

  for (const grp of groups) {
    // this block's side of the net decides the port preset: a block that only
    // drives the net gets Netport-OUT, one that only receives gets Netport-IN
    const kind = portKind(grp);
    if (grp.length === 1) {
      if (multiGroup) {
        // dense pin column: a port would collide with its neighbours' ports;
        // a stub + global net label is what a human draws there
        if (!(ctx.patternPortNets && ctx.patternPortNets.has(net)) && densePin(grp[0], ctx)) {
          const enc = labelEncoding(grp, net, issues, null, ctx);
          enc.wires.forEach((w) => commitSegs(w, net, used, committed));
          wires.push(...enc.wires);
          labels.push(...enc.labels);
          continue;
        }
        const pr = placeNodePort(grp[0], net, ctx, kind, true);
        if (pr) {
          if (pr.wire.length) { wires.push(pr.wire); commitSegs(pr.wire, net, used, committed); }
          ports.push(pr.port);
        } else {
          // no clean port site: the port body + printed name would sit on a
          // wire or a designator. A stub + global net label is the readable
          // human encoding at that density.
          const enc = labelEncoding(grp, net, issues,
            `net "${net}": ${grp[0].part}.${grp[0].pin} is too crowded for a net port → encoded as stub+label`, ctx);
          enc.wires.forEach((w) => commitSegs(w, net, used, committed));
          wires.push(...enc.wires);
          labels.push(...enc.labels);
        }
      }
      continue; // lone node on a single-block net is handled by the caller
    }
    const segs = routeGroup(grp, net, ctx, issues);
    wires.push(...segs.wires);
    labels.push(...segs.labels);
    if (multiGroup) {
      // cross-sheet hop: one port on this sheet, anchored on a member stub —
      // but never on a point that another net's wire, flag, pin or port
      // already occupies (the client merges two nets wherever they touch).
      const portDirOf = (n) => ((ctx.patternPortNets && ctx.patternPortNets.has(net)) ? { x: 1, y: 0 } : n.dir);
      let site = null;
      for (const n of grp) {
        const p = stubPoint(n);
        const pt = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
        const hitWire = committed.some((c) => c.net !== net && G.pointSegDist(p, c.seg) < 0.01);
        const hitOther = foreignContacts([pt], ctx, net) !== 0
          || (ctx.portPoints || []).some((f) => f.net !== net && Math.hypot(f.x - p.x, f.y - p.y) < 34);
        if (!hitWire && !hitOther) { site = { p, dir: portDirOf(n) }; break; }
      }
      if (site) {
        ports.push({ net, x: site.p.x, y: site.p.y, dir: site.dir, kind });
      } else {
        const pr = placeNodePort(grp[0], net, ctx, kind);
        if (pr.wire.length) { wires.push(pr.wire); commitSegs(pr.wire, net, used, committed); }
        ports.push(pr.port);
      }
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
    // ---- same-net pin banks: one rail and one flag -------------------------
    // A row of same-net pins (decoupling bank, one side of an IC) does not need
    // a flag and a label on every pin: stub them to a shared rail, split the
    // rail at every junction (endpoint connectivity), and drop ONE flag on the
    // middle stub. This is the reference engine's mergeLocalFlags /
    // centerBankFlags idea, re-derived for our router.
    const combed = new Set();
    const halfW = Math.max(15, String(net).length * 2.5);
    const labelBox = (pos) => (style === 'down'
      ? G.rect(pos.x - halfW, pos.y - 27, pos.x + halfW, pos.y - 15)
      : G.rect(pos.x - halfW, pos.y + 8, pos.x + halfW, pos.y + 20));
    const labelClash = (pos) => (ctx.flagBoxes || []).some((b) => G.rectsOverlap(labelBox(pos), b));
    const wireClash = (seg) => committed.some((c) => c.net !== net && G.segsIntersect(seg, c.seg, true))
      || (used && segPointKeys(seg).some((key) => used.has(key)));
    const flagNear = (pos) => (ctx.flagPoints || []).some((f) => f.net !== net
      && Math.hypot(f.x - pos.x, f.y - pos.y) < 30);
    // the printed net name must not land on a symbol body (lint L009)
    const labelHitsPart = (pos) => obstacles.some((o) => G.rectsOverlap(labelBox(pos), o.rect));
    const groups = new Map();
    nodes.forEach((node) => {
      const vertical = node.dir.y !== 0;
      const key = `${node.dir.x},${node.dir.y},${node.block || ''},${Math.round(vertical ? node.tip.y : node.tip.x)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ node, pos: vertical ? node.tip.x : node.tip.y });
    });
    const COMB_GAP = T.COMB_GAP;
    const tryBank = (run) => {
      if (run.length < 2 || run.length > 8) return false;
      const vertical = run[0].node.dir.y !== 0;
      const fixed = vertical ? run[0].node.tip.y : run[0].node.tip.x;
      const lo = run[0].pos;
      const hi = run[run.length - 1].pos;
      const dbg = process.env.SCH_ROUTE_DEBUG ? (...a) => console.error('BANK', net, ...a) : () => {};
      dbg('run', run.map((it) => `${it.node.part}.${it.node.pin}`).join(','), 'fixed', fixed, 'lo..hi', lo, hi);
      // never draw the rail across a foreign pin on the same row: that pin's
      // own stub would have to land on (or cross) it
      const blocker = (ctx.pinPoints || []).find((p) => p.net !== net
        && Math.abs((vertical ? p.y : p.x) - fixed) < 0.01
        && (vertical ? p.x : p.y) > lo && (vertical ? p.x : p.y) < hi);
      const blocked = !!blocker;
      if (blocked) { dbg('blocked by pin', blocker.part, blocker.pin || '', blocker.x, blocker.y); return false; }
      const ignore = new Set(run.map((it) => it.node.part));
      for (const len of [30, 40, 50, 60]) {
        const stubs = [];
        const ends = [];
        let ok = true;
        for (const it of run) {
          const n = it.node;
          const end = { x: G.round(n.tip.x + n.dir.x * len), y: G.round(n.tip.y + n.dir.y * len) };
          const seg = { x1: n.tip.x, y1: n.tip.y, x2: end.x, y2: end.y };
          if (wireClash(seg) || foreignContacts([seg], ctx, net) !== 0) { ok = false; dbg('stub clash at len', len, n.part + '.' + n.pin); break; }
          stubs.push(seg);
          ends.push(end);
        }
        if (!ok) continue;
        const rails = [];
        for (let i = 1; i < ends.length && ok; i += 1) {
          const a = ends[i - 1];
          const b = ends[i];
          const seg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
          const box = G.rect(Math.min(a.x, b.x) - 6, Math.min(a.y, b.y) - 6,
            Math.max(a.x, b.x) + 6, Math.max(a.y, b.y) + 6);
          if (wireClash(seg) || foreignContacts([seg], ctx, net) !== 0
            || overlapsAny(box, obstacles, ignore)) { ok = false; dbg('rail clash at len', len, Math.min(a.x, b.x), Math.min(a.y, b.y)); }
          else rails.push(seg);
        }
        if (!ok) continue;
        let flagAt = null;
        const order = [Math.floor(run.length / 2), ...run.map((_, i) => i)];
        for (const i of order) {
          // the flag POINT must not lie on a foreign wire (the stub test alone
          // misses a point-on-segment contact: the client merges both nets)
          const onForeign = committed.some((c) => c.net !== net && G.pointSegDist(ends[i], c.seg) < 0.01);
          if (!onForeign && !flagNear(ends[i]) && !labelClash(ends[i]) && !labelHitsPart(ends[i])) { flagAt = ends[i]; break; }
        }
        if (!flagAt) { dbg('no flag site at len', len); continue; }
        const all = stubs.concat(rails);
        wires.push(all);
        commitSegs(all, net, used, committed);
        flags.push({ net, x: flagAt.x, y: flagAt.y, style });
        ctx.flagPoints.push({ net, x: flagAt.x, y: flagAt.y });
        ctx.flagBoxes.push(labelBox(flagAt));
        run.forEach((it) => combed.add(it.node));
        dbg('MERGED at len', len);
        return true;
      }
      return false;
    };
    for (const list of groups.values()) {
      list.sort((a, b) => a.pos - b.pos);
      let run = [];
      for (const it of list) {
        if (run.length && Math.abs(it.pos - run[run.length - 1].pos) > COMB_GAP) {
          tryBank(run);
          run = [];
        }
        run.push(it);
      }
      tryBank(run);
    }

    for (const node of nodes) {
      if (combed.has(node)) continue;
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
      // A column of up/down pins at a 10-unit pitch puts every flag's net name
      // on the same row: the labels (≈30 units wide for "VCC-5V") overprint
      // each other. Walk the flags up a four-step staircase by pin column so
      // neighbours sit on different rows; same-slot columns are 40 units apart
      // and clear each other. The normal 40-unit stub is tried first so a
      // sparse bank keeps the plain look.
      const cross = node.dir.y !== 0 ? node.tip.x : node.tip.y;
      const slot = Math.abs(Math.round(cross / 10)) % 4;
      const stair = STUB + slot * 14;
      const lens = [...new Set([STUB, stair, stair - 14, stair - 28, 30, 20, 10]
        .filter((l) => l >= 10))];
      // the net name is printed beyond the flag (above an up flag, below a
      // ground flag): reserve its real box so it cannot overprint a neighbour
      const halfW = Math.max(15, String(net).length * 2.5);
      const labelBox = (pos) => (style === 'down'
        ? G.rect(pos.x - halfW, pos.y - 27, pos.x + halfW, pos.y - 15)
        : G.rect(pos.x - halfW, pos.y + 8, pos.x + halfW, pos.y + 20));
      const labelClash = (pos) => (ctx.flagBoxes || []).some((b) => G.rectsOverlap(labelBox(pos), b));

      // Dense IC side: a power pin on a multi-pin symbol with a neighbour pin
      // within two pitches cannot carry a flag — the flag names (printed above
      // or below the symbol) overprint each other at a 100-mil pitch. The
      // human convention is a short stub + net label on the IC pin, with the
      // real supply/ground symbols living in the decoupling bank.
      const pl = node.placement;
      const horizontalPin = node.dir.x !== 0;
      if (horizontalPin && pl && pl.sym && pl.sym.pins.length > 4) {
        const crowded = (ctx.pinPoints || []).some((p) => !(p.x === node.tip.x && p.y === node.tip.y)
          && Math.abs(p.x - node.tip.x) < 0.01 && Math.abs(p.y - node.tip.y) <= 20);
        if (crowded) {
          const enc = labelEncoding([node], net, issues, null, ctx);
          enc.wires.forEach((w) => commitSegs(w, net, used, committed));
          wires.push(...enc.wires);
          labels.push(...enc.labels);
          continue;
        }
      }

      // Ground-flag orientation policy (the human convention):
      //  - an upward pin sits inside/next to the part, so a flag above it
      //    overprints the symbol → use a stub + net label instead;
      //  - a horizontal pin gets a short drop so the ground symbol hangs BELOW
      //    the wire instead of lying on it sideways;
      //  - a downward pin keeps the plain flag.
      if (style === 'down' && node.dir.y > 0) {
        const enc = labelEncoding([node], net, issues, null, ctx);
        enc.wires.forEach((w) => commitSegs(w, net, used, committed));
        wires.push(...enc.wires);
        labels.push(...enc.labels);
        continue;
      }
      if (style === 'down' && node.dir.x !== 0) {
        let drop = null;
        for (const L of [40, 30, 20]) {
          for (const D of [40, 60, 30]) {
            const mid = { x: G.round(node.tip.x + node.dir.x * L), y: node.tip.y };
            const end = { x: mid.x, y: G.round(mid.y - D) };
            const s1 = { x1: node.tip.x, y1: node.tip.y, x2: mid.x, y2: mid.y };
            const s2 = { x1: mid.x, y1: mid.y, x2: end.x, y2: end.y };
            const box = G.rect(Math.min(node.tip.x, end.x) - 12, Math.min(node.tip.y, end.y) - 12,
              Math.max(node.tip.x, end.x) + 12, Math.max(node.tip.y, end.y) + 12);
            if (wireClash(s1) || wireClash(s2) || foreignContacts([s1, s2], ctx, net) !== 0) continue;
            if (flagClash(end) || labelClash(end) || labelHitsPart(end)
              || overlapsAny(box, obstacles, ignore)) continue;
            drop = { segs: [s1, s2], end };
            break;
          }
          if (drop) break;
        }
        if (drop) {
          wires.push(drop.segs);
          commitSegs(drop.segs, net, used, committed);
          flags.push({ net, x: drop.end.x, y: drop.end.y, style });
          ctx.flagPoints.push({ net, x: drop.end.x, y: drop.end.y });
          ctx.flagBoxes.push(labelBox(drop.end));
          continue;
        }
        // no clean drop: fall through to the generic placement as a last resort
      }

      let placed = null;
      let wire = null;
      let labelFallback = null;
      for (const len of lens) {
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
        // the flag POINT itself must not sit on a foreign wire: with a short
        // (or zero-length) stub the segment test alone misses it — the client
        // merges the two nets at any contact (ESP32 AUD_3V3 on a GND stub)
        const onForeignWire = committed.some((c) => c.net !== net && G.pointSegDist(pos, c.seg) < 0.01);
        if (!onForeignWire && !wireClash(seg) && !flagClash(pos) && foreign === 0 && !overlapsAny(box, obstacles, ignore)) {
          if (!labelClash(pos) && !labelHitsPart(pos)) {
            placed = pos;
            wire = seg;
            break;
          }
          // electrically clean but the name would overprint a neighbour's: keep
          // it as the best effort — an on-pin flag is worse than crowded text
          if (!labelFallback) labelFallback = { pos, seg };
        }
      }
      if (!placed && labelFallback) {
        placed = labelFallback.pos;
        wire = labelFallback.seg;
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
          // (that would short the pin to a foreign net). The zero-length anchor
          // wire is still required: a flag on a bare pin does not connect in
          // the client without a wire endpoint under it.
          placed = { x: node.tip.x, y: node.tip.y };
          wire = { x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y, anchor: true };
          issues.push(`net "${net}": power flag for ${node.part}.${node.pin} placed on the pin — check for neighbouring wires/flags`);
        }
      }
      if (process.env.SCH_ROUTE_DEBUG) console.error('GFLAG', net, `${placed.x},${placed.y}`, `${node.part}.${node.pin}`, 'tip', `${node.tip.x},${node.tip.y}`, 'wire', wire ? `${wire.x1},${wire.y1}-${wire.x2},${wire.y2}` : 'on-pin');
      flags.push({ net, x: placed.x, y: placed.y, style });
      (ctx.flagPoints || []).push({ net, x: placed.x, y: placed.y });
      if (ctx.flagBoxes) ctx.flagBoxes.push(labelBox(placed));
      if (wire && (wire.anchor || Math.abs(wire.x2 - node.tip.x) > G.EPS || Math.abs(wire.y2 - node.tip.y) > G.EPS)) {
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

const PORT_OUT = T.PORT_NAME_OFFSET; // official Netport name offset (body ends at 40)

/** Space a port's body + printed net name occupies (see portComponentBlock). */
function portLabelBox(net, pos, dir) {
  const half = Math.max(10, String(net).length * 2.5);
  if (dir.x > 0) return G.rect(pos.x, pos.y - 7, pos.x + PORT_OUT + 2 * half, pos.y + 7);
  if (dir.x < 0) return G.rect(pos.x - PORT_OUT - 2 * half, pos.y - 7, pos.x, pos.y + 7);
  if (dir.y > 0) return G.rect(pos.x - half, pos.y, pos.x + half, pos.y + PORT_OUT + 7);
  return G.rect(pos.x - half, pos.y - PORT_OUT - 7, pos.x + half, pos.y);
}

function boxClash(ctx, box) {
  return (ctx.flagBoxes || []).some((b) => G.rectsOverlap(box, b));
}

/**
 * Route every net. Power nets get flags, everything else gets wires/labels.
 * A shared point registry keeps two nets from ever touching.
 */
function routeSchematic(d, placements, opts) {
  const options = opts || {};
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
      flagBoxes: [],
      portPoints: [],
      pinPoints,
      // chain-internal nets get a sideways port (the pattern pass marks them)
      patternPortNets: options.patternPortNets || new Set(),
      powerStyle: (net) => d.powerNets.get(net) || null
    };
    // Route SIGNAL nets first, power flags last: a power stub committed early
    // can sit exactly on a neighbouring pin's only escape path (H6 U4.43 next
    // to a VCC-5V stub), leaving that pin unconnected. Flags are flexible —
    // they try several lengths/directions and avoid committed wires.
    const order = [...nets.entries()].sort((a, b) => {
      const pa = d.powerNets.has(a[0]) ? 1 : 0;
      const pb = d.powerNets.has(b[0]) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      // among power nets, route the BIGGEST first (GND): its web is long and
      // fixed, so the smaller rails' flags are the ones that can move out of
      // its way instead of landing on a GND stub
      if (pa === 1) return b[1].length - a[1].length;
      return 0;
    });
    for (const [net, nodes] of order) {
      // Power nets keep their flags on every sheet (routeNet handles them) —
      // turning GND into a port would drop the flag convention for nothing.
      // NC nets are the deliberate no-connect convention even across sheets:
      // they must never get a net port (a port merges them into one net), so
      // fall through to routeNet's labelEncoding stub+label path instead.
      if (crossSheet.has(net) && !ctx.powerStyle(net) && !/^(NC|DNC\d*)$/i.test(net)) {
        // cross-sheet: every node on THIS sheet gets its own stub + net port.
        // The stub must clear foreign committed wires AND every foreign pin
        // tip / port (a port dropped onto another net's wire shorts them); if
        // no clean stub fits, the port sits directly on the pin tip. A pin
        // column at a 10-unit pitch prints its port names on the same row, so
        // walk the ports up the same four-step staircase as power flags (the
        // port's own body + name is a reserved box in the shared registry).
        for (const node of nodes) {
          // A dense pin column cannot carry a port: the port body and its
          // printed name are ~14 units tall, so at a 100-mil pitch the stacked
          // ports and names overlap (multi-unit ICs were unreadable). The
          // human convention there is a stub + global net label — the Wire's
          // NET attr joins the same net by name.
          if (!(ctx.patternPortNets && ctx.patternPortNets.has(net)) && densePin(node, ctx)) {
            const enc = labelEncoding([node], net, out.issues, null, ctx);
            enc.wires.forEach((w) => commitSegs(w, net, ctx.usedPoints, ctx.committedSegs));
            for (const segs of enc.wires) out.wires.push({ net, sheet, segs });
            out.labels.push(...enc.labels);
            continue;
          }
          const vertical = node.dir.y !== 0;
          const cross = vertical ? node.tip.x : node.tip.y;
          const slot = Math.abs(Math.round(cross / 10)) % 4;
          const stair = STUB + slot * 14;
          const lens = [...new Set([STUB, stair, stair - 14, stair - 28, 30, 20, 10]
            .filter((l) => l >= 10))];
          // chain-internal nets take a sideways port (see sch-patterns.js)
          const portDir = (ctx.patternPortNets && ctx.patternPortNets.has(net)) ? { x: 1, y: 0 } : node.dir;
          let chosen = null;
          let fallback = null;
          for (const len of lens) {
            const p = { x: G.round(node.tip.x + node.dir.x * len), y: G.round(node.tip.y + node.dir.y * len) };
            const seg = { x1: node.tip.x, y1: node.tip.y, x2: p.x, y2: p.y };
            const wireHit = ctx.committedSegs.some((c) => c.net !== net && G.segsIntersect(seg, c.seg, true));
            const foreign = foreignContacts([seg], ctx, net);
            if (wireHit || foreign) continue;
            const cand = { p, seg, box: portLabelBox(net, p, portDir) };
            if (!boxClash(ctx, cand.box)) { chosen = cand; break; }
            if (!fallback) fallback = cand;
          }
          if (!chosen) chosen = fallback;
          if (chosen) {
            out.wires.push({ net, sheet, segs: [chosen.seg] });
            commitSegs([chosen.seg], net, ctx.usedPoints, ctx.committedSegs);
            out.ports.push({ net, x: chosen.p.x, y: chosen.p.y, sheet, dir: portDir, kind: portKind([node]) });
            ctx.portPoints.push({ net, x: chosen.p.x, y: chosen.p.y });
            ctx.flagBoxes.push(chosen.box);
          } else {
            out.ports.push({ net, x: node.tip.x, y: node.tip.y, sheet, dir: portDir, kind: portKind([node]) });
            ctx.portPoints.push({ net, x: node.tip.x, y: node.tip.y });
            ctx.flagBoxes.push(portLabelBox(net, { x: node.tip.x, y: node.tip.y }, portDir));
            // anchor the on-pin port: the client only connects a net port that
            // sits on a wire endpoint, so a zero-length wire is mandatory
            out.wires.push({
              net,
              sheet,
              segs: [{ x1: node.tip.x, y1: node.tip.y, x2: node.tip.x, y2: node.tip.y, anchor: true }]
            });
          }
        }
        continue;
      }
      const r = routeNet(net, nodes, ctx);
      for (const segs of r.wires) {
        const seen = new Set();
        const clean = segs.filter((s) => {
          // zero-length segments are dropped EXCEPT anchor wires: a net port
          // or power flag sitting directly on a pin only connects in the
          // client when a (zero-length) wire anchors it at that point
          if (G.segLen(s) < G.EPS && !s.anchor) return false;
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
