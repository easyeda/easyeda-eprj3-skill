#!/usr/bin/env node
'use strict';
/**
 * autofix.js — mechanical, design-level fixes for the most common findings.
 *
 *   node scripts/autofix.js --design design.json [--check] [--out design.json]
 *
 * What it fixes (each is a deliberate, lossless edit to the DESIGN file —
 * never the generated project):
 *   1. pins with no net          → mapped to "NC" (the no-connect convention)
 *   2. dead-end nets (1 pin)     → renamed to "NC" on that pin
 *   3. missing decoupling caps   → adds a 100nF CAP (C0402) from each supply
 *                                  net to ground, one per net, auto-numbered
 *
 * What it deliberately does NOT touch: unrouted nets (D004 — needs a human
 * judgement about board size/placement), footprint geometry, and anything the
 * checks only suspected. Run build.js again after fixing.
 *
 * Exit 0 when nothing is left to fix, 1 when fixes were applied (--check: when
 * fixes are available).
 */
const fs = require('fs');
const path = require('path');
const D = require('./lib/design');
const P = require('./lib/parts');
const { parseArgs, printHelp, readJsonText, parseJsonText } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const PRESETS = path.join(ROOT, 'templates', 'library', 'symbol');

const SCHEMA = [
  { name: 'design', desc: 'design.json to fix in place', required: true },
  { name: 'check', desc: 'report the fixes without applying them', hasValue: false },
  { name: 'diff', desc: 'print the before/after diff of the design file and write nothing (human confirmation gate)', hasValue: false },
  { name: 'out', desc: 'write the fixed design here (default: same file)' }
];

/**
 * Minimal LCS line diff (self-contained, no dependency). Design files are
 * small, so the quadratic table is fine and it keeps the output honest —
 * a "fixes applied" message without a diff is what lets a wrong design look
 * like a successful one.
 */
function diffLines(before, after, ctx) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length; const m = b.length;
  const table = [];
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  const pad = (s, side) => `${side === '-' ? '-' : side === '+' ? '+' : ' '} ${s}`;
  const keep = [];
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.push({ t: ' ', s: a[i], i, j }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { keep.push({ t: '-', s: a[i], i }); i += 1; }
    else { keep.push({ t: '+', s: b[j], j }); j += 1; }
  }
  while (i < n) { keep.push({ t: '-', s: a[i], i }); i += 1; }
  while (j < m) { keep.push({ t: '+', s: b[j], j }); j += 1; }
  // Emit only hunks with ± context lines around changes.
  const changed = keep.map((k, idx) => (k.t === ' ' ? -1 : idx)).filter((x) => x >= 0);
  if (!changed.length) return { text: '(no textual change)', count: 0 };
  const show = new Set();
  for (const idx of changed) {
    for (let k = Math.max(0, idx - (ctx || 2)); k <= Math.min(keep.length - 1, idx + (ctx || 2)); k += 1) show.add(k);
  }
  let prev = -2;
  for (const idx of [...show].sort((x, y) => x - y)) {
    if (idx !== prev + 1) out.push('  …');
    out.push(`  ${pad(keep[idx].s, keep[idx].t)}`);
    prev = idx;
  }
  return { text: out.join('\n'), count: changed.length };
}

