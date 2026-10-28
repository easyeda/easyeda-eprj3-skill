'use strict';
/**
 * merge.js — the one recipe-merging engine.
 *
 * `recipe.js apply` (a human picking one block) and `intake.js resolve` (a
 * requirement mapped onto several blocks) need the exact same rules: how `${}`
 * params are substituted, how colliding part ids are renamed, how net renames
 * propagate, how blocks merge. Keeping it here means a recipe can never merge
 * differently depending on who asked.
 *
 * Everything is plain JSON manipulation — no template engine, no dependency.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { die } = require('./utils');

const ROOT = path.resolve(__dirname, '..', '..');
const RECIPE_DIR = path.join(ROOT, 'recipe');

function recipeFiles() {
  if (!fs.existsSync(RECIPE_DIR)) return [];
  return fs.readdirSync(RECIPE_DIR).filter((f) => f.endsWith('.json')).sort();
}

function recipeNames() {
  return recipeFiles().map((f) => f.replace(/\.json$/, ''));
}

function loadRecipe(name) {
  const file = path.join(RECIPE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    die(`recipe "${name}" not found (have: ${recipeNames().join(', ')})`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, raw, params: Object.assign({}, raw.params || {}) };
}

/** Substitute ${NAME} placeholders from `params`; unknown placeholders stay. */
function expand(raw, params) {
  const text = JSON.stringify(raw).replace(/\$\{(\w+)\}/g,
    (m, k) => (params[k] === undefined ? m : String(params[k])));
  return JSON.parse(text);
}

/** "k=v,k=v" → {k: v}. Used for --set (params) and --net (renames). */
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

function ensureShape(design) {
  const d = design;
  d.parts = d.parts || [];
  d.blocks = d.blocks || [];
  d.powers = d.powers || {};
  d.nets = d.nets || {};
  return d;
}

/**
 * Merge one (already expanded + net-renamed) recipe design into a target
 * design. Mutates a deep copy and returns the summary.
 *
 * @param design  target design.json object (not mutated)
 * @param recipe  expanded recipe ({parts, blocks, powers, nets, expect})
 * @param opts    {suffix, params, netRenames, powersFromRecipe}
 */
function merge(design, recipe, opts) {
  const o = opts || {};
  const out = ensureShape(JSON.parse(JSON.stringify(design)));
  const suffix = o.suffix || '_2';
  const taken = new Set(out.parts.map((p) => p.id));
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
    out.parts.push(copy);
    addedParts.push(copy.id);
  }
  const addedBlocks = [];
  for (const b of recipe.blocks || []) {
    const copy = JSON.parse(JSON.stringify(b));
    copy.parts = (copy.parts || []).map((id) => rename.get(id) || id);
    const clash = out.blocks.find((x) => (x.title || x.name) === (copy.title || copy.name));
    if (clash) clash.parts = (clash.parts || []).concat(copy.parts);
    else out.blocks.push(copy);
    addedBlocks.push(copy.title || copy.name || '(untitled)');
  }
  for (const [net, style] of Object.entries(recipe.powers || {})) {
    if (out.powers[net] && out.powers[net] !== style) {
      if (o.onPowerConflict) o.onPowerConflict(net, out.powers[net], style);
      continue;
    }
    out.powers[net] = style;
  }
  for (const [net, knobs] of Object.entries(recipe.nets || {})) {
    if (out.nets[net] === undefined) out.nets[net] = knobs;
  }
  // Recipe intent (expect block) is additive: merge arrays, keep flags.
  if (recipe.expect) {
    const e = out.expect || {};
    for (const k of ['decoupling']) if (recipe.expect[k]) e[k] = true;
    for (const k of ['pairs', 'valueRange', 'divider']) {
      if (Array.isArray(recipe.expect[k])) e[k] = (e[k] || []).concat(recipe.expect[k]);
    }
    out.expect = e;
  }
  return {
    design: out,
    summary: {
      params: o.params || {},
      netRenames: o.netRenames || {},
      renames: Object.fromEntries(rename),
      addedParts,
      addedBlocks,
      totalParts: out.parts.length
    }
  };
}

/** Rename nets inside a recipe design BEFORE merging (parts + powers). */
function renameNets(recipe, netRenames) {
  const r = recipe;
  const pairs = Object.entries(netRenames || {}).filter(([from, to]) => from !== to);
  if (!pairs.length) return r;
  for (const p of r.parts || []) {
    for (const [pin, net] of Object.entries(p.pins || {})) {
      const hit = pairs.find(([from]) => from === net);
      if (hit) p.pins[pin] = hit[1];
    }
  }
  r.powers = r.powers || {};
  for (const [from, to] of pairs) {
    if (r.powers[from] !== undefined) {
      const style = r.powers[from];
      delete r.powers[from];
      r.powers[to] = style;
    }
  }
  return r;
}

/** Load + expand + net-rename a recipe by name, ready to merge. */
function recipeSignature(name) {
  // content fingerprint of a recipe file — the intake cache keys on it, so
  // an edited recipe invalidates stale cached resolves
  try {
    const file = path.join(RECIPE_DIR, name + '.json');
    return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex').slice(0, 12);
  } catch { return 'none'; }
}

function resolveRecipe(name, overrides, netRenames) {
  const { raw, params: declared } = loadRecipe(name);
  const unknown = Object.keys(overrides || {}).filter((k) => !(k in declared));
  const params = Object.assign({}, declared, overrides || {});
  const expanded = expand(raw, params);
  return { raw, declared, params, unknown, recipe: renameNets(expanded, netRenames || {}) };
}

module.exports = {
  ROOT, RECIPE_DIR, recipeFiles, recipeNames, loadRecipe, expand, parsePairs,
  merge, renameNets, resolveRecipe, ensureShape, recipeSignature
};
