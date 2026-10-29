#!/usr/bin/env node
'use strict';
/**
 * fetch-lcsc.js — fetch a part's symbol + footprint from the EasyEDA 官方库
 * and convert it into this skill's IC entry format.
 *
 *   node scripts/fetch-lcsc.js --id C8734                 # print the IC entry JSON
 *   node scripts/fetch-lcsc.js --id C6186 --out <file>    # write the entry to a file
 *   node scripts/fetch-lcsc.js --id C6186 --install       # write into templates/library/ic/
 *   node scripts/fetch-lcsc.js --id C6186 --raw           # dump the raw API JSON
 *
 * Source: https://easyeda.com/api/products/{LCSC}/components — the official
 * EasyEDA library (嘉立创EDA官方库; license header inside the payload). The
 * symbol's pin list and the footprint's pad coordinates are carried over
 * VERBATIM (converted from 10-mil units, y-down → mil/y-up), so pin
 * definitions are never invented. The entry's `evidence` block cites the API
 * URL, the footprint title and the datasheet link from the payload.
 *
 * This is the ONE sanctioned network call in the skill (user-initiated, per
 * part). Everything else stays offline.
 */
const fs = require('fs');
const path = require('path');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'id', desc: 'LCSC part number, e.g. C8734', required: true },
  { name: 'out', desc: 'write the converted IC entry JSON to this file' },
  { name: 'install', desc: 'write the entry into templates/library/ic/ (maintainer use)', hasValue: false },
  { name: 'raw', desc: 'dump the raw API JSON instead of converting', hasValue: false }
];

const POWER_NAME = /^(VDD|VSS|VBAT|VDDA|VSSA|GND|VIN|VOUT|VREF|AVDD|AVSS|VCC|VSS_?\d*)$/i;
const DIR_OF = { bidirectional: 'B', input: 'I', output: 'O', power_in: 'W', passive: 'P', tri_state: 'T', open_collector: 'C' };

// EasyEDA standard symbol shapes → verbatim internal (y-up mil) geometry.
// Units: 1 unit = 10 mil. EasyEDA symbol canvas is y-down; we flip to y-up so
// the whole build pipeline keeps its conventions (the sheet write mirrors back
// into the client's y-down space).
const UNIT = 10;

function shapePts(str) {
  return String(str).trim().split(/\s+/).map(Number);
}

