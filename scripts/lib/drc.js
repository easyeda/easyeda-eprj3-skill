'use strict';
/**
 * drc.js — PCB design rule check.
 *
 * Reads the finished .epcb2 (not the plan), so it judges what is actually in
 * the file: copper spacing, track width, board-edge clearance, unrouted nets
 * and pour presence. Everything is AABB geometry — good enough for the boards
 * this skill produces, and it never depends on the router's own bookkeeping.
 *
 * Codes:
 *   D001 copper-to-copper spacing below clearance (different nets); also
 *        two pads of ONE footprint overlapping on different nets — that is a
 *        shorted land pattern, not a spacing quibble
 *   D002 track width below the minimum
 *   D003 copper too close to the board edge (measured against the real
 *        outline polygon when the path has 3+ points, not its bbox)
 *   D004 net with 2+ pads is not fully connected by copper
 *   D005 board outline missing / degenerate
 *   D006 no copper pour on a ground net (warning)
 *   D007 pad with no net (warning)
 *   D008 via drill/size out of range
 *   D009 drill below the manufacturing minimum (DFM)
 *   D010 annular ring below the minimum (DFM, warning)
 *   D011 silkscreen text overlapping a copper pad (DFM, warning)
 *   D012 same-net track segments meeting at an acute angle (DFM, warning)
 *   D013 footprint body extents overlap (DFM/error)
 *   D014 footprint body outside the board outline (error)
 */

const fs = require('fs');
const E = require('./eprj3');
const G = require('./geom');
const P = require('./parts');

const RULES = {
  D001: { level: 'error', weight: 12, text: 'copper-to-copper spacing' },
  D002: { level: 'error', weight: 8, text: 'track narrower than the minimum' },
  D003: { level: 'error', weight: 8, text: 'copper too close to the board edge' },
  D004: { level: 'error', weight: 12, text: 'net not fully routed' },
  D005: { level: 'error', weight: 10, text: 'board outline missing or degenerate' },
  D006: { level: 'warn', weight: 4, text: 'no ground pour' },
  D007: { level: 'warn', weight: 2, text: 'pad without a net' },
  D008: { level: 'warn', weight: 2, text: 'via geometry out of range' },
  D009: { level: 'error', weight: 6, text: 'drill below the manufacturing minimum' },
  D010: { level: 'warn', weight: 3, text: 'annular ring below the minimum' },
  D011: { level: 'warn', weight: 2, text: 'silkscreen text overlaps a pad' },
  D012: { level: 'warn', weight: 2, text: 'track bends at an acute angle' },
  D013: { level: 'error', weight: 6, text: 'footprint body extents overlap' },
  D014: { level: 'error', weight: 6, text: 'footprint body outside the board outline' }
};

// minDrill 12 mil = 0.30 mm (JLC basic process); minRing 4 mil ≈ 0.10 mm,
// deliberately below the ~0.15 mm most fabs ask for so the rule warns only on
// clear violations; minAngle 45 keeps a 45° corner/chamfer legal.
const DEFAULTS = { clearance: 10, minTrack: 8, edge: 12, viaMin: 16, viaMax: 60, minDrill: 12, minRing: 4, minAngle: 45 };

function docSplit(lines) {
  const docs = [];
  let cur = null;
  for (const l of lines) {
    if (E.isDocHeadLine(l)) {
      const r = E.parseRecord(l);
      cur = { docType: r && r.body && r.body.docType, uuid: r && r.body && r.body.uuid, records: [] };
      docs.push(cur);
    } else if (cur) {
      const r = E.parseRecord(l);
      if (r) cur.records.push(r);
    }
  }
  return docs;
}

