#!/usr/bin/env node
// padcheck.js — true-polygon pad/via/hole/mask/body sign-off gate.
//
//   node scripts/padcheck.js --dir <project> [--pcb <title|file>] [--json] [--strict]
//   node scripts/padcheck.js --pcb <file.epcb2> [--json]
//
// The client DRC is a 2D connectivity/clearance check. This gate is deliberately
// independent of it: it parses the client-written .epcb2 with real pad/via/hole
// polygons and catches the classes the client DRC does not report, in particular
// same-net pads belonging to different components that touch or overlap.
//
// Run after layout, routing, copper pour, and again before Gerber export.
// Exit code 1 when any ERROR is found (0 when only warnings, unless --strict).
'use strict';
const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');
const STRICT = ARGS.includes('--strict');
function argValue(name) {
  const i = ARGS.indexOf(name);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : null;
}
const DIR = argValue('--dir');
const PCB_ARG = argValue('--pcb');
function findPcb() {
  if (PCB_ARG) {
    let p = PCB_ARG;
    if (!p.toLowerCase().endsWith('.epcb2') && DIR) p = path.join(DIR, 'pcb', p + '.epcb2');
    if (!path.isAbsolute(p)) p = path.resolve(p);
    if (!fs.existsSync(p)) throw new Error(`PCB file not found: ${p}`);
    return p;
  }
  if (!DIR) throw new Error('usage: node scripts/padcheck.js --dir <project> [--pcb <title|file>] [--json] [--strict]');
  const pcbDir = path.join(DIR, 'pcb');
  if (!fs.existsSync(pcbDir)) throw new Error(`no pcb/ directory in ${DIR}`);
  const files = fs.readdirSync(pcbDir).filter((f) => f.toLowerCase().endsWith('.epcb2'));
  if (files.length === 1) return path.join(pcbDir, files[0]);
  if (!files.length) throw new Error(`no .epcb2 file in ${pcbDir}`);
  throw new Error(`multiple PCBs in ${pcbDir}; choose one with --pcb <title>: ${files.join(', ')}`);
}
let FILE;
try { FILE = findPcb(); } catch (e) { console.error('padcheck: ' + e.message); process.exit(2); }
const MIL = 0.0254;                 // mil -> mm
const MASK_RULE = 2 * MIL;          // 0.0508 mm default solder mask expansion
const VIA_TENT = -25.4 * MIL;       // rule default (fully tented)
const EDGE_WARN = 0.2, EDGE_ERR = 0.1;
const PAD_GAP_ERR = 0.15;           // 6 mil pad-pad clearance
const PAD_GAP_WARN = 0.2;
const SAME_NET_GAP_WARN = 0.1;
const INTRA_ERR = 0.076;            // 3 mil same-component pad gap
const INTRA_WARN = 0.127;           // 5 mil
const MASK_DAM_WARN = 0.1;
const HOLE_HOLE = 0.3;
const HOLE_PAD = 0.2;

function parseLine(l) {
  const k = l.indexOf('||');
  if (k < 0) return null;
  try { return [JSON.parse(l.slice(0, k)), JSON.parse(l.slice(k + 2).replace(/\|\s*$/, ''))]; }
  catch (e) { return null; }
}
const docs = [];
{
  let cur = null;
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    const r = parseLine(line);
    if (!r) continue;
    const [h, b] = r;
    if (h.type === 'DOCHEAD') { cur = { head: b, recs: [] }; docs.push(cur); continue; }
    if (!cur) continue;
    cur.recs.push([h, b]);
  }
}
const pcbDoc = docs.find(d => d.head.docType === 'PCB');
if (!pcbDoc) throw new Error('no PCB doc in ' + FILE);

