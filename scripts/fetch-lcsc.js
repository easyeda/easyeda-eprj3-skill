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

function decodeSymbolPins(dataStr) {
  const shapes = Array.isArray(dataStr.shape) ? dataStr.shape : [];
  const pins = [];
  for (const s of shapes) {
    const str = String(s);
    if (!str.startsWith('P~')) continue;
    const main = str.split('^^');
    const head = main[0].split('~');
    // P~show~electric~number~x~y~rotation~ggeId~locked
    const num = String(head[3]);
    const rot = parseInt(head[6], 10);
    let name = null;
    for (const seg of main.slice(1)) {
      const f = seg.split('~');
      if (f.length >= 6 && (f[5] === 'start' || f[5] === 'end') && f[4] && Number.isNaN(Number(f[4]))) { name = f[4]; break; }
    }
    pins.push({ num, name: name || num, rot });
  }
  // columns: rot 180 = left, rot 0 = right; EasyEDA y grows DOWN, so the
  // bottom-most pin (largest y) comes first in our bottom→top lists
  const left = pins.filter((p) => p.rot === 180).sort((a, b) => b.y - a.y);
  const right = pins.filter((p) => p.rot === 0).sort((a, b) => b.y - a.y);
  const other = pins.filter((p) => p.rot !== 0 && p.rot !== 180);
  for (const p of other) (left.length <= right.length ? left : right).push(p);
  return { left, right, total: pins.length };
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
      y: +(-(parseFloat(f[3]) - (head.y || 0)) * 10).toFixed(2),
      w: +(parseFloat(f[4]) * 10).toFixed(2),
      h: +(parseFloat(f[5]) * 10).toFixed(2),
      shape: f[1]
    });
  }
  return pads;
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

  // symbol pins → num:name:dir:side (dir by official electric type, power
  // names enforced; official electric fields are usually Unspecified)
  let left, right, total;
  if (r.dataStr && Array.isArray(r.dataStr.shape)) {
    const dec = decodeSymbolPins(r.dataStr);
    left = dec.left;
    right = dec.right;
    total = dec.total;
  } else {
    die('payload has no symbol shape data');
  }
  const dirOf = (p) => {
    const t = p.electric && DIR_OF[p.electric];
    if (t) return t;
    return POWER_NAME.test(p.name) ? 'W' : 'B';
  };
  const pinList = [...left, ...right].map((p) => `${p.num}:${p.name}:${dirOf(p)}:${p.rot === 180 ? 'L' : 'R'}`);

  // footprint pads → verbatim (y-down → y-up), outline = pad bbox + 15
  let footprint;
  if (fp.dataStr && Array.isArray(fp.dataStr.shape)) {
    const pads = decodePads(fp.dataStr);
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const p of pads) {
      x1 = Math.min(x1, p.x - p.w / 2); x2 = Math.max(x2, p.x + p.w / 2);
      y1 = Math.min(y1, p.y - p.h / 2); y2 = Math.max(y2, p.y + p.h / 2);
    }
    footprint = {
      name: fpTitle,
      designator: 'U',
      pads: pads.map((p) => [p.num, p.x, p.y, p.w, p.h]),
      outline: [Math.round(x1 - 15), Math.round(y1 - 15), Math.round(x2 + 15), Math.round(y2 + 15)]
    };
  } else {
    footprint = { auto: 'SOP', pins: Math.ceil(total / 2) * 2 };
  }

  const datasheet = r.datasheet ? String(r.datasheet).replace(/^\/*/, 'https://') : null;
  const entry = {
    name: symTitle.replace(/_[Cc]\d+$/, ''),
    description: r.description || '',
    designator: 'U',
    pitch: 100,
    symbol: { pins: pinList },
    footprint,
    evidence: {
      symbol: `EasyEDA 官方库 ${id}（${symTitle} 器件符号，pin 号/名称/列位逐字）— https://easyeda.com/api/products/${id}/components`,
      footprint: `EasyEDA 官方库 ${id} 封装 ${fpTitle}（焊盘坐标逐字）— 同上`,
      datasheet: datasheet || '（payload 未附 datasheet 链接）'
    }
  };

  const json = JSON.stringify(entry, null, 2) + '\n';
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