/** Extract placed pads and copper from a PCB document. */
function pcbGeometry(file) {
  const lines = E.readLines(file);
  const docs = docSplit(lines);
  const main = docs.find((d) => d.docType === 'PCB') || docs[docs.length - 1]
    // empty/truncated PCB file → no records: D005 reports the missing outline
    || { docType: null, uuid: null, records: [] };
  const fpDocs = new Map();
  for (const d of docs) {
    if (d.docType === 'FOOTPRINT') fpDocs.set(d.uuid, d);
  }
  const recs = main.records;
  const refByComp = new Map();
  for (const r of recs) {
    if (r.type === 'ATTR' && r.body && r.body.key === 'Designator' && r.body.parentId) {
      refByComp.set(r.body.parentId, r.body.value);
    }
  }
  const netByPad = new Map();
  for (const r of recs) {
    if (r.type !== 'PAD_NET') continue;
    let parsed; try { parsed = JSON.parse(r.id); } catch { continue; }
    if (!Array.isArray(parsed) || parsed[0] !== 'PAD_NET') continue;
    netByPad.set(`${parsed[1]}|${parsed[2]}|${parsed[3]}`, r.body.padNet || '');
  }

  const pads = [];
  const footprints = [];   // body extents per placed footprint (courtyard proxy)
  for (const r of recs) {
    if (r.type !== 'COMPONENT') continue;
    const b = r.body || {};
    const ref = refByComp.get(r.id) || r.id;
    const fpAttr = recs.find((a) => a.type === 'ATTR' && a.body && a.body.key === 'Footprint' && a.body.parentId === r.id);
    const fpDoc = fpAttr ? fpDocs.get(fpAttr.body.value) : null;
    if (!fpDoc) continue;
    // Footprint body extent: the FOOTPRINT doc's PART BBOX rotated into board
    // coordinates. Pads-only fallback when the doc has no PART record.
    let bodyRect = null;
    const partRec = fpDoc.records.find((pr) => pr.type === 'PART' && pr.body && Array.isArray(pr.body.BBOX));
    if (partRec) {
      const [x1, y1, x2, y2] = partRec.body.BBOX;
      const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
        .map(([cx, cy]) => G.rotate(cx, cy, b.angle || 0))
        .map((p) => ({ x: G.round(b.x + p.x), y: G.round(b.y + p.y) }));
      bodyRect = G.bboxOfPoints(corners);
    }
    for (const pr of fpDoc.records) {
      if (pr.type !== 'PAD') continue;
      const pb = pr.body;
      const d = pb.defaultPad || {};
      const off = G.rotate(pb.centerX, pb.centerY, b.angle || 0);
      const net = netByPad.get(`${r.id}|${pb.num}|${pr.id}`) || netByPad.get(`${r.id}|${pb.num}|${pb.elemId}`) || '';
      // A pad rotated with the part no longer keeps its w/h orientation: the
      // world AABB of a w×h pad turned by θ is (w|cosθ|+h|sinθ|, w|sinθ|+h|cosθ|).
      // Using the raw w/h judged a 90° SOP pad by its SHORT side and let
      // neighbours closer than the clearance pass.
      const rot = ((b.angle || 0) + (pb.padAngle || 0)) * Math.PI / 180;
      const cos = Math.abs(Math.cos(rot)); const sin = Math.abs(Math.sin(rot));
      const pw = d.width || 20; const ph = d.height || 20;
      pads.push({
        ref,
        num: String(pb.num),
        net,
        x: G.round(b.x + off.x),
        y: G.round(b.y + off.y),
        w: G.round(pw * cos + ph * sin),
        h: G.round(pw * sin + ph * cos),
        hole: typeof pb.hole === 'number' ? pb.hole : pb.hole?.width || null,
        layer: (pb.layerId === 1 && b.layerId === 2 ? 2 : pb.layerId) || 1
      });
    }
    if (!bodyRect && pads.length) {
      const mine = pads.filter((p) => p.ref === ref);
      if (mine.length) bodyRect = G.bboxOfPoints(mine.flatMap((p) => {
        const r2 = padRect(p);
        return [[r2.x1, r2.y1], [r2.x2, r2.y1], [r2.x2, r2.y2], [r2.x1, r2.y2]].map(([x, y]) => ({ x, y }));
      }));
    }
    if (bodyRect) footprints.push({ ref, rect: bodyRect, layer: b.layerId || 1 });
  }

  const tracks = [];
  const vias = [];
  const pours = [];
  const regions = [];    // pour/fill copper regions with readable geometry
  const strings = [];
  let outline = null;
  let outlinePts = null;
  // POUR/FILL paths are complex polygons: the outer array holds subpaths and
  // the FIRST one is the outline (the format docs decode path = path[0]).
  const regionPoly = (path) => {
    if (!Array.isArray(path) || !path.length) return null;
    const sub = Array.isArray(path[0]) ? path[0] : path;
    const pts = P.pathToPoints(sub);
    return pts.length >= 3 ? pts : null;
  };
  for (const r of recs) {
    if (r.type === 'LINE' && r.body) {
      tracks.push({
        net: r.body.netName || '',
        layer: r.body.layerId,
        x1: r.body.startX, y1: r.body.startY,
        x2: r.body.endX, y2: r.body.endY,
        width: r.body.width || 10
      });
    } else if (r.type === 'VIA' && r.body) {
      // The PCB format spells vias centerX/centerY/viaDiameter/holeDiameter;
      // accept x/y/width/hole too (older/plan shapes).
      vias.push({
        net: r.body.netName || '',
        x: r.body.centerX !== undefined ? r.body.centerX : r.body.x,
        y: r.body.centerY !== undefined ? r.body.centerY : r.body.y,
        width: r.body.viaDiameter !== undefined ? r.body.viaDiameter : (r.body.width || 24),
        hole: r.body.holeDiameter !== undefined ? r.body.holeDiameter : (r.body.hole || 12)
      });
    } else if (r.type === 'POUR' && r.body) {
      pours.push({ net: r.body.netName || '', layer: r.body.layerId });
      const pts = regionPoly(r.body.path);
      if ((r.body.netName || '') && pts) regions.push({ net: r.body.netName, layer: r.body.layerId || 1, pts });
    } else if (r.type === 'FILL' && r.body && r.body.netName) {
      // solid copper of a filled region: same connectivity role as a pour
      const pts = regionPoly(r.body.path);
      if (pts) regions.push({ net: r.body.netName, layer: r.body.layerId || 1, pts });
    } else if (r.type === 'STRING' && r.body) {
      strings.push({
        text: String(r.body.text === undefined ? '' : r.body.text),
        x: r.body.x, y: r.body.y,
        layer: r.body.layerId,
        fontSize: r.body.fontSize || 60,
        angle: r.body.angle || 0,
        origin: r.body.origin || 'CENTER_MIDDLE'
      });
    } else if (r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE') {
      // the outline appears both flat (builder's rectPath) and wrapped as a
      // complex polygon (client saves) — decode either
      const raw = Array.isArray(r.body.path) && Array.isArray(r.body.path[0]) ? r.body.path[0] : r.body.path;
      const pts = P.pathToPoints(raw);
      const bb = G.bboxOfPoints(pts);
      if (bb) outline = bb;
      if (pts.length >= 3) outlinePts = pts;
    }
  }
  return { pads, footprints, tracks, vias, pours, regions, strings, outline, outlinePts };
}