// ---------- geometry ----------
const EPS = 1e-9;
function rotate(p, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}
function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
function ccw(poly) { return area(poly) < 0 ? poly.slice().reverse() : poly; }
function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1 };
}
function bboxGap(a, b) {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}
function segDist(p, q, a, b) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((a.x - p.x) * dx + (a.y - p.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ux = p.x + t * dx, uy = p.y + t * dy;
  let t2 = L2 ? ((b.x - p.x) * dx + (b.y - p.y) * dy) / L2 : 0;
  t2 = Math.max(0, Math.min(1, t2));
  const vx = p.x + t2 * dx, vy = p.y + t2 * dy;
  return Math.min(Math.hypot(a.x - ux, a.y - uy), Math.hypot(b.x - vx, b.y - vy));
}
function segSegDist(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  const ptSeg = (p, s, e) => { const vx = e.x - s.x, vy = e.y - s.y; const L2 = vx * vx + vy * vy; let t = L2 ? ((p.x - s.x) * vx + (p.y - s.y) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - (s.x + t * vx), p.y - (s.y + t * vy)); };
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
function clipConvex(subject, clip) {
  // Sutherland–Hodgman; clip must be convex, any orientation handled below
  let out = subject.slice();
  const cl = ccw(clip);
  for (let i = 0; i < cl.length && out.length; i++) {
    const A = cl[i], B = cl[(i + 1) % cl.length];
    const side = p => (B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x);
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + input.length - 1) % input.length];
      const sp = side(P), sq = side(Q);
      const pin = sp >= -EPS, qin = sq >= -EPS;
      if (pin) {
        if (!qin) {
          const t = sq / (sq - sp);
          out.push({ x: Q.x + t * (P.x - Q.x), y: Q.y + t * (P.y - Q.y) });
        }
        out.push(P);
      } else if (qin) {
        const t = sq / (sq - sp);
        out.push({ x: Q.x + t * (P.x - Q.x), y: Q.y + t * (P.y - Q.y) });
      }
    }
  }
  return out.length >= 3 ? out : [];
}
function interArea(a, b) {
  const ba = bbox(a), bb = bbox(b);
  if (bboxGap(ba, bb) > 0) return 0;
  const c = clipConvex(a, b);
  return c.length >= 3 ? Math.abs(area(c)) : 0;
}
function polyGap(a, b) {
  const ba = bbox(a), bb = bbox(b);
  const bg = bboxGap(ba, bb);
  if (bg > 0.35) return bg;
  if (interArea(a, b) > 1e-6) return 0;
  let d = Infinity;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const u = b[j], v = b[(j + 1) % b.length];
      const dd = Math.min(segDist(p, q, u, v), segDist(u, v, p, q));
      if (dd < d) d = dd;
    }
  }
  return d;
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function circlePoly(cx, cy, r, n = 32) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return p;
}
function ellipsePoly(cx, cy, w, h, n = 48) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + (w / 2) * Math.cos(a), y: cy + (h / 2) * Math.sin(a) }); }
  return p;
}
function rectPoly(cx, cy, w, h) {
  return [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 }];
}
function stadiumPoly(cx, cy, long, short, axis) {
  // axis 'x' or 'y'; long along axis
  const r = short / 2, L = (long - short) / 2;
  const p = [];
  const n = 16;
  if (axis === 'x') {
    for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + Math.PI * i / n; p.push({ x: cx + L + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    for (let i = 0; i <= n; i++) { const a = Math.PI / 2 + Math.PI * i / n; p.push({ x: cx - L + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  } else {
    for (let i = 0; i <= n; i++) { const a = Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + L + r * Math.sin(a) }); }
    for (let i = 0; i <= n; i++) { const a = Math.PI + Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy - L + r * Math.sin(a) }); }
  }
  return p;
}
function pathPoly(pathArr) {
  // [x,y,"L",x,y,x,y,...] or [x,y,"A",...] (A not needed on this board)
  const out = [{ x: pathArr[0], y: pathArr[1] }];
  let i = 2;
  while (i < pathArr.length) {
    const tok = pathArr[i++];
    if (tok === 'L') {
      while (i + 1 < pathArr.length && typeof pathArr[i] === 'number') { out.push({ x: pathArr[i], y: pathArr[i + 1] }); i += 2; }
    } else if (typeof tok === 'number') { out.push({ x: tok, y: pathArr[i++] }); }
    else { break; }
  }
  return out;
}
function roundedRectPoly(x, yTop, w, h, r, n = 16) {
  const x0 = x, x1 = x + w, y0 = yTop - h, y1 = yTop;
  const q = [];
  const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; q.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } };
  arc(x1 - r, y1 - r, 0, Math.PI / 2);
  arc(x0 + r, y1 - r, Math.PI / 2, Math.PI);
  arc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
  arc(x1 - r, y0 + r, Math.PI * 1.5, Math.PI * 2);
  return q;
}
function offsetFromAngle(x, y, ang) {
  const a = ang * Math.PI / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return { x: x * c - y * s, y: x * s + y * c };
}

