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
 *   D001 copper-to-copper spacing below clearance (different nets)
 *   D002 track width below the minimum
 *   D003 copper too close to the board edge
 *   D004 net with 2+ pads is not fully connected by copper
 *   D005 board outline missing / degenerate
 *   D006 no copper pour on a ground net (warning)
 *   D007 pad with no net (warning)
 *   D008 via drill/size out of range
 *   D009 drill below the manufacturing minimum (DFM)
 *   D010 annular ring below the minimum (DFM, warning)
 *   D011 silkscreen text overlapping a copper pad (DFM, warning)
 *   D012 same-net track segments meeting at an acute angle (DFM, warning)
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
  D012: { level: 'warn', weight: 2, text: 'track bends at an acute angle' }
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
  for (const r of recs) {
    if (r.type !== 'COMPONENT') continue;
    const b = r.body || {};
    const ref = refByComp.get(r.id) || r.id;
    const fpAttr = recs.find((a) => a.type === 'ATTR' && a.body && a.body.key === 'Footprint' && a.body.parentId === r.id);
    const fpDoc = fpAttr ? fpDocs.get(fpAttr.body.value) : null;
    if (!fpDoc) continue;
    for (const pr of fpDoc.records) {
      if (pr.type !== 'PAD') continue;
      const pb = pr.body;
      const d = pb.defaultPad || {};
      const off = G.rotate(pb.centerX, pb.centerY, b.angle || 0);
      const net = netByPad.get(`${r.id}|${pb.num}|${pr.id}`) || netByPad.get(`${r.id}|${pb.num}|${pb.elemId}`) || '';
      pads.push({
        ref,
        num: String(pb.num),
        net,
        x: G.round(b.x + off.x),
        y: G.round(b.y + off.y),
        w: d.width || 20,
        h: d.height || 20,
        hole: typeof pb.hole === 'number' && pb.hole > 0 ? pb.hole : null,
        layer: pb.layerId || 1
      });
    }
  }

  const tracks = [];
  const vias = [];
  const pours = [];
  const strings = [];
  let outline = null;
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
      const pts = P.pathToPoints(r.body.path);
      const bb = G.bboxOfPoints(pts);
      if (bb) outline = bb;
    }
  }
  return { pads, tracks, vias, pours, strings, outline };
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

  // D002 — track width. A net with a declared width satisfies its own contract
  // at that width, so the floor is the narrower of the two.
  for (const t of geo.tracks) {
    const floor = Math.min(rules.minTrack, netWidths[t.net] || Infinity);
    if ((t.width || 10) < floor) {
      add('D002', `track on net "${t.net}" is ${t.width} mil wide (min ${floor === rules.minTrack ? rules.minTrack : netWidths[t.net]})`, {
        net: t.net,
        fix: `raise pcb.rules.trackWidth (or the net's width in "nets") and re-run build.js --force`
      });
    }
  }

  // D001 — copper spacing. Copper on DIFFERENT layers never conflicts, except
  // through-hole pads (MULTI, layer 12) which exist on every layer.
  const copper = [];
  for (const t of geo.tracks) copper.push({ net: t.net, rect: segRect(t), kind: 'track', layer: t.layer });
  for (const p of geo.pads) {
    copper.push({ net: p.net, rect: padRect(p), kind: 'pad', ref: p.ref, num: p.num, layer: p.layer });
  }
  const onSameLayer = (a, b) => a.layer === b.layer || a.layer === 12 || b.layer === 12;
  for (let i = 0; i < copper.length; i += 1) {
    for (let j = i + 1; j < copper.length; j += 1) {
      const a = copper[i]; const b = copper[j];
      if (!a.net || !b.net || a.net === b.net) continue;
      if (!onSameLayer(a, b)) continue;
      // pads of the SAME footprint are the package's own business — their
      // spacing comes from the datasheet land pattern, not a routing rule
      if (a.kind === 'pad' && b.kind === 'pad' && a.ref && a.ref === b.ref) continue;
      const gap = rectGap(a.rect, b.rect);
      if (gap < rules.clearance - 0.001) {
        const la = a.kind === 'pad' ? `pad ${a.ref}.${a.num}` : 'track';
        const lb = b.kind === 'pad' ? `pad ${b.ref}.${b.num}` : 'track';
        add('D001', `${la} (${a.net}) is ${gap.toFixed(1)} mil from ${lb} (${b.net}) — min ${rules.clearance}`, {
          a: a.net, b: b.net,
          fix: a.kind === 'pad' && b.kind === 'pad' && a.ref === b.ref
            ? `fix the land pattern of ${a.ref} in parts[].footprint — its own pads must clear each other`
            : `space is tight: enlarge the board, move the parts with pcb.place, or lower pcb.rules.clearance for fine-pitch parts`
        });
      }
    }
  }

  // D003 — board edge clearance
  for (const c of copper) {
    const gap = rectEdgeGap(c.rect, board);
    if (gap < rules.edge - 0.001) {
      add('D003', `${c.kind}${c.ref ? ` ${c.ref}.${c.num}` : ''} is ${gap.toFixed(1)} mil from the board edge — min ${rules.edge}`, {
        net: c.net,
        fix: `grow board.width/height or raise pcb.rules.edgeClearance, then re-run build.js --force`
      });
    }
  }

  // D004 — net connectivity through copper
  const uf = new Map();
  const find = (k) => {
    if (!uf.has(k)) uf.set(k, k);
    let r = k;
    while (uf.get(r) !== r) r = uf.get(r);
    return r;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) uf.set(ra, rb); };
  const keyPoint = (x, y) => `${Math.round(x)},${Math.round(y)}`;
  for (const t of geo.tracks) {
    union(keyPoint(t.x1, t.y1), keyPoint(t.x2, t.y2));
    if (t.net) union(keyPoint(t.x1, t.y1), `net:${t.net}`);
  }
  for (const v of geo.vias) {
    union(keyPoint(v.x, v.y), `net:${v.net}`);
  }
  const byNet = new Map();
  for (const p of geo.pads) {
    if (!p.net) continue;
    byNet.set(p.net, (byNet.get(p.net) || 0) + 1);
    // a pad joins its net when a copper endpoint or via sits on it
    const onPad = [
      ...geo.tracks.filter((t) => t.net === p.net
        && (G.rectContains(padRect(p), { x: t.x1, y: t.y1 }) || G.rectContains(padRect(p), { x: t.x2, y: t.y2 }))),
      ...geo.vias.filter((v) => v.net === p.net && G.rectContains(padRect(p), { x: v.x, y: v.y }))
    ];
    if (onPad.length) union(keyPoint(p.x, p.y), `net:${p.net}`);
  }
  const pouredNets = new Set(geo.pours.map((p) => p.net).filter(Boolean));
  // D004 judges routing that was promised. A placement-only board promised
  // none — flagging every signal net would punish the deliverable for
  // following the strategy.
  if (!placedOnly) for (const [net, count] of byNet) {
    if (count < 2) continue;
    // a poured net is connected by the plane, not by tracks
    if (pouredNets.has(net)) continue;
    const pads = geo.pads.filter((p) => p.net === net);
    const attached = pads.filter((p) => geo.tracks.some((t) => t.net === net
      && (G.rectContains(padRect(p), { x: t.x1, y: t.y1 }) || G.rectContains(padRect(p), { x: t.x2, y: t.y2 })))
      || geo.vias.some((v) => v.net === net && G.rectContains(padRect(p), { x: v.x, y: v.y })));
    if (attached.length < count) {
      add('D004', `net "${net}" is not fully routed (${attached.length}/${count} pads have copper)`, {
        net,
        fix: `the router could not reach every pad: enlarge the board, pin the parts apart with pcb.place, or lower pcb.rules.clearance/trackWidth for fine-pitch parts`
      });
    }
  }

  // D006 — ground pour. Expected on a routed board; on a placement-only board
  // only checked when copper already exists (a stray pour on the wrong net is
  // still a defect the deliverable should report).
  if (geo.pours.length && !geo.pours.some((p) => p.net === pourNet)) {
    add('D006', `a pour exists but none on net "${pourNet}"`, {
      fix: `set pcb.pour.net to "${pourNet}" (or pass --pour-net) and re-run build.js --force`
    });
  } else if (!placedOnly && !geo.pours.length) {
    add('D006', 'no copper pour on the board (expected a ground plane)', {
      fix: `enable the pour: build with --pour, or set the design's pcb.pour and re-run build.js --force`
    });
  }

  // D007 — pads without a net
  const orphan = geo.pads.filter((p) => !p.net);
  if (orphan.length) {
    add('D007', `${orphan.length} pad(s) have no net: ${orphan.slice(0, 6).map((p) => `${p.ref}.${p.num}`).join(' ')}`, {
      fix: `re-run build.js --force — PCB pad nets come from parts[].pins; a pad with no net means its pin mapping lost an entry`
    });
  }

  // D008 — via geometry
  for (const v of geo.vias) {
    if (v.width < rules.viaMin || v.width > rules.viaMax || v.hole >= v.width) {
      add('D008', `via at ${v.x},${v.y} has size ${v.width}/drill ${v.hole}`, {
        fix: `set pcb.rules.viaDiameter/viaDrill inside ${rules.viaMin}–${rules.viaMax} with drill < diameter`
      });
    }
  }

  // D009 — minimum drill (DFM). 0.3 mm ≈ 12 mil is the basic-process floor
  // for plated holes; smaller drills need a special fab capability.
  for (const v of geo.vias) {
    if (v.hole < rules.minDrill - 0.001) {
      add('D009', `via at ${v.x},${v.y} on net "${v.net}" has a ${v.hole} mil drill (min ${rules.minDrill})`, {
        net: v.net,
        fix: `raise pcb.rules.viaDrill to ${rules.minDrill} mil (0.3 mm) or more and re-run build.js --force`
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
        fix: `enlarge pcb.rules.viaDiameter (or shrink viaDrill) so (diameter − drill)/2 reaches ${rules.minRing} mil, then re-run build.js --force`
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
    if (t.layer !== 1 && t.layer !== 2) return; // copper layers only
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
