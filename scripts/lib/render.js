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

  // Sheets are stored y-down (the client's native space); this sketch is
  // drawn in y-up and negates for SVG. Flip the collected geometry once here
  // so both conventions agree — without this the preview showed the sheet
  // mirrored vertically relative to the client.
  for (const c of comps) c.y = -c.y;
  for (const r of rects) { const t = r.y1; r.y1 = -r.y2; r.y2 = -t; }
  for (const t of texts) t.y = -t.y;
  for (const w of wires) { w.y1 = -w.y1; w.y2 = -w.y2; }

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
    if (c.sym && c.sym.graphics && c.sym.graphics.length) {
      // draw the symbol's real artwork (diode triangle, LED arrows, cap
      // plates…) instead of an anonymous box — the preview must be able to
      // tell a diode from a resistor
      for (const g of c.sym.graphics) {
        if (g.kind === 'poly') {
          const pts = g.points.map((p) => {
            const r = G.rotate(p.x, p.y, c.rotation);
            return `${(c.x + r.x).toFixed(2)},${(-(c.y + r.y)).toFixed(2)}`;
          }).join(' ');
          if (g.closed) {
            out.push(`<polygon points="${pts}" fill="${THEME.bodyFill}" stroke="${THEME.body}" stroke-width="${stroke * 1.5}"/>`);
          } else {
            out.push(`<polyline points="${pts}" fill="none" stroke="${THEME.body}" stroke-width="${stroke * 1.5}"/>`);
          }
        } else if (g.kind === 'rect') {
          const rc = [[g.x1, g.y1], [g.x2, g.y1], [g.x2, g.y2], [g.x1, g.y2]].map(([x, y]) => {
            const r = G.rotate(x, y, c.rotation);
            return `${(c.x + r.x).toFixed(2)},${(-(c.y + r.y)).toFixed(2)}`;
          }).join(' ');
          out.push(`<polygon points="${rc}" fill="${THEME.bodyFill}" stroke="${THEME.body}" stroke-width="${stroke * 1.5}"/>`);
        }
      }
    } else {
      out.push(`<polygon points="${corners.map((p) => p.join(',')).join(' ')}" fill="${THEME.bodyFill}" stroke="${THEME.body}" stroke-width="${stroke * 1.5}"/>`);
    }
    if (c.sym) {
      for (const pin of c.sym.pins) {
        // the hotspot is the connection point; the drawn pin line runs inward
        // along +rotation toward the body
        const t = G.pinTip(pin, c.x, c.y, c.rotation);
        const inward = G.rotate(
          pin.x + pin.length * Math.cos(pin.rotation * Math.PI / 180),
          pin.y + pin.length * Math.sin(pin.rotation * Math.PI / 180),
          c.rotation);
        out.push(`<line x1="${t.x}" y1="${-t.y}" x2="${c.x + inward.x}" y2="${-(c.y + inward.y)}" stroke="${THEME.pin}" stroke-width="${stroke * 1.5}"/>`);
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
  // the deliverable PCB is placement-only — a picture of the placement (board
  // outline, pads, refdes, rats) is how a human checks it without the client
  for (const pcb of Object.values(project.profile.pcbs || {})) {
    const file = project.pcbFile(pcb);
    if (!fs.existsSync(file)) continue;
    const svg = renderPcbFile(file);
    const out = path.join(target, `${pcb.title}.svg`);
    fs.writeFileSync(out, svg, 'utf8');
    written.push(out);
  }
  return written;
}

// ------------------------------------------------------------ PCB preview
const PCB_THEME = {
  bg: '#ffffff',
  outline: '#334155',
  pad: '#b45309',
  padBottom: '#7c3aed',
  hole: '#ffffff',
  rats: '#dc2626',
  text: '#111827'
};

/** Render one PCB document to an SVG string: outline + pads + refdes + rats. */
function renderPcbFile(file) {
  const DRC = require('./drc');   // local require: drc → eprj3/geom only, no cycle with render
  const P = require('./parts');
  const lines = E.readLines(file);
  const docs = DRC.docSplit(lines);
  const main = docs.find((d) => d.docType === 'PCB') || docs[0] || { records: [] };
  const geo = DRC.pcbGeometry(file);

  let outline = null;
  const refPos = [];
  const attrs = main.records.filter((r) => r.type === 'ATTR' && r.body);
  for (const r of main.records) {
    if (r.type === 'POLY' && r.body && r.body.polyType === 'BOARD_OUTLINE' && !outline) {
      outline = P.pathToPoints(r.body.path);
    }
    if (r.type === 'COMPONENT') {
      const des = attrs.find((a) => a.body.key === 'Designator' && a.body.parentId === r.id);
      if (des) refPos.push({ ref: des.body.value, x: r.body.x, y: r.body.y, angle: r.body.angle || 0 });
    }
  }

  const pts = [];
  for (const p of outline || []) pts.push(p);
  for (const p of geo.pads) pts.push({ x: p.x - p.w / 2, y: p.y - p.h / 2 }, { x: p.x + p.w / 2, y: p.y + p.h / 2 });
  const bb = G.bboxOfPoints(pts) || { x1: 0, y1: 0, x2: 1000, y2: 1000 };
  const margin = 120;
  const x0 = bb.x1 - margin;
  const yTop = -bb.y2 - margin;
  const w = (bb.x2 - bb.x1) + margin * 2;
  const h = (bb.y2 - bb.y1) + margin * 2;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w / 4)}" height="${Math.round(h / 4)}" viewBox="${x0} ${yTop} ${w} ${h}">`);
  out.push(`<rect x="${x0}" y="${yTop}" width="${w}" height="${h}" fill="${PCB_THEME.bg}"/>`);

  if (outline && outline.length >= 3) {
    const pts2 = outline.map((p) => `${p.x},${-p.y}`).join(' ');
    out.push(`<polygon points="${pts2}" fill="none" stroke="${PCB_THEME.outline}" stroke-width="4"/>`);
  }

  // rats first (under the pads): chain each net's pads nearest-neighbour
  const byNet = new Map();
  for (const p of geo.pads) {
    if (!p.net || /^(NC|DNC\d*)$/i.test(p.net)) continue;
    if (!byNet.has(p.net)) byNet.set(p.net, []);
    byNet.get(p.net).push(p);
  }
  for (const pads of byNet.values()) {
    if (pads.length < 2) continue;
    const rest = pads.slice(1);
    let cur = pads[0];
    while (rest.length) {
      let best = 0;
      for (let i = 1; i < rest.length; i += 1) {
        if (Math.hypot(rest[i].x - cur.x, rest[i].y - cur.y) < Math.hypot(rest[best].x - cur.x, rest[best].y - cur.y)) best = i;
      }
      const nx = rest.splice(best, 1)[0];
      out.push(`<line x1="${cur.x}" y1="${-cur.y}" x2="${nx.x}" y2="${-nx.y}" stroke="${PCB_THEME.rats}" stroke-width="2" stroke-dasharray="10 8" opacity="0.8"/>`);
      cur = nx;
    }
  }

  for (const p of geo.pads) {
    const fill = p.layer === 2 ? PCB_THEME.padBottom : PCB_THEME.pad;
    out.push(`<rect x="${p.x - p.w / 2}" y="${-(p.y + p.h / 2)}" width="${p.w}" height="${p.h}" fill="${fill}" stroke="${PCB_THEME.outline}" stroke-width="1"/>`);
    if (p.hole) {
      out.push(`<circle cx="${p.x}" cy="${-p.y}" r="${p.hole / 2}" fill="${PCB_THEME.hole}" stroke="${PCB_THEME.outline}" stroke-width="1.5"/>`);
    }
  }
  for (const c of refPos) {
    out.push(`<text x="${c.x - 10}" y="${-c.y + 6}" font-family="monospace" font-size="26" fill="${PCB_THEME.text}">${esc(c.ref)}</text>`);
  }
  const netCount = [...byNet.values()].filter((v) => v.length >= 2).length;
  out.push(`<text x="${x0 + 12}" y="${yTop + 30}" font-family="sans-serif" font-size="30" fill="${PCB_THEME.text}">placement-only · ${geo.pads.length} pads · rats: ${netCount} net(s) to route in the client</text>`);
  out.push('</svg>');
  return out.join('\n');
}

module.exports = { renderSheet, renderProject, renderPcbFile, collect, THEME };
