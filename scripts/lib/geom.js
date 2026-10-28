'use strict';
/**
 * geom.js — dependency-free planar geometry for schematic/PCB authoring.
 *
 * Everything here is in mil and Y-up (the sheet and PCB authoring space).
 * The one subtlety: symbol-doc coordinates are NOT sheet coordinates. A pin in
 * a symbol doc is authored at (x, y) with a stub of `length` pointing along
 * `rotation`; the electrical connection point (the "tip") is the far end of
 * that stub, and it moves with the component's placement rotation.
 */

const EPS = 1e-6;

const rad = (deg) => (deg * Math.PI) / 180;

/** Rotate a point CCW around the origin by `deg` degrees. */
function rotate(x, y, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return { x, y };
  if (d === 90) return { x: -y, y: x };
  if (d === 180) return { x: -x, y: -y };
  if (d === 270) return { x: y, y: -x };
  const c = Math.cos(rad(d));
  const s = Math.sin(rad(d));
  return { x: x * c - y * s, y: x * s + y * c };
}

/**
 * Electrical connection point of a pin, in sheet/PCB coordinates.
 * pin: {x, y, length, rotation} in symbol space
 * origin/rotation: the component's placement
 */
function pinTip(pin, originX, originY, originRot) {
  const len = pin.length === undefined ? 0 : pin.length;
  // pin stub starts at (x,y) and ran along `rotation`; the tip is at its end.
  const stubX = pin.x - len * Math.cos(rad(pin.rotation || 0));
  const stubY = pin.y - len * Math.sin(rad(pin.rotation || 0));
  const r = rotate(stubX, stubY, originRot || 0);
  return { x: round(originX + r.x), y: round(originY + r.y) };
}

const round = (v) => Math.round(v * 1000) / 1000;

function rect(x1, y1, x2, y2) {
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}

function bboxOfPoints(pts) {
  if (!pts.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

function expand(r, pad) {
  return { x1: r.x1 - pad, y1: r.y1 - pad, x2: r.x2 + pad, y2: r.y2 + pad };
}

function rectsOverlap(a, b) {
  return a.x1 < b.x2 - EPS && b.x1 < a.x2 - EPS && a.y1 < b.y2 - EPS && b.y1 < a.y2 - EPS;
}

function rectContains(r, p) {
  return p.x >= r.x1 - EPS && p.x <= r.x2 + EPS && p.y >= r.y1 - EPS && p.y <= r.y2 + EPS;
}

function rectContainsRect(outer, inner) {
  return inner.x1 >= outer.x1 - EPS && inner.x2 <= outer.x2 + EPS
    && inner.y1 >= outer.y1 - EPS && inner.y2 <= outer.y2 + EPS;
}

function segLen(s) {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function isOrthogonal(s) {
  return Math.abs(s.x1 - s.x2) < EPS || Math.abs(s.y1 - s.y2) < EPS;
}

/** Does an axis-aligned-or-not segment touch/cross an axis-aligned rect? */
function segIntersectsRect(s, r) {
  const inA = rectContains(r, { x: s.x1, y: s.y1 });
  const inB = rectContains(r, { x: s.x2, y: s.y2 });
  if (inA || inB) return true;
  const edges = [
    { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y1 },
    { x1: r.x2, y1: r.y1, x2: r.x2, y2: r.y2 },
    { x1: r.x2, y1: r.y2, x2: r.x1, y2: r.y2 },
    { x1: r.x1, y1: r.y2, x2: r.x1, y2: r.y1 }
  ];
  return edges.some((e) => segsIntersect(s, e, true));
}

function orient(a, b, c) {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return Math.abs(v) < EPS ? 0 : (v > 0 ? 1 : 2);
}

function onSeg(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + EPS && b.x >= Math.min(a.x, c.x) - EPS
    && b.y <= Math.max(a.y, c.y) + EPS && b.y >= Math.min(a.y, c.y) - EPS;
}

/** Proper segment intersection; `touch` also counts shared endpoints. */
function segsIntersect(s1, s2, touch) {
  const a = { x: s1.x1, y: s1.y1 }; const b = { x: s1.x2, y: s1.y2 };
  const c = { x: s2.x1, y: s2.y1 }; const d = { x: s2.x2, y: s2.y2 };
  const o1 = orient(a, b, c); const o2 = orient(a, b, d);
  const o3 = orient(c, d, a); const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (!touch) return false;
  if (o1 === 0 && onSeg(a, c, b)) return true;
  if (o2 === 0 && onSeg(a, d, b)) return true;
  if (o3 === 0 && onSeg(c, a, d)) return true;
  if (o4 === 0 && onSeg(c, b, d)) return true;
  return false;
}

/** Distance from a point to a segment (mil). */
function pointSegDist(p, s) {
  const dx = s.x2 - s.x1; const dy = s.y2 - s.y1;
  const L2 = dx * dx + dy * dy;
  if (L2 < EPS) return Math.hypot(p.x - s.x1, p.y - s.y1);
  let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy));
}

/**
 * Route a 2-segment orthogonal path between two points.
 * Returns a list of segments; `mode` picks the corner that leaves the source
 * horizontally ('hv'), vertically ('vh'), or both candidates ('auto' = pick
 * the shorter, ties broken by 'hv').
 */
function orthoPath(from, to, mode) {
  const same = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
  if (same(from, to)) return [];
  const hv = () => {
    const segs = [];
    const corner = { x: to.x, y: from.y };
    if (!same(from, corner)) segs.push({ x1: from.x, y1: from.y, x2: corner.x, y2: corner.y });
    if (!same(corner, to)) segs.push({ x1: corner.x, y1: corner.y, x2: to.x, y2: to.y });
    return segs;
  };
  const vh = () => {
    const segs = [];
    const corner = { x: from.x, y: to.y };
    if (!same(from, corner)) segs.push({ x1: from.x, y1: from.y, x2: corner.x, y2: corner.y });
    if (!same(corner, to)) segs.push({ x1: corner.x, y1: corner.y, x2: to.x, y2: to.y });
    return segs;
  };
  if (mode === 'hv') return hv();
  if (mode === 'vh') return vh();
  const a = hv(); const b = vh();
  const la = a.reduce((n, s) => n + segLen(s), 0);
  const lb = b.reduce((n, s) => n + segLen(s), 0);
  return la <= lb ? a : b;
}

/** Bend count of a polyline (used to score route quality). */
function bends(segs) {
  let n = 0;
  for (let i = 1; i < segs.length; i += 1) {
    const p = segs[i - 1]; const q = segs[i];
    if (Math.abs(p.x2 - q.x1) > EPS || Math.abs(p.y2 - q.y1) > EPS) continue;
    const horizontalPrev = Math.abs(p.y1 - p.y2) < EPS;
    const horizontalNext = Math.abs(q.y1 - q.y2) < EPS;
    if (horizontalPrev !== horizontalNext) n += 1;
  }
  return n;
}

/** Translate a box by (dx, dy). */
function translateBox(b, dx, dy) {
  return { x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy };
}

module.exports = {
  EPS,
  round,
  rotate,
  pinTip,
  rect,
  bboxOfPoints,
  expand,
  rectsOverlap,
  rectContains,
  rectContainsRect,
  segLen,
  isOrthogonal,
  segIntersectsRect,
  segsIntersect,
  pointSegDist,
  orthoPath,
  bends,
  translateBox
};