/** Pin numbers of a part's symbol, resolved from preset or inline spec. */
function symbolPins(part) {
  if (part.symbol && typeof part.symbol === 'object') {
    return part.symbol.pins.map((s) => String(typeof s === 'string' ? s.split(':')[0] : s.num));
  }
  const file = path.join(PRESETS, `${part.symbol}.json`);
  if (!fs.existsSync(file)) return null;
  const entry = parseJsonText(readJsonText(file));
  if (entry.kind && entry.kind !== 'symbol') return [];
  return P.parseSymbolEntry(entry).pins.map((p) => String(p.num));
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('autofix.js [options]', SCHEMA,
      'Applies mechanical design-level fixes: NC for unconnected/dead-end pins, decoupling caps for supply nets.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const file = path.resolve(opts.design);
  const raw = parseJsonText(readJsonText(file));
  const d = D.normalize(JSON.parse(JSON.stringify(raw)), file);
  const fixes = [];

  const groundNet = Object.entries(d.powers).find(([, v]) => v === 'down');
  const ground = groundNet ? groundNet[0] : (raw.powers && raw.powers.GND === 'down' ? 'GND' : null);

  // ---- pass 1: unconnected pins → NC
  for (const p of d.parts) {
    const nums = symbolPins(p);
    if (!nums) continue;
    for (const num of nums) {
      if (p.pins[num] === undefined) {
        fixes.push(`part ${p.id}: pin ${num} had no net → "NC"`);
        p.pins[num] = 'NC';
      }
    }
  }

  // ---- pass 2: dead-end nets → NC
  const users = new Map();
  for (const p of d.parts) {
    for (const [num, net] of Object.entries(p.pins)) {
      if (!users.has(net)) users.set(net, []);
      users.get(net).push({ p, num });
    }
  }
  for (const [net, list] of users) {
    const isPower = (d.powers[net] === 'up' || d.powers[net] === 'down');
    if (list.length === 1 && !isPower && !/^(NC|DNC\d*)$/i.test(net)) {
      fixes.push(`part ${list[0].p.id}: dead-end net "${net}" on pin ${list[0].num} → "NC"`);
      list[0].p.pins[list[0].num] = 'NC';
    }
  }

  // ---- pass 3: decoupling capacitors for supply nets
  const supplies = Object.entries(d.powers).filter(([, v]) => v === 'up').map(([n]) => n);
  for (const net of supplies) {
    const hasCap = d.parts.some((p) => /^C/i.test(p.id)
      && Object.values(p.pins).includes(net)
      && (!ground || Object.values(p.pins).includes(ground)));
    if (hasCap) continue;
    let n = 1;
    while (d.parts.some((p) => p.id === `C${n}`)) n += 1;
    const part = {
      id: `C${n}`,
      symbol: 'CAP',
      footprint: 'C0402',
      value: '100nF',
      pins: ground ? { 1: net, 2: ground } : { 1: net, 2: 'NC' }
    };
    d.parts.push(D.normalize({ parts: [part] }).parts[0]);
    fixes.push(`added ${part.id} (CAP 100nF, C0402) from "${net}"${ground ? ` to "${ground}"` : ''} — decoupling`);
  }

  // Build the result first: --check / --diff must be able to show exactly what
  // an apply would write, without ever touching the file.
  // Write back preserving the author's style: original part objects keep their
  // other fields, brand-new parts (autofix-added caps) are emitted canonical.
  const out = Object.assign({}, raw);
  out.parts = d.parts.map((p) => {
    const src = raw.parts.find((x) => String(x.id) === p.id);
    if (src) return Object.assign({}, src, { id: p.id, pins: p.pins });
    return {
      id: p.id, symbol: p.symbol, footprint: p.footprint,
      ...(p.value == null ? {} : { value: p.value }),
      ...(p.name == null ? {} : { name: p.name }),
      pins: p.pins,
      ...(p.rotation == null ? {} : { rotation: p.rotation })
    };
  });
  out.powers = d.powers;

  if (!fixes.length) {
    console.log('autofix: nothing to fix — the design already maps every pin and decouples every supply.');
    return;
  }
  if (opts.check) {
    console.log(`autofix --check: ${fixes.length} fix(es) available:`);
    for (const f of fixes) console.log(`  · ${f}`);
    process.exit(1);
  }
  if (opts.diff) {
    // Normalise both sides to the same 2-space shape so the diff shows the
    // semantic change, not the author's indentation.
    const before = JSON.stringify(raw, null, 2);
    const after = JSON.stringify(out, null, 2);
    const d2 = diffLines(before, after, 3);
    console.log(`autofix --diff: ${fixes.length} fix(es), ${d2.count} changed line(s) — nothing written`);
    for (const f of fixes) console.log(`  · ${f}`);
    console.log(d2.text);
    console.log('\n确认后应用: node scripts/autofix.js --design <file>');
    process.exit(1);
  }
  const target = opts.out ? path.resolve(opts.out) : file;
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`autofix: applied ${fixes.length} fix(es) → ${target}`);
  for (const f of fixes) console.log(`  · ${f}`);
  console.log('next: node scripts/build.js --design <file> --dir <dir> --force');
  process.exit(1);
}

main();
