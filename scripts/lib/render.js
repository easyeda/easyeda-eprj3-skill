'use strict';
/**
 * render.js — draw a sheet as SVG so the result can be LOOKED at.
 *
 * The geometry checks catch what is mechanically wrong; a picture catches what
 * is merely ugly. Rendering to SVG (no canvas, no image library, no deps)
 * gives an agent a reviewable artifact and gives a human a 3-second sanity
 * check. The SVG is a schematic sketch, not a plotter-accurate export: symbols
 * are drawn as their body box plus pin stubs, which is exactly the information
 * needed to judge layout, spacing, wire routing and block structure.
 */

const fs = require('fs');
const path = require('path');
const E = require('./eprj3');
const G = require('./geom');
const P = require('./parts');
const N = require('./netlist');

const THEME = {
  bg: '#ffffff',
  frame: '#c8ccd4',
  blockFill: '#f4f7fb',
  blockStroke: '#8ea8c3',
  body: '#1f2933',
  bodyFill: '#fff8e6',
  pin: '#2b6cb0',
  wire: '#1a7f37',
  label: '#8a4b00',
  text: '#111827',
  power: '#b91c1c',
  title: '#0b4f8a'
};

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collect(file) {
  const { docs, main } = N.readSheet(file);
  const symbolByUuid = new Map();
  for (const d of docs) {
    if (d.docType !== 'SYMBOL') continue;
    symbolByUuid.set(d.uuid, P.parseSymbolEntry({
      symbolDoc: d.records.map((r) => E.formatRecord(r.head, r.body))
    }));
  }
  const recs = main.records;
  const attrs = recs.filter((r) => r.type === 'ATTR' && r.body);
  const comps = [];
  const rects = [];
  const texts = [];
  const wires = [];
  const wireNets = new Map();
  for (const r of recs) {
    if (r.type === 'ATTR' && r.body.key === 'NET' && r.body.parentId) wireNets.set(r.body.parentId, r.body.value);
  }
  for (const r of recs) {
    if (r.type === 'COMPONENT') {
      const b = r.body || {};
      const mine = attrs.filter((a) => a.body.parentId === r.id);
      const des = mine.find((a) => a.body.key === 'Designator');
      const symAttr = mine.find((a) => a.body.key === 'Symbol');
      const gn = mine.find((a) => a.body.key === 'Global Net Name');
      const dn = b.attrs && b.attrs.DeviceName ? JSON.parse(b.attrs.DeviceName) : null;
      comps.push({
        ref: (des && des.body.value) || (gn ? gn.body.value : '?'),
        x: b.x, y: b.y, rotation: b.rotation || 0,
        sym: symAttr ? symbolByUuid.get(symAttr.body.value) : null,
        power: gn ? gn.body.value : null,
        name: dn ? dn.name : null
      });
    } else if (r.type === 'RECT') {
      rects.push(G.rect(r.body.dotX1, r.body.dotY1, r.body.dotX2, r.body.dotY2));
    } else if (r.type === 'TEXT') {
      texts.push({ x: r.body.x, y: r.body.y, value: r.body.value, size: r.body.fontSize || 12 });
    } else if (r.type === 'LINE' && r.body && wireNets.has(r.body.lineGroup)) {
      wires.push({ x1: r.body.startX, y1: r.body.startY, x2: r.body.endX, y2: r.body.endY, net: wireNets.get(r.body.lineGroup) });
    }
  }
  return { comps, rects, texts, wires };
}

