#!/usr/bin/env node
'use strict';
/**
 * recipe.js — a parameterised library of sub-circuits.
 *
 * A recipe is a complete, buildable `design.json` (so it can be run directly
 * with build.js) that additionally may declare `params` and use `${NAME}`
 * placeholders anywhere in its JSON. That gives a shop of reusable blocks:
 * pull one in, override two numbers, rename two nets, done.
 *
 *   node scripts/recipe.js list
 *   node scripts/recipe.js show ldo-3v3 [--json]
 *   node scripts/recipe.js apply ldo-3v3 --to design.json \
 *        [--set cin=22uF,cout=22uF] [--net VOUT=3V3_RAIL] [--suffix _2] \
 *        [--out new-design.json]
 *
 * `apply` merges the recipe's parts/blocks/powers/nets into the target design,
 * renaming colliding part ids (and their block references) with --suffix.
 * Everything is plain JSON manipulation — no templating engine.
 */
const fs = require('fs');
const path = require('path');
const { parseArgs, printHelp, die, readJsonText, parseJsonText } = require('./lib/utils');
const M = require('./lib/merge');

const ROOT = path.join(__dirname, '..');
const RECIPE_DIR = M.RECIPE_DIR;
const recipeFiles = M.recipeFiles;
const loadRecipe = M.loadRecipe;
const expand = M.expand;
const parsePairs = M.parsePairs;

const SCHEMA = [
  { name: 'recipe', desc: 'recipe name (omit for `list`)' },
  { name: 'to', desc: 'target design.json to merge into (apply)' },
  { name: 'out', desc: 'write the merged design here instead of over --to' },
  { name: 'set', desc: 'parameter overrides, comma separated: k=v,k=v' },
  { name: 'net', desc: 'net renames, comma separated: OLD=NEW,OLD=NEW' },
  { name: 'suffix', desc: 'suffix for colliding part ids (default _2)' },
  { name: 'device', desc: 'typed recipes: bind this IC entry instead of the auto-selected one' },
  { name: 'class', desc: 'devices: filter by device class (e.g. regulator.ldo)' },
  { name: 'json', desc: 'machine-readable output', hasValue: false }
];

function summarize(name, raw) {
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  return {
    name,
    title: raw.name || name,
    type: raw.type || null,
    deviceClass: (raw.bind && raw.bind.device && raw.bind.device.class) || null,
    blockCount: (raw.blocks || []).length,
    blocks: (raw.blocks || []).map((b) => b.title || b.name || '(untitled)'),
    parts: parts.map((p) => p.id),
    nets: [...new Set(parts.flatMap((p) => Object.values(p.pins || {})))].sort(),
    params: raw.params || {},
    board: raw.board || null
  };
}