// ---------- footprint / component data ----------
const foots = {};      // uuid -> { pads, body: [paths] }
const devFoot = {};
for (const d of docs) {
  if (d.head.docType === 'FOOTPRINT') {
    const pads = [], body = [];
    for (const [h, b] of d.recs) {
      if (h.type === 'PAD') pads.push(b);
      if (h.type === 'POLY' && b.layerId === 48) body.push(b.path);
    }
    foots[d.head.uuid] = { pads, body };
  }
  if (d.head.docType === 'DEVICE') {
    for (const [h, b] of d.recs) {
      if (h.type === 'META' && b.attributes && b.attributes.Footprint) devFoot[d.head.uuid] = b.attributes.Footprint;
    }
  }
}

const comps = [], desig = {}, padnet = {};
const boardPads = [], vias = [], tracks = [];
let outlinePath = null;
for (const [h, b] of pcbDoc.recs) {
  if (h.type === 'COMPONENT') {
    let dev = null;
    try { dev = JSON.parse(b.attrs.DeviceName || '{}').uuid || null; } catch (e) {}
    comps.push({ id: h.id, x: b.x, y: b.y, angle: b.angle || 0, layer: b.layerId, dev });
  } else if (h.type === 'ATTR' && b.key === 'Designator' && b.parentId) desig[b.parentId] = b.value;
  else if (h.type === 'PAD_NET') {
    let key = null; try { key = JSON.parse(h.id); } catch (e) {}
    if (Array.isArray(key) && key[0] === 'PAD_NET') padnet[key[1] + '|' + key[2]] = b.padNet;
  } else if (h.type === 'PAD') boardPads.push(b);
  else if (h.type === 'VIA') vias.push(b);
  else if (h.type === 'LINE') tracks.push({ id: h.id, ref: 'TRK#' + h.id.slice(0, 6), net: b.netName || '', layer: b.layerId, x1: Number(b.startX) * MIL, y1: Number(b.startY) * MIL, x2: Number(b.endX) * MIL, y2: Number(b.endY) * MIL, w: (Number(b.width) || 0) * MIL });
  else if (h.type === 'POLY' && b.layerId === 11) outlinePath = b.path;
}

// ---------- build objects ----------
const pads = [];
function padPolygon(pad, angle, origin) {
  const dp = pad.defaultPad || {};
  const w = (Number(dp.width) || 0) * MIL, hh = (Number(dp.height) || 0) * MIL;
  let poly, cx, cy;
  if (dp.padType === 'POLYGON' && Array.isArray(dp.path)) {
    poly = pathPoly(dp.path).map(p => ({ x: p.x * MIL, y: p.y * MIL }));
    cx = origin ? origin.x * MIL : 0;
    cy = origin ? origin.y * MIL : 0;
  } else {
    if (dp.padType === 'OVAL') poly = stadiumPoly(0, 0, Math.max(w, hh), Math.min(w, hh), w >= hh ? 'x' : 'y');
    else if (dp.padType === 'ELLIPSE') poly = ellipsePoly(0, 0, w, hh);
    else poly = rectPoly(0, 0, w, hh);
    cx = pad.cx * MIL;
    cy = pad.cy * MIL;
  }
  return poly.map(p => { const r = rotate(p, angle); return { x: cx + r.x, y: cy + r.y }; });
}
function holePolygon(pad) {
  const hole = pad.hole;
  if (!hole) return null;
  const w = (Number(hole.width) || 0) * MIL, hh = (Number(hole.height) || 0) * MIL;
  if (w < 0.0003 && hh < 0.0003) return null;
  const cx = (pad.cx + (pad.holeOffsetX || 0)) * MIL, cy = (pad.cy + (pad.holeOffsetY || 0)) * MIL;
  let poly;
  if (hole.holeType === 'SLOT') {
    const padW = Number((pad.defaultPad || {}).width) || 0, padH = Number((pad.defaultPad || {}).height) || 0;
    const long = Math.max(w, hh), short = Math.min(w, hh);
    const axis = w >= hh ? 'x' : 'y';
    poly = stadiumPoly(0, 0, long, short, axis);
  } else if (Math.abs(w - hh) < 0.0003) poly = circlePoly(0, 0, w / 2);
  else poly = ellipsePoly(0, 0, w, hh);
  poly = poly.map(p => { const r = rotate(p, pad.angle || 0); return { x: cx + r.x, y: cy + r.y }; });
  return poly;
}

