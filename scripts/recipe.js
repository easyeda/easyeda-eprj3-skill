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
const { parseArgs, printHelp, die } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const RECIPE_DIR = path.join(ROOT, 'recipe');

const SCHEMA = [
  { name: 'recipe', desc: 'recipe name (omit for `list`)' },
  { name: 'to', desc: 'target design.json to merge into (apply)' },
  { name: 'out', desc: 'write the merged design here instead of over --to' },
  { name: 'set', desc: 'parameter overrides, comma separated: k=v,k=v' },
  { name: 'net', desc: 'net renames, comma separated: OLD=NEW,OLD=NEW' },
  { name: 'suffix', desc: 'suffix for colliding part ids (default _2)' },
  { name: 'json', desc: 'machine-readable output', hasValue: false }
];

function recipeFiles() {
  if (!fs.existsSync(RECIPE_DIR)) return [];
  return fs.readdirSync(RECIPE_DIR).filter((f) => f.endsWith('.json')).sort();
}

function loadRecipe(name) {
  const file = path.join(RECIPE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    const known = recipeFiles().map((f) => f.replace(/\.json$/, '')).join(', ');
    die(`recipe "${name}" not found (have: ${known})`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, raw, params: Object.assign({}, raw.params || {}) };
}

/** Substitute ${NAME} placeholders from `params`; unchanged if unknown. */
function expand(raw, params) {
  const text = JSON.stringify(raw).replace(/\$\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));
  return JSON.parse(text);
}

function parsePairs(spec, flag) {
  const out = {};
  if (!spec) return out;
  for (const item of String(spec).split(',')) {
    const t = item.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) die(`bad --${flag} item "${t}" (want key=value)`);
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function summarize(name, raw) {
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  return {
    name,
    title: raw.name || name,
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
    const raw = JSON.parse(fs.readFileSync(path.join(RECIPE_DIR, f), 'utf8'));
    return summarize(name, raw);
  });
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`${'recipe'.padEnd(20)} ${'parts'.padStart(5)}  ${'params'.padStart(6)}  blocks`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(20)} ${String(r.parts.length).padStart(5)}  `
      + `${String(Object.keys(r.params).length).padStart(6)}  ${r.blocks.join(' | ')}`);
  }
  console.log(`\n${rows.length} recipes in recipe/`);
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
  const { params: declared, raw } = loadRecipe(opts.recipe);
  const overrides = parsePairs(opts.set, 'set');
  for (const k of Object.keys(overrides)) {
    if (!(k in declared)) {
      console.error(`warning: "${k}" is not a declared param of ${opts.recipe} (declared: ${Object.keys(declared).join(', ') || 'none'})`);
    }
  }
  const params = Object.assign({}, declared, overrides);
  const recipe = expand(raw, params);

  const netRenames = parsePairs(opts.net, 'net');
  if (Object.keys(netRenames).length) {
    for (const p of recipe.parts || []) {
      for (const [pin, net] of Object.entries(p.pins || {})) {
        if (netRenames[net]) p.pins[pin] = netRenames[net];
      }
    }
    for (const [from, to] of Object.entries(netRenames)) {
      recipe.powers = recipe.powers || {};
      if (recipe.powers[from] !== undefined) {
        recipe.powers[to] = recipe.powers[from];
        delete recipe.powers[from];
      }
    }
  }

  const design = JSON.parse(fs.readFileSync(target, 'utf8'));
  design.parts = design.parts || [];
  design.blocks = design.blocks || [];
  design.powers = design.powers || {};

  const taken = new Set(design.parts.map((p) => p.id));
  const suffix = opts.suffix || '_2';
  const rename = new Map();
  for (const p of recipe.parts || []) {
    let id = p.id;
    if (taken.has(id)) {
      let candidate = `${id}${suffix}`;
      let n = 2;
      while (taken.has(candidate)) { n += 1; candidate = `${id}${suffix}${n}`; }
      id = candidate;
    }
    rename.set(p.id, id);
    taken.add(id);
  }

  const addedParts = [];
  for (const p of recipe.parts || []) {
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = rename.get(p.id);
    design.parts.push(copy);
    addedParts.push(copy.id);
  }
  const addedBlocks = [];
  for (const b of recipe.blocks || []) {
    const copy = JSON.parse(JSON.stringify(b));
    copy.parts = (copy.parts || []).map((id) => rename.get(id) || id);
    const clash = design.blocks.find((x) => (x.title || x.name) === (copy.title || copy.name));
    if (clash) {
      clash.parts = (clash.parts || []).concat(copy.parts);
    } else {
      design.blocks.push(copy);
    }
    addedBlocks.push(copy.title || copy.name);
  }
  for (const [net, style] of Object.entries(recipe.powers || {})) {
    if (design.powers[net] && design.powers[net] !== style) {
      console.error(`warning: net "${net}" already declares power "${design.powers[net]}", keeping it`);
      continue;
    }
    design.powers[net] = style;
  }

  const outPath = opts.out ? path.resolve(opts.out) : target;
  fs.writeFileSync(outPath, JSON.stringify(design, null, 2), 'utf8');

  const summary = {
    recipe: opts.recipe,
    params,
    netRenames,
    addedParts,
    addedBlocks,
    written: outPath,
    totalParts: design.parts.length
  };
  if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`merged ${opts.recipe} into ${path.basename(target)} → ${outPath}`);
  console.log(`  parts: +${addedParts.length} (${addedParts.join(', ')}) — ${design.parts.length} total`);
  console.log(`  blocks: ${addedBlocks.join(' | ') || '(none)'}`);
  if (Object.keys(params).length && overrides && Object.keys(overrides).length) {
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
  if (cmd === 'apply') { cmdApply(opts); return; }
  die(`unknown command "${cmd}" (want: list | show | apply)`);
}

main();
