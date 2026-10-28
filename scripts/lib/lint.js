'use strict';
/**
 * lint.js — geometric / readability review of a schematic sheet.
 *
 * validate.js answers "is this well formed", erc.js answers "is this
 * electrically right". This answers the question a human reviewer asks next:
 * "can I read it?" Overlapping symbols, wires cutting through bodies, parts
 * outside their block frame, off-grid coordinates, text on top of a part.
 *
 * Every finding is mechanical, so the same check runs in CI, in build and in
 * the eval harness — and a score makes progress measurable.
 *
 * Codes: L001-L009 as listed in RULES below.
 */

const fs = require('fs');
const path = require('path');
const E = require('./eprj3');
const G = require('./geom');
const P = require('./parts');
const N = require('./netlist');
const { partExtent } = require('./design');

const RULES = {
  L001: { level: 'error', weight: 10, text: 'symbols overlap' },
  L002: { level: 'error', weight: 6, text: 'part outside every block frame' },
  L003: { level: 'error', weight: 6, text: 'non-orthogonal wire' },
  L004: { level: 'error', weight: 10, text: 'wire crosses a symbol body' },
  L005: { level: 'warn', weight: 3, text: 'block frames overlap' },
  L006: { level: 'warn', weight: 3, text: 'text sits on top of a part' },
  L007: { level: 'warn', weight: 3, text: 'part outside the drawing frame' },
  L008: { level: 'warn', weight: 1, text: 'coordinate off the 10 mil grid' },
  L009: { level: 'warn', weight: 2, text: 'net label sits on a part' },
  L010: { level: 'warn', weight: 2, text: 'wire endpoint dangles (touches nothing)' }
};

// A4 drawing frame extent in mil (the A4 frame symbol's own coordinate space).
const FRAME = { x1: 0, y1: -8250, x2: 11700, y2: 0 };
const GRID = 10;

function isBlockRect(rect) {
  return (rect.x2 - rect.x1) > 80 && (rect.y2 - rect.y1) > 80;
}

function collectSheet(file) {
  const { docs, main } = N.readSheet(file);
  const symbolByUuid = new Map();
  for (const d of docs) {
    if (d.docType !== 'SYMBOL') continue;
    symbolByUuid.set(d.uuid, P.parseSymbolEntry({
      symbolDoc: d.records.map((r) => E.formatRecord(r.head, r.body))
    }));
  }
  const parts = [];
  const rects = [];
  const texts = [];
  const labels = [];
  const segs = [];
  const wireIds = new Set(main.records.filter((r) => r.type === 'WIRE').map((r) => r.id));
  const compIds = new Set(main.records.filter((r) => r.type === 'COMPONENT').map((r) => r.id));
  const attrs = main.records.filter((r) => r.type === 'ATTR' && r.body);

  for (const r of main.records) {
    if (r.type === 'COMPONENT') {
      const b = r.body || {};
      const mine = attrs.filter((a) => a.body.parentId === r.id);
      const des = mine.find((a) => a.body.key === 'Designator');
      const symAttr = mine.find((a) => a.body.key === 'Symbol');
      const sym = symAttr ? symbolByUuid.get(symAttr.body.value) : null;
      const ref = (des && des.body.value) || '?';
      const extent = sym ? partExtent(sym, b.x, b.y, b.rotation || 0) : null;
      parts.push({ ref, x: b.x, y: b.y, rotation: b.rotation || 0, sym, extent });
    } else if (r.type === 'RECT') {
      const b = r.body;
      rects.push({ rect: G.rect(b.dotX1, b.dotY1, b.dotX2, b.dotY2) });
    } else if (r.type === 'TEXT') {
      texts.push({ x: r.body.x, y: r.body.y, value: r.body.value, size: r.body.fontSize || 10 });
    } else if (r.type === 'LINE' && r.body && wireIds.has(r.body.lineGroup)) {
      segs.push({ x1: r.body.startX, y1: r.body.startY, x2: r.body.endX, y2: r.body.endY, wire: r.body.lineGroup });
    }
  }
  // NET labels live on the WIRE's ATTR, positioned at the wire midpoint.
  for (const a of attrs) {
    if (a.body.key !== 'NET' || !wireIds.has(a.body.parentId)) continue;
    if (typeof a.body.x !== 'number' || typeof a.body.y !== 'number') continue;
    labels.push({ x: a.body.x, y: a.body.y, net: a.body.value });
  }
  void compIds;
  const namedWires = new Set(attrs.filter((a) => a.body.key === 'NET').map((a) => a.body.parentId));
  return { parts, rects, texts, labels, segs, namedWires };
}