function cmdList(opts) {
  const rows = recipeFiles().map((f) => {
    const name = f.replace(/\.json$/, '');
    const raw = parseJsonText(readJsonText(path.join(RECIPE_DIR, f)));
    return summarize(name, raw);
  });
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`${'recipe'.padEnd(20)} ${'parts'.padStart(5)}  ${'params'.padStart(6)}  ${'device class'.padEnd(18)} blocks`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(20)} ${String(r.parts.length).padStart(5)}  `
      + `${String(Object.keys(r.params).length).padStart(6)}  ${String(r.deviceClass || '—').padEnd(18)} ${r.blocks.join(' | ')}`);
  }
  console.log(`\n${rows.length} recipes in recipe/`);
}

function cmdDevices(opts) {
  // which library entries can satisfy a typed recipe's device slot
  const S = require('./lib/select');
  const rows = S.listDevices({ class: opts.class });
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) {
    console.log('class-based device selection is gone in 2.x — pin "ic": "<system-library device>" (or "lcsc": "Cxxxx") in the recipe');
    return;
  }
  console.log(`${'device'.padEnd(22)} ${'class'.padEnd(20)} roles`);
  for (const d of rows) console.log(`${d.name.padEnd(22)} ${d.class.padEnd(20)} ${d.roles.join(' ')}`);
}

function cmdShow(opts) {
  if (!opts.recipe) die('show needs a recipe name');
  const { raw, params } = loadRecipe(opts.recipe);
  const expanded = expand(raw, params);
  if (opts.json) {
    console.log(JSON.stringify({ params, design: expanded }, null, 2));
    return;
  }
  const s = summarize(opts.recipe, expanded);
  console.log(`${s.name} — ${s.title}`);
  console.log(`  board: ${s.board ? `${s.board.width}×${s.board.height} mil` : 'default'}`);
  console.log(`  blocks: ${s.blocks.join(' | ') || '(none)'}`);
  console.log(`  parts: ${s.parts.join(', ')}`);
  console.log(`  nets: ${s.nets.join(', ')}`);
  const keys = Object.keys(s.params);
  if (keys.length) {
    console.log('  params:');
    for (const k of keys) console.log(`    ${k} = ${s.params[k]}`);
  } else {
    console.log('  params: (none — still copy-pasteable as a design)');
  }
  console.log('\n  apply: node scripts/recipe.js apply ' + opts.recipe + ' --to <design.json>'
    + (keys.length ? ` --set ${keys.map((k) => `${k}=...`).join(',')}` : ''));
}

function cmdApply(opts) {
  if (!opts.recipe) die('apply needs a recipe name');
  if (!opts.to) die('apply needs --to <design.json>');
  const target = path.resolve(opts.to);
  if (!fs.existsSync(target)) die(`target design not found: ${target}`);
  const overrides = parsePairs(opts.set, 'set');
  const netRenames = parsePairs(opts.net, 'net');
  const resolved = M.resolveRecipe(opts.recipe, overrides, netRenames, { device: opts.device });
  const { declared, unknown, params, recipe } = resolved;
  if (resolved.device) {
    console.log(`  device: ${resolved.device.name} (class ${resolved.device.class}`
      + `${resolved.device.candidates.length > 1 ? `, candidates: ${resolved.device.candidates.join(', ')}` : ''})`);
  }
  for (const k of unknown) {
    console.error(`warning: "${k}" is not a declared param of ${opts.recipe} (declared: ${Object.keys(declared).join(', ') || 'none'})`);
  }

  const design = parseJsonText(readJsonText(target));
  const merged = M.merge(design, recipe, {
    suffix: opts.suffix,
    params,
    netRenames,
    onPowerConflict: (net, kept, wanted) => {
      console.error(`warning: net "${net}" already declares power "${kept}", keeping it`);
    }
  });
  const out = merged.design;
  const summary = merged.summary;

  const outPath = opts.out ? path.resolve(opts.out) : target;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  const json = Object.assign({ recipe: opts.recipe, params, netRenames, written: outPath }, summary);
  if (opts.json) { console.log(JSON.stringify(json, null, 2)); return; }
  console.log(`merged ${opts.recipe} into ${path.basename(target)} → ${outPath}`);
  console.log(`  parts: +${summary.addedParts.length} (${summary.addedParts.join(', ')}) — ${out.parts.length} total`);
  console.log(`  blocks: ${summary.addedBlocks.join(' | ') || '(none)'}`);
  if (Object.keys(overrides).length) {
    console.log(`  params: ${Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log(`next: node scripts/build.js --design ${path.relative(process.cwd(), outPath)} --dir <project dir>`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('recipe.js <list|show|apply> [options]', SCHEMA,
      'A parameterised library of buildable sub-circuits. `list` needs no other option.');
    return;
  }
  if (cmd === 'list') { cmdList(parseArgs(argv.slice(1), SCHEMA).opts); return; }
  const { opts, positional } = parseArgs(argv.slice(1), SCHEMA);
  // `recipe.js show ldo-3v3` — the name may be positional or --recipe.
  if (!opts.recipe && positional.length) opts.recipe = positional[0];
  if (cmd === 'show') { cmdShow(opts); return; }
  if (cmd === 'devices') { cmdDevices(opts); return; }
  if (cmd === 'apply') { cmdApply(opts); return; }
  die(`unknown command "${cmd}" (want: list | show | apply)`);
}

main();
