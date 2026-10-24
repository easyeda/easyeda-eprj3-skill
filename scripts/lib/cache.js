'use strict';
/**
 * cache.js — a tiny JSON disk cache for selection results.
 *
 * The point is token economy: deriving "these requirements → these recipes with
 * these params" is a table walk, but repeating it for every revision of the
 * same request still costs the agent a round trip through recipe.js/merge.js.
 * A stable-key cache means the second identical ask is one file read.
 *
 * Deliberately dumb and self-contained: one JSON file per namespace under
 * `.cache/`, keyed by sha256, storing {key, value, tag, at}. No TTL/eviction
 * cleverness — `clear()` wipes the namespace. Values must be JSON-serialisable.
 *
 * Cache misses are ALWAYS safe: nothing in the pipeline requires a hit, so a
 * deleted `.cache/` directory changes speed, never output.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache');

function keyOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
}

function fileFor(ns) {
  if (!/^[a-z0-9-]+$/i.test(ns)) throw new Error(`bad cache namespace "${ns}"`);
  return path.join(CACHE_DIR, `${ns}.json`);
}

function open(ns) {
  const file = fileFor(ns);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { data = {}; }

  return {
    file,
    ns,
    get count() { return Object.keys(data).length; },
    get(keyText) {
      const k = keyOf(keyText);
      return data[k] ? { key: k, value: data[k].value, tag: data[k].tag, at: data[k].at } : null;
    },
    set(keyText, value, tag) {
      const k = keyOf(keyText);
      data[k] = { value, tag: tag || null, at: new Date().toISOString() };
      return k;
    },
    /** Persist. Safe to call repeatedly; writes are atomic (tmp + rename). */
    save() {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return file;
    },
    /** Drop the namespace entirely (used by tests and `intake.js --no-cache`). */
    clear() {
      data = {};
      try { fs.rmSync(file, { force: true }); } catch { /* nothing cached yet */ }
      return true;
    },
    entries() {
      return Object.entries(data).map(([k, v]) => ({ key: k, tag: v.tag, at: v.at }));
    }
  };
}

module.exports = { open, keyOf, CACHE_DIR, ROOT };