for (const c of comps) {
  const d = desig[c.id] || c.id.slice(0, 6);
  const fp = foots[devFoot[c.dev]];
  if (!fp) continue;
  for (const p of fp.pads) {
    const local = { x: Number(p.centerX) || 0, y: Number(p.centerY) || 0 };
    const off = offsetFromAngle(local.x, local.y, c.angle);
    const cx = c.x + off.x, cy = c.y + off.y;
    const net = padnet[c.id + '|' + p.num] || '';
    const pad = { owner: d, ref: d + '.' + p.num, num: String(p.num), net, kind: 'pad', component: d, cx, cy,
      defaultPad: p.defaultPad, padAngle: p.padAngle || 0, topMask: (p.topSolderExpansion == null ? MASK_RULE : Number(p.topSolderExpansion) * MIL),
      layer: p.layerId };
    pad.angle = c.angle + (p.padAngle || 0);
    pad.poly = padPolygon(pad, c.angle, { x: c.x, y: c.y });
    pad.bbox = bbox(pad.poly);
    pads.push(pad);
    const hp = holePolygon({ cx, cy, hole: p.hole, holeOffsetX: p.holeOffsetX, holeOffsetY: p.holeOffsetY,
      defaultPad: p.defaultPad, angle: c.angle + (p.padAngle || 0) });
    if (hp) {
      const h = { owner: d, ref: d + '.' + p.num, num: String(p.num), net, kind: 'hole', component: d,
        poly: hp, bbox: bbox(hp), cx, cy };
      pads.push(h);
    }
  }
}
for (const p of boardPads) {
  const isMH = !p.netName;
  const owner = (isMH ? 'MH#' : 'TP#') + Math.round(Number(p.centerX) * 100) + '_' + Math.round(Number(p.centerY) * 100);
  if (p.plated === false && !p.netName) {
    const hp = holePolygon({ cx: Number(p.centerX), cy: Number(p.centerY), hole: p.hole, holeOffsetX: p.holeOffsetX, holeOffsetY: p.holeOffsetY, defaultPad: p.defaultPad, angle: p.padAngle || 0 });
    if (hp) pads.push({ owner, ref: owner, num: '', net: '', kind: 'hole', component: null, poly: hp, bbox: bbox(hp), cx: Number(p.centerX), cy: Number(p.centerY) });
    continue;
  }
  const pad = { owner, ref: owner, num: String(p.num || ''), net: p.netName || '', kind: 'pad', component: null,
    cx: Number(p.centerX), cy: Number(p.centerY), defaultPad: p.defaultPad, padAngle: p.padAngle || 0,
    topMask: (p.topSolderExpansion == null ? MASK_RULE : Number(p.topSolderExpansion) * MIL), layer: p.layerId };
  pad.angle = p.padAngle || 0;
  pad.poly = padPolygon(pad, 0, null);
  pad.bbox = bbox(pad.poly);
  pads.push(pad);
  const hp = holePolygon({ cx: pad.cx, cy: pad.cy, hole: p.hole, holeOffsetX: p.holeOffsetX, holeOffsetY: p.holeOffsetY,
    defaultPad: p.defaultPad, angle: p.padAngle || 0 });
  if (hp) pads.push({ owner, ref: owner, num: pad.num, net: pad.net, kind: 'hole', component: null,
    poly: hp, bbox: bbox(hp), cx: pad.cx, cy: pad.cy });
}
const viaObjs = vias.map(v => {
  const cx = Number(v.centerX) * MIL, cy = Number(v.centerY) * MIL, dia = Number(v.viaDiameter) * MIL, hd = Number(v.holeDiameter) * MIL;
  const mask = v.topSolderExpansion == null ? VIA_TENT : Number(v.topSolderExpansion) * MIL;
  const owner = 'VIA#' + (v.id || Math.round(Number(v.centerX)) + '_' + Math.round(Number(v.centerY)));
  return { owner, ref: owner, num: '', net: v.netName || '', kind: 'via', component: null, cx, cy,
    poly: circlePoly(cx, cy, dia / 2, 24), bbox: null, hole: circlePoly(cx, cy, hd / 2, 24), mask };
}).map(v => ({ ...v, bbox: bbox(v.poly) }));