function decodeSymbolRaw(dataStr) {
  const head = dataStr.head || {};
  const hx = head.x || 0, hy = head.y || 0;
  const pins = [];
  const graphics = [];
  let skipped = 0;
  const toY = (y) => -((y - hy) * UNIT);   // y-down → y-up
  const toX = (x) => (x - hx) * UNIT;

  for (const s of dataStr.shape || []) {
    const str = String(s);
    const f = str.split('~');
    const kind = f[0];
    if (kind === 'P') {
      // P~show~electric~num~x~y~rot~ggeId~locked  (x,y = connection point)
      const num = String(f[3]);
      const x = toX(parseFloat(f[4]));
      const y = toY(parseFloat(f[5]));
      const stdRot = ((parseInt(f[6], 10) || 0) % 360 + 360) % 360;
      // the pin line extends FROM the hotspot toward the body: EasyEDA rot is
      // the direction the line extends in ITS frame; Pro rot = std + 180
      const rotation = (stdRot + 180) % 360;
      let name = num;
      for (const seg of str.split('^^').slice(1)) {
        const sf = seg.split('~');
        if (sf.length >= 6 && (sf[5] === 'start' || sf[5] === 'end') && sf[4] && Number.isNaN(Number(sf[4]))) { name = sf[4]; break; }
      }
      pins.push({ num, name, x, y, rotation, length: 100, electric: f[2] });
    } else if (kind === 'PL') {
      // PL~points~stroke~width~dash~id~locked  (open polyline)
      const pts = shapePts(f[1]).map((v, i) => (i % 2 === 0 ? toX(v) : toY(v)));
      if (pts.length < 4) { skipped++; continue; }
      graphics.push({ type: 'POLY', body: { points: pairsOf(pts), closed: false, fillColor: null } });
    } else if (kind === 'PG') {
      // PG~points~stroke~width~dash~fill~id~locked  (closed polygon, filled)
      const pts = shapePts(f[1]).map((v, i) => (i % 2 === 0 ? toX(v) : toY(v)));
      if (pts.length < 6) { skipped++; continue; }
      graphics.push({ type: 'POLY', body: { points: pairsOf(pts), closed: true, fillColor: f[5] && f[5] !== 'none' ? f[5] : null } });
    } else if (kind === 'R') {
      // R~x~y~w~h~…~stroke~width~dash~fill~id~locked
      const x = toX(parseFloat(f[1])), y = toY(parseFloat(f[2]));
      const w = parseFloat(f[3]) * UNIT, h = parseFloat(f[4]) * UNIT;
      graphics.push({ type: 'RECT', body: { x: x, y: y - h, x2: x + w, y2: y, fillColor: f[10] && f[10] !== 'none' ? f[10] : null } });
    } else if (kind === 'E') {
      // E~cx~cy~rx~ry~stroke~width~dash~fill~id~locked
      graphics.push({ type: 'CIRCLE', body: { cx: toX(parseFloat(f[1])), cy: toY(parseFloat(f[2])), r: parseFloat(f[3]) * UNIT, fillColor: f[8] && f[8] !== 'none' ? f[8] : null } });
    } else if (kind === 'PT' || kind === 'TA' || kind === 'A') {
      skipped++; // arcs: rare in symbols, approximated later if needed
    } else if (kind !== 'P') {
      skipped++;
    }
  }
  return { pins, graphics, skipped };
}

function pairsOf(flat) {
  // EasyEDA point strings → [{x, y}, ...] in mil; polygons close themselves
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({ x: flat[i], y: flat[i + 1] });
  }
  if (out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) > 0.01 || Math.abs(first.y - last.y) > 0.01) out.push(Object.assign({}, first));
  }
  return out;
}

function decodePads(dataStr) {
  const head = dataStr.head || {};
  const pads = [];
  for (const s of dataStr.shape || []) {
    const str = String(s);
    if (!str.startsWith('PAD~')) continue;
    const f = str.split('~');
    // PAD~shape~cx~cy~w~h~layerId~net~num~...
    pads.push({
      num: String(f[8]),
      x: +((parseFloat(f[2]) - (head.x || 0)) * 10).toFixed(2),
      y: -((parseFloat(f[3]) - (head.y || 0)) * 10).toFixed(2),
      w: +(parseFloat(f[4]) * 10).toFixed(2),
      h: +(parseFloat(f[5]) * 10).toFixed(2)
    });
  }
  return pads;
}