function segRect(t) {
  const half = (t.width || 10) / 2;
  return G.rect(
    Math.min(t.x1, t.x2) - half, Math.min(t.y1, t.y2) - half,
    Math.max(t.x1, t.x2) + half, Math.max(t.y1, t.y2) + half
  );
}

function padRect(p) {
  return G.rect(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2);
}

function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x1 - b.x2, b.x1 - a.x2));
  const dy = Math.max(0, Math.max(a.y1 - b.y2, b.y1 - a.y2));
  return Math.hypot(dx, dy);
}

function rectEdgeGap(r, board) {
  const gaps = [r.x1 - board.x1, board.x2 - r.x2, r.y1 - board.y1, board.y2 - r.y2];
  return Math.min(...gaps);
}

function rectCorners(r) {
  return [
    { x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 },
    { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }
  ];
}

/** Even-odd ray casting; a point on the boundary counts as inside. */
function pointInPoly(pt, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]; const b = pts[j];
    const onSegment = Math.min(a.x, b.x) - 1e-9 <= pt.x && pt.x <= Math.max(a.x, b.x) + 1e-9
      && Math.min(a.y, b.y) - 1e-9 <= pt.y && pt.y <= Math.max(a.y, b.y) + 1e-9
      && Math.abs((b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y)) < 1e-6;
    if (onSegment) return true;
    if ((a.y > pt.y) !== (b.y > pt.y)
      && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from a segment to a rect: 0 when they touch, else the closest
 *  rect-corner to the segment. */
function segRectDist(seg, rect) {
  const ends = [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }];
  if (ends.some((p) => G.rectContains(rect, p))) return 0;
  if (G.segIntersectsRect(seg, rect)) return 0;
  return Math.min(...rectCorners(rect).map((c) => G.pointSegDist(c, seg)));
}

// Silk text has no stored bbox: the client renders it from the anchor, so the
// checker estimates one. A glyph cell of 0.6×0.7 em is roughly where Helvetica
// lands; the estimate only feeds a warning, so it errs slightly generous.
const GLYPH_W = 0.6;
const GLYPH_H = 0.7;

function stringRect(s) {
  if (typeof s.x !== 'number' || typeof s.y !== 'number' || !s.text) return null;
  const rows = s.text.split(/\r?\n/);
  const w = rows.reduce((n, r) => Math.max(n, r.length), 0) * s.fontSize * GLYPH_W;
  const h = rows.length * s.fontSize * GLYPH_H;
  const o = String(s.origin || 'CENTER_MIDDLE');
  const x0 = o.indexOf('LEFT') === 0 ? 0 : o.indexOf('RIGHT') === 0 ? -w : -w / 2;
  const y0 = o.indexOf('TOP') >= 0 ? -h : o.indexOf('MIDDLE') >= 0 ? -h / 2 : 0;
  const corners = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
    .map(([dx, dy]) => G.rotate(dx, dy, s.angle || 0));
  return G.bboxOfPoints(corners.map((c) => ({ x: c.x + s.x, y: c.y + s.y })));
}