// ---------- board edge ----------
const outline = outlinePath && outlinePath[0] === 'R'
  ? roundedRectPoly(outlinePath[1] * MIL, outlinePath[2] * MIL, outlinePath[3] * MIL, outlinePath[4] * MIL, (outlinePath[6] || 0) * MIL, 16)
  : null;
const outlineBBox = outline ? bbox(outline) : null;

// ---------- checks ----------
const errors = [], warns = [];
const E = (kind, msg, a, b, extra) => errors.push({ kind, msg, a: a && a.ref, an: a && a.net, b: b && b.ref, bn: b && b.net, ...extra });
const W = (kind, msg, a, b, extra) => warns.push({ kind, msg, a: a && a.ref, an: a && a.net, b: b && b.ref, bn: b && b.net, ...extra });
const fmt = n => (Math.round(n * 1000) / 1000).toFixed(3);

// pad-pad
const solid = pads.filter(o => o.kind === 'pad');
for (let i = 0; i < solid.length; i++) {
  for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    const bg = bboxGap(a.bbox, b.bbox);
    const sameOwner = a.owner === b.owner;
    const sameNet = a.net && a.net === b.net;
    if (sameOwner) {
      if (bg > INTRA_WARN) continue;
      const g = polyGap(a.poly, b.poly);
      if (g < INTRA_ERR) E('INTRA', `same-component pad gap ${fmt(g)}mm`, a, b, { gap: g });
      else if (g < INTRA_WARN) W('INTRA', `same-component pad gap ${fmt(g)}mm`, a, b, { gap: g });
      continue;
    }
    if (bg > 0.25) continue;
    const areaOv = interArea(a.poly, b.poly);
    const g = areaOv > 1e-6 ? 0 : polyGap(a.poly, b.poly);
    if (areaOv > 1e-6) {
      if (sameNet) E('SAME_NET_OVERLAP', `same-net different-component pads overlap ${fmt(areaOv)}mm²`, a, b, { area: areaOv });
      else E('SHORT', `different-net pads overlap ${fmt(areaOv)}mm²`, a, b, { area: areaOv });
    } else if (!sameNet && g < PAD_GAP_ERR) E('CLEARANCE', `pad gap ${fmt(g)}mm < 6mil`, a, b, { gap: g });
    else if (!sameNet && g < PAD_GAP_WARN) W('CLEARANCE', `pad gap ${fmt(g)}mm`, a, b, { gap: g });
    else if (sameNet && g < SAME_NET_GAP_WARN) W('SAME_NET_NEAR', `same-net pad gap ${fmt(g)}mm`, a, b, { gap: g });
    if (!sameNet) {
      const dam = g - a.topMask - b.topMask;
      if (dam < 0) E('MASK_MERGE', `different-net mask openings overlap (${fmt(dam)}mm)`, a, b, { gap: dam });
      else if (dam < MASK_DAM_WARN) W('MASK_DAM', `solder-mask dam ${fmt(dam)}mm`, a, b, { gap: dam });
    }
  }
}
// track-track (different nets, same layer)
for (let i = 0; i < tracks.length; i++) {
  for (let j = i + 1; j < tracks.length; j++) {
    const a = tracks[i], b = tracks[j];
    if (a.layer !== b.layer || !a.net || !b.net || a.net === b.net) continue;
    const ab = { x0: Math.min(a.x1, a.x2) - a.w / 2, x1: Math.max(a.x1, a.x2) + a.w / 2, y0: Math.min(a.y1, a.y2) - a.w / 2, y1: Math.max(a.y1, a.y2) + a.w / 2 };
    const bb = { x0: Math.min(b.x1, b.x2) - b.w / 2, x1: Math.max(b.x1, b.x2) + b.w / 2, y0: Math.min(b.y1, b.y2) - b.w / 2, y1: Math.max(b.y1, b.y2) + b.w / 2 };
    if (bboxGap(ab, bb) > 0.2) continue;
    const g = segSegDist({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }) - (a.w + b.w) / 2;
    if (g < 0.1524) E('TRACK_CLEAR', `different-net track gap ${fmt(g)}mm < 6mil`, a, b, { gap: g });
    else if (g < 0.2) W('TRACK_CLEAR', `different-net track gap ${fmt(g)}mm`, a, b, { gap: g });
  }
}
// pad-via
for (const p of solid) {
  for (const v of viaObjs) {
    const bg = bboxGap(p.bbox, v.bbox);
    if (bg > 0.25) continue;
    const areaOv = interArea(p.poly, v.poly);
    const g = areaOv > 1e-6 ? 0 : polyGap(p.poly, v.poly);
    const sameNet = p.net && p.net === v.net;
    if (areaOv > 1e-6) {
      if (sameNet) W('VIA_IN_PAD', `same-net via inside pad ${fmt(areaOv)}mm²`, p, v, { area: areaOv });
      else E('PAD_VIA', `via overlaps pad (${fmt(areaOv)}mm²)`, p, v, { area: areaOv });
    } else if (!sameNet && g < 0.15) E('PAD_VIA', `pad-via gap ${fmt(g)}mm`, p, v, { gap: g });
    else if (!sameNet && g < 0.2) W('PAD_VIA', `pad-via gap ${fmt(g)}mm`, p, v, { gap: g });
  }
}
// via-via + holes
for (let i = 0; i < viaObjs.length; i++) {
  for (let j = i + 1; j < viaObjs.length; j++) {
    const a = viaObjs[i], b = viaObjs[j];
    if (bboxGap(a.bbox, b.bbox) > HOLE_HOLE + 0.5) continue;
    const hg = polyGap(a.hole, b.hole);
    if (hg < HOLE_HOLE) E('HOLE_HOLE', `via hole-to-hole ${fmt(hg)}mm < 0.3mm`, a, b, { gap: hg });
    const g = polyGap(a.poly, b.poly);
    if (g < 0.1) E('VIA_VIA', `via copper gap ${fmt(g)}mm`, a, b, { gap: g });
  }
}
const holeObjs = pads.filter(o => o.kind === 'hole');
// hole vs other pads
for (const h of holeObjs) {
  for (const p of solid) {
    if (p.owner === h.owner) continue;
    if (bboxGap(h.bbox, p.bbox) > HOLE_PAD + 0.2) continue;
    const areaOv = interArea(h.poly, p.poly);
    const g = areaOv > 1e-6 ? 0 : polyGap(h.poly, p.poly);
    if (areaOv > 1e-6) E('HOLE_PAD', `hole intersects pad copper ${fmt(areaOv)}mm²`, p, h, { area: areaOv });
    else if (g < HOLE_PAD) E('HOLE_PAD', `hole-to-pad ${fmt(g)}mm < 0.2mm`, p, h, { gap: g });
  }
}
// hole-hole (pads + vias)
const allHoles = holeObjs.concat(viaObjs.map(v => ({ owner: v.owner, ref: v.ref, net: v.net, kind: 'hole', poly: v.hole, bbox: bbox(v.hole) })));
for (let i = 0; i < allHoles.length; i++) {
  for (let j = i + 1; j < allHoles.length; j++) {
    const a = allHoles[i], b = allHoles[j];
      if (bboxGap(a.bbox, b.bbox) > HOLE_HOLE + 0.5) continue;
    const g = polyGap(a.poly, b.poly);
    if (g < HOLE_HOLE) E('HOLE_HOLE', `drill hole-to-hole ${fmt(g)}mm < 0.3mm`, a, b, { gap: g });
  }
}
// board edge
function boundaryGap(a, b) {
  let d = Infinity;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const u = b[j], v = b[(j + 1) % b.length];
      const dd = Math.min(segDist(p, q, u, v), segDist(u, v, p, q));
      if (dd < d) d = dd;
    }
  }
  return d;
}
if (outline) {
  for (const p of solid.concat(viaObjs)) {
    const poly = p.poly;
    let outside = false;
    for (const pt of poly) if (!pointInPoly(pt, outline)) { outside = true; break; }
    const g = outside ? 0 : boundaryGap(poly, outline);
    if (outside) E('EDGE', `copper outside board outline`, p, null, { gap: g });
    else if (g < EDGE_ERR) E('EDGE', `copper-to-board-edge ${fmt(g)}mm`, p, null, { gap: g });
    else if (g < EDGE_WARN) W('EDGE', `copper-to-board-edge ${fmt(g)}mm`, p, null, { gap: g });
  }
  for (const h of allHoles) {
    let outside = false;
    for (const pt of h.poly) if (!pointInPoly(pt, outline)) { outside = true; break; }
    const g = outside ? 0 : boundaryGap(h.poly, outline);
    if (outside) E('HOLE_EDGE', `drill outside board outline`, h, null, { gap: g });
    else if (g < HOLE_HOLE) W('HOLE_EDGE', `drill-to-board-edge ${fmt(g)}mm`, h, null, { gap: g });
  }
}
// component body keepout (layer 48 bodies transformed to board coords)
const bodyPolys = [];
for (const c of comps) {
  const d = desig[c.id] || c.id.slice(0, 6);
  const fp = foots[devFoot[c.dev]];
  if (!fp) continue;
  for (const pathArr of fp.body) {
    const local = pathPoly(pathArr).map(p => ({ x: p.x * MIL, y: p.y * MIL }));
    const poly = local.map(p => { const r = offsetFromAngle(p.x, p.y, c.angle); return { x: c.x * MIL + r.x, y: c.y * MIL + r.y }; });
    bodyPolys.push({ owner: d, ref: d, poly, bbox: bbox(poly) });
  }
}
for (const body of bodyPolys) {
  for (const p of solid) {
    if (p.owner === body.owner) continue;
    if (bboxGap(p.bbox, body.bbox) > 0.2) continue;
    if (pointInPoly({ x: p.cx * MIL, y: p.cy * MIL }, body.poly) || interArea(p.poly, body.poly) > 1e-6) {
      E('BODY', `pad under ${body.ref} body`, p, body, {});
    }
  }
  for (const v of viaObjs) {
    if (v.mask < 0) continue; // tented vias may sit under bodies
    if (bboxGap(v.bbox, body.bbox) > 0.2) continue;
    if (pointInPoly({ x: v.cx, y: v.cy }, body.poly)) E('BODY', `open via under ${body.ref} body`, v, body, {});
  }
}

