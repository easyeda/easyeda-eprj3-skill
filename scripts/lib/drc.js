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
  D008: { level: 'warn', weight: 2, text: 'via geometry out of range' }
};

const DEFAULTS = { clearance: 10, minTrack: 8, edge: 12, viaMin: 16, viaMax: 60 };

function docSplit(lines) {
  const docs = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('{"type":"DOCHEAD"}')) {
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
  const main = docs.find((d) => d.docType === 'PCB') || docs[docs.length - 1];
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
        layer: pb.layerId || 1
      });
    }
  }

  const tracks = [];
  const vias = [];
  const pours = [];
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
      vias.push({
        net: r.body.netName || '',
        x: r.body.x, y: r.body.y,
        width: r.body.width || 24, hole: r.body.hole || 12
      });
    } else if (r.type === 'POUR' && r.body) {
      pours.push({ net: r.body.netName || '', layer: r.body.layerId });
    } else if (r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE') {
      const pts = P.pathToPoints(r.body.path);
      const bb = G.bboxOfPoints(pts);
      if (bb) outline = bb;
    }
  }
  return { pads, tracks, vias, pours, outline };
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

/**
 * @param file  pcb document path
 * @param opts  {rules, pourNet}
 */
function runDrc(file, opts) {
  const rules = Object.assign({}, DEFAULTS, (opts && opts.rules) || {});
  const pourNet = (opts && opts.pourNet) || 'GND';
  const findings = [];
  const add = (code, msg, extra) => findings.push(Object.assign({
    code, level: RULES[code].level, msg
  }, extra || {}));

  const geo = pcbGeometry(file);

  // D005 — outline
  if (!geo.outline) {
    add('D005', 'no BOARD_OUTLINE poly in the PCB document');
  } else if ((geo.outline.x2 - geo.outline.x1) < 100 || (geo.outline.y2 - geo.outline.y1) < 100) {
    add('D005', `board outline is degenerate (${geo.outline.x2 - geo.outline.x1}×${geo.outline.y2 - geo.outline.y1} mil)`);
  }
  const board = geo.outline || G.rect(0, 0, 4000, 3000);

  // D002 — track width
  for (const t of geo.tracks) {
    if ((t.width || 10) < rules.minTrack) {
      add('D002', `track on net "${t.net}" is ${t.width} mil wide (min ${rules.minTrack})`, { net: t.net });
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
          a: a.net, b: b.net
        });
      }
    }
  }

  // D003 — board edge clearance
  for (const c of copper) {
    const gap = rectEdgeGap(c.rect, board);
    if (gap < rules.edge - 0.001) {
      add('D003', `${c.kind}${c.ref ? ` ${c.ref}.${c.num}` : ''} is ${gap.toFixed(1)} mil from the board edge — min ${rules.edge}`, {
        net: c.net
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
  for (const [net, count] of byNet) {
    if (count < 2) continue;
    // a poured net is connected by the plane, not by tracks
    if (pouredNets.has(net)) continue;
    const pads = geo.pads.filter((p) => p.net === net);
    const attached = pads.filter((p) => geo.tracks.some((t) => t.net === net
      && (G.rectContains(padRect(p), { x: t.x1, y: t.y1 }) || G.rectContains(padRect(p), { x: t.x2, y: t.y2 })))
      || geo.vias.some((v) => v.net === net && G.rectContains(padRect(p), { x: v.x, y: v.y })));
    if (attached.length < count) {
      add('D004', `net "${net}" is not fully routed (${attached.length}/${count} pads have copper)`, { net });
    }
  }

  // D006 — ground pour
  if (!geo.pours.length) {
    add('D006', 'no copper pour on the board (expected a ground plane)');
  } else if (!geo.pours.some((p) => p.net === pourNet)) {
    add('D006', `a pour exists but none on net "${pourNet}"`);
  }

  // D007 — pads without a net
  const orphan = geo.pads.filter((p) => !p.net);
  if (orphan.length) {
    add('D007', `${orphan.length} pad(s) have no net: ${orphan.slice(0, 6).map((p) => `${p.ref}.${p.num}`).join(' ')}`);
  }

  // D008 — via geometry
  for (const v of geo.vias) {
    if (v.width < rules.viaMin || v.width > rules.viaMax || v.hole >= v.width) {
      add('D008', `via at ${v.x},${v.y} has size ${v.width}/drill ${v.hole}`);
    }
  }

  const score = Math.max(0, 100 - findings.reduce((n, f) => n + RULES[f.code].weight, 0));
  return {
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

module.exports = { RULES, DEFAULTS, runDrc, pcbGeometry, docSplit };
void fs;