/** Interior angle (deg) between two segments' far vectors at a shared vertex. */
function jointAngle(a, b) {
  const l1 = Math.hypot(a.vx, a.vy);
  const l2 = Math.hypot(b.vx, b.vy);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  const cos = Math.max(-1, Math.min(1, (a.vx * b.vx + a.vy * b.vy) / (l1 * l2)));
  return Math.acos(cos) * 180 / Math.PI;
}

/**
 * @param file  pcb document path
 * @param opts  {rules, pourNet, netWidths:{net:mil}, placedOnly}
 *
 * placedOnly — the board ships as a placement deliverable: D004 (net fully
 * routed) and D006 (ground pour exists) judge copper that was never promised,
 * so they are skipped. Pass false for a routed board; leave undefined and the
 * mode is read off the file itself (no tracks → nothing was routed).
 */
function runDrc(file, opts) {
  const given = (opts && opts.rules) || {};
  // Undefined overrides must not clobber the defaults.
  for (const k of Object.keys(given)) if (given[k] === undefined) delete given[k];
  const rules = Object.assign({}, DEFAULTS, given);
  const netWidths = (opts && opts.netWidths) || {};
  const pourNet = (opts && opts.pourNet) || 'GND';
  const findings = [];
  const add = (code, msg, extra) => findings.push(Object.assign({
    code, level: RULES[code].level, msg
  }, extra || {}));

  const geo = pcbGeometry(file);
  const placedOnly = opts && opts.placedOnly !== undefined
    ? !!opts.placedOnly
    : geo.tracks.length === 0;

  // D005 — outline
  if (!geo.outline) {
    add('D005', 'no BOARD_OUTLINE poly in the PCB document');
  } else if ((geo.outline.x2 - geo.outline.x1) < 100 || (geo.outline.y2 - geo.outline.y1) < 100) {
    add('D005', `board outline is degenerate (${geo.outline.x2 - geo.outline.x1}×${geo.outline.y2 - geo.outline.y1} mil)`);
  }
  const board = geo.outline || G.rect(0, 0, 4000, 3000);

  // D002 — honor both the fabrication floor and the net-specific floor.
  for (const t of geo.tracks) {
    const floor = Math.max(rules.minTrack, netWidths[t.net] || 0);
    if ((t.width || 10) < floor) {
      add('D002', `track on net "${t.net}" is ${t.width} mil wide (min ${floor === rules.minTrack ? rules.minTrack : netWidths[t.net]})`, {
        net: t.net,
        fix: `increase the explicit width in pcb.tracks and re-run the build`
      });
    }
  }

  // D001 — copper spacing. Copper on DIFFERENT layers never conflicts, except
  // through-hole pads (MULTI, layer 12) which exist on every layer.
  const copper = [];
  for (const t of geo.tracks) copper.push({ net: t.net, rect: segRect(t), kind: 'track', layer: t.layer, track: t });
  for (const p of geo.pads) {
    copper.push({ net: p.net, rect: padRect(p), kind: 'pad', ref: p.ref, num: p.num, layer: p.layer });
  }
  for (const v of geo.vias) copper.push({ net: v.net, kind: 'via', layer: 12, via: v,
    rect: G.rect(v.x - v.width / 2, v.y - v.width / 2, v.x + v.width / 2, v.y + v.width / 2) });
  const pointToBox = (p, box) => rectGap(G.rect(p.x, p.y, p.x, p.y), box);
  const lineGap = (a, b) => G.segsIntersect(a, b, true) ? 0 : Math.min(
    G.pointSegDist({ x: a.x1, y: a.y1 }, b), G.pointSegDist({ x: a.x2, y: a.y2 }, b),
    G.pointSegDist({ x: b.x1, y: b.y1 }, a), G.pointSegDist({ x: b.x2, y: b.y2 }, a));
  const trackGap = (track, other) => {
    if (other.track) return lineGap(track, other.track) - (track.width + other.track.width) / 2;
    if (other.via) return G.pointSegDist(other.via, track) - (track.width + other.via.width) / 2;
    const { x1, y1, x2, y2 } = other.rect;
    if (G.segIntersectsRect(track, other.rect)) return -track.width / 2;
    const corners = [{ x: x1, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y1 }, { x: x2, y: y2 }];
    return Math.min(pointToBox({ x: track.x1, y: track.y1 }, other.rect),
      pointToBox({ x: track.x2, y: track.y2 }, other.rect), ...corners.map((p) => G.pointSegDist(p, track))) - track.width / 2;
  };
  const onSameLayer = (a, b) => a.layer === b.layer || a.layer === 12 || b.layer === 12;
  for (let i = 0; i < copper.length; i += 1) {
    for (let j = i + 1; j < copper.length; j += 1) {
      const a = copper[i]; const b = copper[j];
      if ((!a.net && !b.net) || (a.net && a.net === b.net)) continue;
      if (!onSameLayer(a, b)) continue;
      if (a.kind === 'pad' && b.kind === 'pad' && a.ref && a.ref === b.ref) {
        // The land pattern's INTERNAL spacing is the footprint's business, but
        // two pads of one footprint OVERLAPPING on different nets is a short —
        // inline `{auto:...}` / hand-written footprints made that reachable.
        if (a.net && b.net && a.net !== b.net && G.rectsOverlap(a.rect, b.rect)) {
          add('D001', `pads ${a.ref}.${a.num} (${a.net}) and ${a.ref}.${b.num} (${b.net}) overlap — the land pattern shorts the two nets`, {
            a: a.net, b: b.net, at: [Math.round((a.rect.x1 + a.rect.x2) / 2), Math.round((a.rect.y1 + a.rect.y2) / 2)],
            fix: `fix the land pattern of ${a.ref} in parts[].footprint — its own pads must not touch across nets`
          });
        }
        continue;
      }
      if (rectGap(a.rect, b.rect) >= rules.clearance - 0.001) continue;
      const gap = Math.max(0, a.track ? trackGap(a.track, b) : b.track ? trackGap(b.track, a)
        : a.via && b.via ? Math.hypot(a.via.x - b.via.x, a.via.y - b.via.y) - (a.via.width + b.via.width) / 2
        : a.via ? pointToBox(a.via, b.rect) - a.via.width / 2
        : b.via ? pointToBox(b.via, a.rect) - b.via.width / 2 : rectGap(a.rect, b.rect));
      if (gap < rules.clearance - 0.001) {
        const la = a.kind === 'pad' ? `pad ${a.ref}.${a.num}` : a.kind;
        const lb = b.kind === 'pad' ? `pad ${b.ref}.${b.num}` : b.kind;
        const mid = { x: (a.rect.x1 + a.rect.x2) / 2, y: (a.rect.y1 + a.rect.y2) / 2 };
        add('D001', `${la} (${a.net}) is ${gap.toFixed(1)} mil from ${lb} (${b.net}) at [${mid.x.toFixed(0)},${mid.y.toFixed(0)}] — min ${rules.clearance}`, {
          a: a.net, b: b.net, at: [Math.round(mid.x), Math.round(mid.y)],
          fix: `space is tight: move the parts with pcb.place, reroute the segment in pcb.tracks, enlarge board.width/height in design.json, or lower pcb.rules.clearance for fine-pitch parts`
        });
      }
    }
  }

  // D003 — board edge clearance, measured against the real OUTLINE POLYGON
  // when the path is a readable polygon (L-shaped boards and cutouts made the
  // bbox judgement wrong near the notch). Copper crossing the outline is
  // reported as outside, copper inside is measured to the nearest edge.
  const outlineEdges = [];
  if (geo.outlinePts && geo.outlinePts.length >= 3) {
    for (let i = 0; i < geo.outlinePts.length; i += 1) {
      const a = geo.outlinePts[i]; const b = geo.outlinePts[(i + 1) % geo.outlinePts.length];
      outlineEdges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  for (const c of copper) {
    let gap;
    let outside = false;
    if (outlineEdges.length) {
      outside = rectCorners(c.rect).some((p) => !pointInPoly(p, geo.outlinePts));
      gap = outside ? 0 : Math.min(...outlineEdges.map((e) => segRectDist(e, c.rect)));
    } else {
      gap = rectEdgeGap(c.rect, board);
    }
    if (outside || gap < rules.edge - 0.001) {
      add('D003', outside
        ? `${c.kind}${c.ref ? ` ${c.ref}.${c.num}` : ''} crosses the board outline`
        : `${c.kind}${c.ref ? ` ${c.ref}.${c.num}` : ''} is ${gap.toFixed(1)} mil from the board edge — min ${rules.edge}`, {
        net: c.net, at: [Math.round((c.rect.x1 + c.rect.x2) / 2), Math.round((c.rect.y1 + c.rect.y2) / 2)],
        fix: `move that copper in pcb.tracks / pcb.place, or enlarge board.width/height in design.json, then rebuild`
      });
    }
  }

  // D013 — footprint body extents overlapping. Copper spacing cannot catch
  // two bodies stacked on each other (pads far apart, bodies colliding) —
  // the first thing a layout review checks. AABB of the rotated PART BBOX.
  const fps = geo.footprints.slice().sort((a, b) => a.ref.localeCompare(b.ref));
  for (let i = 0; i < fps.length; i += 1) {
    for (let j = i + 1; j < fps.length; j += 1) {
      if (fps[i].ref === fps[j].ref) continue;
      if (!G.rectsOverlap(fps[i].rect, fps[j].rect)) continue;
      add('D013', `footprints ${fps[i].ref} and ${fps[j].ref} overlap`, {
        refs: [fps[i].ref, fps[j].ref],
        at: [Math.round((Math.max(fps[i].rect.x1, fps[j].rect.x1) + Math.min(fps[i].rect.x2, fps[j].rect.x2)) / 2),
          Math.round((Math.max(fps[i].rect.y1, fps[j].rect.y1) + Math.min(fps[i].rect.y2, fps[j].rect.y2)) / 2)],
        fix: `move one of them in pcb.place — parts[].footprint outlines must not intersect`
      });
    }
  }

  // D014 — footprint body outside the board outline (a connector hanging off
  // the board edge passed every copper rule until now). Judged against the
  // real outline polygon when readable.
  if (geo.outlinePts && geo.outlinePts.length >= 3) {
    for (const fp of fps) {
      if (rectCorners(fp.rect).every((p) => pointInPoly(p, geo.outlinePts))) continue;
      add('D014', `footprint ${fp.ref} extends past the board outline`, {
        ref: fp.ref, at: [Math.round((fp.rect.x1 + fp.rect.x2) / 2), Math.round((fp.rect.y1 + fp.rect.y2) / 2)],
        fix: `move ${fp.ref} inside board.width/height with pcb.place, or enlarge the board in design.json`
      });
    }
  }

  // D004 — net connectivity through copper. A pour counts as a connection
  // ONLY where its geometry actually covers same-net pads on a compatible
  // layer: a border-only POUR, a bottom-layer plane over top-side pads, or a
  // region that never overlaps the pads used to silence D004 entirely.
  const NC_RE = /^(NC|DNC\d*|N\/C)$/i;
  const pourCovered = new Map();   // net -> Set("ref|num") pads inside a pour
  for (const rg of geo.regions) {
    for (const p of geo.pads) {
      if (!p.net || p.net !== rg.net) continue;
      if (!(p.layer === rg.layer || p.layer === 12 || rg.layer === 12)) continue;
      if (!pointInPoly({ x: p.x, y: p.y }, rg.pts)) continue;
      if (!pourCovered.has(p.net)) pourCovered.set(p.net, new Set());
      pourCovered.get(p.net).add(`${p.ref}|${p.num}`);
    }
  }
  if (!placedOnly) {
    const byNet = new Map();
    const group = (net) => {
      if (!byNet.has(net)) byNet.set(net, { pads: [], tracks: [], vias: [] });
      return byNet.get(net);
    };
    for (const kind of ['pads', 'tracks', 'vias']) {
      for (const item of geo[kind]) if (item.net && !NC_RE.test(item.net)) group(item.net)[kind].push(item);
    }
    for (const [net, { pads, tracks, vias }] of byNet) {
      if (pads.length < 2) continue;
      const items = [...pads, ...tracks, ...vias];
      const parent = items.map((_, i) => i);
      const find = (i) => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
      };
      // covered pads hang on the same plane: pre-union them before the
      // track/pad pairing, then the normal grouping proves the REST
      const covered = pourCovered.get(net);
      if (covered) {
        let first = -1;
        for (let i = 0; i < pads.length; i += 1) {
          if (!covered.has(`${pads[i].ref}|${pads[i].num}`)) continue;
          if (first < 0) first = i;
          else parent[find(i)] = find(first);
        }
      }
      const layerOk = (a, b) => a === b || a === 12 || b === 12;
      const ends = (t) => [{ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 }];
      const isTrack = (item) => item.x1 !== undefined;
      const isPad = (item) => item.ref !== undefined;
      function connected(a, b) {
        if (!layerOk(a.layer || 12, b.layer || 12)) return false;
        if (isTrack(a) && isTrack(b)) return G.segsIntersect(a, b, true);
        if (isTrack(a) || isTrack(b)) {
          const t = isTrack(a) ? a : b;
          const p = t === a ? b : a;
          if (isPad(p)) return ends(t).some((pt) => G.rectContains(padRect(p), pt));
          return G.pointSegDist(p, t) < 0.001;
        }
        if (isPad(a) && isPad(b)) return false;
        if (isPad(a) || isPad(b)) return isPad(a) ? G.rectContains(padRect(a), b) : G.rectContains(padRect(b), a);
        return Math.hypot(a.x - b.x, a.y - b.y) < 0.001;
      }
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) if (connected(items[i], items[j])) parent[find(i)] = find(j);
      }
      const padGroups = new Set(pads.map((_, i) => find(i)));
      if (padGroups.size > 1) add('D004', `net "${net}" is not fully routed (${pads.length} pads in ${padGroups.size} disconnected groups)`, {
        net, pads: pads.length,
        fix: 'connect the isolated pad groups with explicit pcb.tracks and use pcb.vias where the layer changes'
      });
    }
  }

  // D006 — ground pour. Only judged on boards that HAVE copper (imported or
  // client-saved); a placed-only board from this skill never promises a plane.
  // A board without the plane net at all (no GND pads) is not asked for one.
  const hasPlaneNet = geo.pads.some((p) => p.net === pourNet);
  if (geo.pours.length && hasPlaneNet && !geo.pours.some((p) => p.net === pourNet)) {
    add('D006', `a pour exists but none on net "${pourNet}"`, {
      fix: `the board has pours but none on "${pourNet}" — fix the pour's net in the client, or judge with --pour-net <net>`
    });
  } else if (!placedOnly && !geo.pours.length && hasPlaneNet) {
    add('D006', 'no copper pour on the board (expected a ground plane)', {
      fix: `add the ground pour in the EasyEDA client (this skill never pours); or record why a plane is not required`
    });
  }

  // D007 — pads without a net
  const orphan = geo.pads.filter((p) => !p.net && !(opts?.noConnect?.has(`${p.ref}.${p.num}`)));
  if (orphan.length) {
    add('D007', `${orphan.length} pad(s) have no net: ${orphan.slice(0, 6).map((p) => `${p.ref}.${p.num}`).join(' ')}`, {
      fix: `re-run build.js --force — PCB pad nets come from parts[].pins; a pad with no net means its pin mapping lost an entry`
    });
  }

  // D008 — via geometry
  for (const v of geo.vias) {
    if (v.width < rules.viaMin || v.width > rules.viaMax || v.hole >= v.width) {
      add('D008', `via at ${v.x},${v.y} has size ${v.width}/drill ${v.hole}`, {
        fix: `set pcb.vias[].diameter/drill inside ${rules.viaMin}–${rules.viaMax} with drill < diameter`
      });
    }
  }

  // D009 — minimum drill (DFM). 0.3 mm ≈ 12 mil is the basic-process floor
  // for plated holes; smaller drills need a special fab capability.
  for (const v of geo.vias) {
    if (v.hole < rules.minDrill - 0.001) {
      add('D009', `via at ${v.x},${v.y} on net "${v.net}" has a ${v.hole} mil drill (min ${rules.minDrill})`, {
        net: v.net,
        fix: `raise pcb.vias[].drill to ${rules.minDrill} mil (0.3 mm) or more and re-run build.js --force`
      });
    }
  }
  for (const p of geo.pads) {
    if (p.hole && p.hole < rules.minDrill - 0.001) {
      add('D009', `pad ${p.ref}.${p.num} is drilled ${p.hole} mil (min ${rules.minDrill})`, {
        net: p.net, ref: p.ref,
        fix: `swap in a footprint whose through-hole pads drill ${rules.minDrill} mil (0.3 mm) or more — sub-12 mil drills are a paid upgrade at most fabs`
      });
    }
  }

  // D010 — minimum annular ring (DFM). ring = (outer − drill) / 2; a ring that
  // is too thin lets the drill break out of the copper pad during plating.
  for (const v of geo.vias) {
    const ring = (v.width - v.hole) / 2;
    if (ring < rules.minRing - 0.001) {
      add('D010', `via at ${v.x},${v.y} has a ${ring.toFixed(1)} mil annular ring (outer ${v.width}, drill ${v.hole}) — min ${rules.minRing}`, {
        net: v.net,
        fix: `enlarge the via diameter (or shrink its drill) so (diameter − drill)/2 reaches ${rules.minRing} mil, then re-run build.js --force`
      });
    }
  }
  for (const p of geo.pads) {
    if (!p.hole) continue;
    const ring = (Math.min(p.w, p.h) - p.hole) / 2;
    if (ring < rules.minRing - 0.001) {
      add('D010', `pad ${p.ref}.${p.num} has a ${ring.toFixed(1)} mil annular ring (copper ${Math.min(p.w, p.h)}, drill ${p.hole}) — min ${rules.minRing}`, {
        net: p.net, ref: p.ref,
        fix: `grow the pad in the footprint (generate-footprint.js pads num:x:y:w:h[:drill]) so the ring reaches ${rules.minRing} mil`
      });
    }
  }

  // D011 — silkscreen onto copper pads (DFM). Silk on a pad site prints over
  // solderable metal and bakes into the joint; keep text in the silk-safe gap.
  // Layer 3 (top silk) can only hit top/multi pads, layer 4 only bottom/multi.
  const silkToPad = { 3: [1, 12], 4: [2, 12] };
  for (const s of geo.strings) {
    const padLayers = silkToPad[s.layer];
    if (!padLayers) continue;
    const sr = stringRect(s);
    if (!sr) continue;
    const hit = geo.pads.find((p) => padLayers.indexOf(p.layer) >= 0 && G.rectsOverlap(sr, padRect(p)));
    if (hit) {
      const label = s.text.length > 20 ? `${s.text.slice(0, 20)}…` : s.text;
      add('D011', `silkscreen "${label}" at ${s.x},${s.y} (${s.layer === 3 ? 'top' : 'bottom'} silk) overlaps pad ${hit.ref}.${hit.num}`, {
        net: hit.net, ref: hit.ref,
        fix: `move the text (add-pcb-text.js --x/--y) into the silk-safe gap between pads — silk must not print on exposed copper`
      });
    }
  }

  // D012 — acute-angle track bends (DFM). Only same-net, same-copper-layer
  // segments that SHARE an endpoint count; a sharp bend leaves a wedge of thin
  // insulation and traps etchant. A 0° join is copper folded back on itself
  // (the router emits these next to pads) — that is an overlap, not a wedge,
  // so joins under 1° are left to the spacing rules.
  const joints = new Map();
  geo.tracks.forEach((t, ti) => {
    if (!t.net) return;
    if (t.layer !== 1 && t.layer !== 2 && !(t.layer >= 15 && t.layer <= 44)) return;
    const ends = [
      { vx: t.x2 - t.x1, vy: t.y2 - t.y1, x: t.x1, y: t.y1 },
      { vx: t.x1 - t.x2, vy: t.y1 - t.y2, x: t.x2, y: t.y2 }
    ];
    for (const e of ends) {
      const k = `${t.net}|${t.layer}|${G.round(e.x)},${G.round(e.y)}`;
      if (!joints.has(k)) joints.set(k, []);
      joints.get(k).push(Object.assign({ ti }, e));
    }
  });
  const seenPairs = new Set();
  for (const [k, arms] of joints) {
    if (arms.length < 2) continue;
    const [net, layer] = k.split('|');
    for (let i = 0; i < arms.length; i += 1) {
      for (let j = i + 1; j < arms.length; j += 1) {
        if (arms[i].ti === arms[j].ti) continue;
        const pk = arms[i].ti < arms[j].ti ? `${arms[i].ti}:${arms[j].ti}` : `${arms[j].ti}:${arms[i].ti}`;
        if (seenPairs.has(pk)) continue;
        const ang = jointAngle(arms[i], arms[j]);
        if (ang === null || ang < 1 || ang >= rules.minAngle - 0.001) continue;
        seenPairs.add(pk);
        add('D012', `net "${net}" bends ${ang.toFixed(0)}° at ${arms[i].x},${arms[i].y} on layer ${layer} — min ${rules.minAngle}°`, {
          net,
          fix: `reroute that corner as a 45° chamfer or an arc (two segments meeting at ≥ ${rules.minAngle}°) — giving the run more room with pcb.place and re-running build.js --force usually clears it`
        });
      }
    }
  }

  const score = Math.max(0, 100 - findings.reduce((n, f) => n + RULES[f.code].weight, 0));
  return {
    mode: placedOnly ? 'placed-only' : 'routed',
    skipped: placedOnly ? ['D004', 'D006'] : [],
    findings,
    errors: findings.filter((f) => f.level === 'error').length,
    warnings: findings.filter((f) => f.level === 'warn').length,
    score,
    counts: {
      pads: geo.pads.length,
      tracks: geo.tracks.length,
      vias: geo.vias.length,
      pours: geo.pours.length
    }
  };
}

module.exports = { RULES, DEFAULTS, runDrc, pcbGeometry, docSplit, stringRect };
void fs;