// same-net/different-component summary (the upstream sign-off gap)
const sameNetOverlaps = errors.filter(e => e.kind === 'SAME_NET_OVERLAP');

// ---------- output ----------
const report = {
  file: FILE,
  counts: { pads: solid.length, holes: allHoles.length, vias: viaObjs.length, components: comps.length, bodies: bodyPolys.length },
  errors, warnings: warns,
  summary: errors.reduce((m, e) => (m[e.kind] = (m[e.kind] || 0) + 1, m), {}),
  warningSummary: warns.reduce((m, w) => (m[w.kind] = (m[w.kind] || 0) + 1, m), {}),
};
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 1));
} else {
  console.log(`padcheck: ${path.relative(process.cwd(), FILE)}`);
  console.log(`objects: pads ${solid.length}, holes ${allHoles.length}, vias ${viaObjs.length}, bodies ${bodyPolys.length}`);
  console.log(`ERRORS ${errors.length}, warnings ${warns.length}`);
  const show = (label, arr) => {
    for (const e of arr) {
      console.log(`${label} ${e.kind.padEnd(16)} ${e.msg}`);
      console.log(`   ${e.a || '-'}${e.an ? '(' + e.an + ')' : ''} <-> ${e.b || '-'}${e.bn ? '(' + e.bn + ')' : ''}${e.gap != null ? ' gap=' + fmt(e.gap) + 'mm' : ''}${e.area != null ? ' area=' + fmt(e.area) + 'mm²' : ''}`);
    }
  };
  show('E', errors);
  show('W', warns);
}
if (errors.length || (STRICT && warns.length)) process.exit(1);