function lintSheet(file, sheetLabel) {
  const findings = [];
  const add = (code, msg, extra) => {
    const rule = RULES[code];
    findings.push(Object.assign({ code, level: rule.level, msg }, extra || {}));
  };
  const { parts, rects, texts, labels, segs, namedWires } = collectSheet(file);
  const real = parts.filter((p) => p.ref !== '?' && p.extent);
  const blocks = rects.filter((r) => isBlockRect(r.rect));

  // L001 — symbol overlap
  for (let i = 0; i < real.length; i += 1) {
    for (let j = i + 1; j < real.length; j += 1) {
      if (G.rectsOverlap(G.expand(real[i].extent, -6), G.expand(real[j].extent, -6))) {
        add('L001', `${real[i].ref} and ${real[j].ref} overlap`, { refs: [real[i].ref, real[j].ref] });
      }
    }
  }

  // L002 — part outside every block frame
  if (blocks.length) {
    for (const p of real) {
      const inside = blocks.some((b) => G.rectContainsRect(b.rect, p.extent));
      if (!inside) add('L002', `${p.ref} is not fully inside a block frame`, { ref: p.ref });
    }
  }

  // L005 — block frames overlapping each other
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      if (G.rectsOverlap(blocks[i].rect, blocks[j].rect)) {
        add('L005', `block frames overlap at ${JSON.stringify(blocks[i].rect)} / ${JSON.stringify(blocks[j].rect)}`);
      }
    }
  }

  // L003 / L004 / L010 — wires
  // The wire-crossing rule judges the SYMBOL BODY (PART BBOX), not the whole
  // part extent: since 1.16.0 wires attach at the pin hotspot, which lies
  // inside the extent by definition — testing the extent would flag every
  // legitimate stub.
  const bodyRectOf = (p) => {
    if (!p.sym || !p.sym.bbox) return p.extent;
    const b = p.sym.bbox;
    const corners = [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]]
      .map(([x, y]) => G.rotate(x, y, p.rotation))
      .map((r) => ({ x: p.x + r.x, y: p.y + r.y }));
    return G.bboxOfPoints(corners);
  };
  const endpoints = new Map();
  for (const s of segs) {
    if (!G.isOrthogonal(s)) {
      add('L003', `wire segment ${s.x1},${s.y1} → ${s.x2},${s.y2} is not orthogonal`);
    }
    for (const p of real) {
      // sample the middle of the segment: a route legitimately leaves its own
      // pin inside that symbol's extent, so the ends cannot be probed.
      const body = G.expand(bodyRectOf(p), -4);
      for (const t of [0.3, 0.5, 0.7]) {
        const pt = { x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t };
        if (G.rectContains(body, pt)) {
          add('L004', `a wire crosses ${p.ref}`, { ref: p.ref, seg: s });
          break;
        }
      }
    }
    for (const k of [`${G.round(s.x1)},${G.round(s.y1)}`, `${G.round(s.x2)},${G.round(s.y2)}`]) {
      endpoints.set(k, (endpoints.get(k) || 0) + 1);
    }
  }
  // a wire end is fine when another wire end or a pin lands on it
  const pinKeys = new Set();
  for (const p of parts) {
    // power flags / ports connect at their ORIGIN and carry no symbol pins
    if (p.ref === '?' || !p.sym) pinKeys.add(`${G.round(p.x)},${G.round(p.y)}`);
    if (!p.sym) continue;
    for (const pin of p.sym.pins) {
      const t = G.pinTip(pin, p.x, p.y, p.rotation);
      pinKeys.add(`${G.round(t.x)},${G.round(t.y)}`);
    }
  }
  // Labels are intentional wire terminations: a dangling end there is by design.
  for (const l of labels) pinKeys.add(`${G.round(l.x)},${G.round(l.y)}`);
  // A named wire ends are deliberate too (stub+label encoding, power drops).
  const exempt = new Set();
  for (const s of segs) {
    if (!namedWires.has(s.wire)) continue;
    exempt.add(`${G.round(s.x1)},${G.round(s.y1)}`);
    exempt.add(`${G.round(s.x2)},${G.round(s.y2)}`);
  }
  for (const [k, n] of endpoints) {
    if (n < 2 && !pinKeys.has(k) && !exempt.has(k)) {
      add('L010', `wire endpoint ${k} touches nothing`, { at: k });
    }
  }

  // L006 — text on top of a part
  for (const t of texts) {
    const hit = real.find((p) => G.rectContains(p.extent, { x: t.x, y: t.y }));
    if (hit) add('L006', `text "${t.value}" overlaps ${hit.ref}`, { ref: hit.ref });
  }

  // L009 — net label on top of a part
  for (const l of labels) {
    const hit = real.find((p) => G.rectContains(G.expand(p.extent, -10), { x: l.x, y: l.y }));
    if (hit) add('L009', `label "${l.net}" sits on ${hit.ref}`, { ref: hit.ref });
  }

  // L007 — outside the drawing frame
  for (const p of real) {
    if (!G.rectContainsRect(FRAME, p.extent)) {
      add('L007', `${p.ref} is outside the A4 drawing frame`, { ref: p.ref });
    }
  }

  // L008 — grid alignment
  for (const p of real) {
    if (p.x % GRID !== 0 || p.y % GRID !== 0) {
      add('L008', `${p.ref} origin ${p.x},${p.y} is off the ${GRID} mil grid`, { ref: p.ref });
    }
  }

  const score = Math.max(0, 100 - findings.reduce((n, f) => n + RULES[f.code].weight, 0));
  return { sheet: sheetLabel, file, findings, score, counts: { parts: real.length, wires: segs.length } };
}

/** Lint every sheet of a project. */
function lintProject(dir) {
  const project = E.Project.load(dir);
  const sheets = [];
  for (const sheet of Object.values(project.profile.sheets)) {
    const file = project.sheetFile(sheet);
    if (!fs.existsSync(file)) continue;
    const sch = project.profile.schematics[sheet.schematic_uuid];
    sheets.push(lintSheet(file, `${sch ? sch.name : '?'}/${sheet.title}`));
  }
  const all = sheets.flatMap((s) => s.findings);
  return {
    sheets,
    findings: all,
    errors: all.filter((f) => f.level === 'error').length,
    warnings: all.filter((f) => f.level === 'warn').length,
    score: sheets.length ? Math.round(sheets.reduce((n, s) => n + s.score, 0) / sheets.length) : 0
  };
}

module.exports = { RULES, lintSheet, lintProject, collectSheet, FRAME, GRID };
void path;