/** Render one sheet to an SVG string. Sheet is Y-up; every Y is negated here. */
function renderSheet(file, opts) {
  const o = opts || {};
  const { comps, rects, texts, wires } = collect(file);

  const pts = [];
  for (const c of comps) {
    pts.push({ x: c.x, y: c.y });
    if (c.sym && c.sym.bbox) {
      const b = c.sym.bbox;
      for (const [x, y] of [[b.x1, b.y1], [b.x2, b.y2]]) {
        const r = G.rotate(x, y, c.rotation);
        pts.push({ x: c.x + r.x, y: c.y + r.y });
      }
    }
  }
  for (const r of rects) pts.push({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 });
  for (const w of wires) pts.push({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 });
  for (const t of texts) pts.push({ x: t.x, y: t.y });
  const bb = G.bboxOfPoints(pts) || { x1: 0, y1: -1000, x2: 1000, y2: 0 };
  const margin = 160;
  const x0 = bb.x1 - margin;
  const yTop = -bb.y2 - margin;
  const w = (bb.x2 - bb.x1) + margin * 2;
  const h = (bb.y2 - bb.y1) + margin * 2;
  const stroke = o.stroke || 1;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w / 3)}" height="${Math.round(h / 3)}" viewBox="${x0} ${yTop} ${w} ${h}">`);
  out.push(`<rect x="${x0}" y="${yTop}" width="${w}" height="${h}" fill="${THEME.bg}"/>`);

  for (const r of rects) {
    out.push(`<rect x="${r.x1}" y="${-r.y2}" width="${r.x2 - r.x1}" height="${r.y2 - r.y1}" fill="${THEME.blockFill}" stroke="${THEME.blockStroke}" stroke-width="${stroke * 2}" stroke-dasharray="8 6" opacity="0.7"/>`);
  }

  for (const wr of wires) {
    out.push(`<line x1="${wr.x1}" y1="${-wr.y1}" x2="${wr.x2}" y2="${-wr.y2}" stroke="${THEME.wire}" stroke-width="${stroke * 2}"/>`);
  }

  for (const c of comps) {
    if (c.power) {
      out.push(`<line x1="${c.x}" y1="${-c.y}" x2="${c.x}" y2="${-c.y - 18}" stroke="${THEME.power}" stroke-width="${stroke * 2}"/>`);
      out.push(`<line x1="${c.x - 12}" y1="${-c.y - 18}" x2="${c.x + 12}" y2="${-c.y - 18}" stroke="${THEME.power}" stroke-width="${stroke * 2}"/>`);
      out.push(`<text x="${c.x + 6}" y="${-c.y - 24}" font-family="monospace" font-size="18" fill="${THEME.power}">${esc(c.power)}</text>`);
      continue;
    }
    const b = (c.sym && c.sym.bbox) || G.rect(-20, -10, 20, 10);
    const corners = [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]].map(([x, y]) => {
      const r = G.rotate(x, y, c.rotation);
      return [c.x + r.x, -(c.y + r.y)];
    });
    out.push(`<polygon points="${corners.map((p) => p.join(',')).join(' ')}" fill="${THEME.bodyFill}" stroke="${THEME.body}" stroke-width="${stroke * 1.5}"/>`);
    if (c.sym) {
      for (const pin of c.sym.pins) {
        const t = G.pinTip(pin, c.x, c.y, c.rotation);
        const base = G.rotate(pin.x, pin.y, c.rotation);
        out.push(`<line x1="${c.x + base.x}" y1="${-(c.y + base.y)}" x2="${t.x}" y2="${-t.y}" stroke="${THEME.pin}" stroke-width="${stroke * 1.5}"/>`);
        out.push(`<circle cx="${t.x}" cy="${-t.y}" r="${stroke * 2.2}" fill="${THEME.pin}"/>`);
      }
    }
    out.push(`<text x="${c.x - 14}" y="${-c.y + 32}" font-family="monospace" font-size="20" fill="${THEME.text}">${esc(c.ref)}</text>`);
  }

  for (const t of texts) {
    out.push(`<text x="${t.x}" y="${-t.y}" font-family="sans-serif" font-size="${Math.max(16, t.size * 2)}" fill="${THEME.title}" font-weight="bold">${esc(t.value)}</text>`);
  }
  const netLabels = new Set(wires.map((x) => x.net).filter(Boolean));
  out.push(`<text x="${x0 + 12}" y="${yTop + 26}" font-family="sans-serif" font-size="20" fill="${THEME.text}">nets: ${esc([...netLabels].sort().join(' / '))}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

/** Render every sheet into <projectDir>/preview/<sch>_<sheet>.svg */
function renderProject(dir, outDir) {
  const project = E.Project.load(dir);
  const target = outDir || path.join(dir, 'preview');
  fs.mkdirSync(target, { recursive: true });
  const written = [];
  for (const sheet of Object.values(project.profile.sheets)) {
    const sch = project.profile.schematics[sheet.schematic_uuid];
    if (!sch) continue;
    const file = project.sheetFile(sheet);
    if (!fs.existsSync(file)) continue;
    const svg = renderSheet(file);
    const out = path.join(target, `${sch.name}_${sheet.title}.svg`);
    fs.writeFileSync(out, svg, 'utf8');
    written.push(out);
  }
  return written;
}

module.exports = { renderSheet, renderProject, collect, THEME };