// footprint silk: TRACK / PR / PL records on the silk layers → silks paths
function decodeFootprintSilks(dataStr) {
  const head = dataStr.head || {};
  const out = [];
  for (const s of dataStr.shape || []) {
    const str = String(s);
    const f = str.split('~');
    const kind = f[0];
    if (kind === 'TRACK' && f[2] === '3') {
      // TRACK~lineWidth~layerId~net~points~id~locked — layer 3 = top silk
      const pts = String(f[4]).trim().split(/\s+/).map(Number);
      const path = [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        path.push(+((pts[i] - head.x) * 10).toFixed(2), +((pts[i + 1] - head.y) * 10).toFixed(2));
        if (i + 3 < pts.length) path.push('L');
      }
      if (path.length >= 4) out.push({ path });
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('fetch-lcsc.js [options]', SCHEMA,
      'Fetch a part from the EasyEDA 官方库 and convert it into an IC entry (symbol pins + footprint verbatim).');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const id = String(opts.id || '').trim().toUpperCase();
  if (!/^C\d+$/.test(id)) die(`bad --id "${opts.id}" (want an LCSC number like C8734)`);

  const url = `https://easyeda.com/api/products/${id}/components`;
  let payload;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) die(`fetch failed: HTTP ${res.status} for ${url}`);
    payload = await res.json();
  } catch (e) {
    die(`fetch failed: ${e.message} — check the network, or curate the entry by hand (docs/development.md)`);
  }
  const r = payload && payload.result;
  if (!r || !r.title) die('unexpected API payload (no result.title)');

  if (opts.raw) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const symTitle = r.title;
  const fp = r.packageDetail || {};
  const fpTitle = fp.title || 'UNKNOWN';

  // symbol → verbatim raw (graphics + pin geometry + device attrs preserved)
  let rawSymbol = null;
  let pinCount = 0;
  if (r.dataStr && Array.isArray(r.dataStr.shape)) {
    const dec = decodeSymbolRaw(r.dataStr);
    rawSymbol = { pins: dec.pins, graphics: dec.graphics };
    pinCount = dec.pins.length;
    if (dec.skipped) console.error(`  note: \${dec.skipped} unsupported shape(s) skipped`);
  } else {
    die('payload has no symbol shape data');
  }

  let footprint;
  let silks = [];
  if (fp.dataStr && Array.isArray(fp.dataStr.shape)) {
    const pads = decodePads(fp.dataStr);
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const p of pads) {
      x1 = Math.min(x1, p.x - p.w / 2); x2 = Math.max(x2, p.x + p.w / 2);
      y1 = Math.min(y1, p.y - p.h / 2); y2 = Math.max(y2, p.y + p.h / 2);
    }
    silks = decodeFootprintSilks(fp.dataStr);
    footprint = {
      name: fpTitle,
      designator: 'U',
      pads: pads.map((p) => [p.num, p.x, p.y, p.w, p.h]),
      outline: [Math.round(x1 - 15), Math.round(y1 - 15), Math.round(x2 + 15), Math.round(y2 + 15)],
      silks
    };
  } else {
    footprint = { auto: 'SOP', pins: Math.ceil(pinCount / 2) * 2 };
  }

  const attrs = (r.dataStr.head && r.dataStr.head.c_para) || {};
  const datasheet = fp.c_para && fp.c_para.link ? String(fp.c_para.link) : (r.datasheet ? String(r.datasheet).replace(/^\/*/, 'https://') : null);
  const entry = {
    name: symTitle.replace(/_[Cc]\d+$/, ''),
    description: [r.description, attrs.Manufacturer ? `厂商：${attrs.Manufacturer}` : '', attrs['Manufacturer Part'] ? `型号：${attrs['Manufacturer Part']}` : ''].filter(Boolean).join('；'),
    designator: String(attrs.pre || 'U').replace(/\?$/, '') + '?',
    rawSymbol,
    footprint,
    attributes: attrs,
    evidence: {
      symbol: `EasyEDA 官方库 ${id}（${symTitle} 器件符号，图形/引脚/属性逐字）— https://easyeda.com/api/products/${id}/components`,
      footprint: `EasyEDA 官方库 ${id} 封装 ${fpTitle}（焊盘/丝印逐字）— 同上`,
      datasheet: datasheet || '（payload 未附 datasheet 链接）'
    }
  };

  const pinCountNote = `  note: ${pinCount} pins, ${footprint.pads ? footprint.pads.length : "?"} pads, ${silks.length} silk path(s)`;
  const json = JSON.stringify(entry, null, 2) + '\n';
  console.error(pinCountNote);
  if (opts.install) {
    const dir = path.join(__dirname, '..', 'templates', 'library', 'ic');
    const file = path.join(dir, `${entry.name}.json`);
    fs.writeFileSync(file, json, 'utf8');
    console.log(`installed IC entry: ${file}`);
    console.log(`next: rebuild (build.js picks it up), and add a pin-count assert in test/dfm.js`);
    return;
  }
  if (opts.out) {
    fs.writeFileSync(path.resolve(opts.out), json, 'utf8');
    console.log(`wrote ${opts.out}`);
    return;
  }
  console.log(json);
}

main();
