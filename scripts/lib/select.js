'use strict';
/**
 * select.js — device selection by CLASS + PIN ROLES (typed recipes).
 *
 * A typed recipe says what it needs ("an I2C sensor with VDD/VSS/SDA/SCL"),
 * not which chip to use. This module answers that question from the IC
 * cache: every cached IC entry (see lib/icdirs.js) may declare
 *
 *   "class": "sensor.i2c",
 *   "pinRoles": { "VDD": "5", "VSS": "8", "SDA": "1", "SCL": "4" },   // pin(s)
 *   "requiredRoles": ["VDD", "VSS", "SDA", "SCL"]
 *
 * Roles are derived from the OFFICIAL pin names shipped in the entry, so a
 * selection never invents a pinout — it only says which real part fits.
 *
 *   listDevices({ class })            → [{name, class, roles, requiredRoles}]
 *   bindDevice({ class, roles, prefer }) → { name, binding, missing, candidates }
 *   deviceNames()                     → every library entry that has a class
 */
const fs = require('fs');
const path = require('path');

const I = require('./icdirs');

function loadEntries() {
  // model-specific entries live in the local cache (fetch-lcsc), never in the
  // shipped templates — see icdirs.js for the search order
  return I.icFiles(null)
    .map((f) => {
      try { return JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

function rolesOf(entry) { return entry.pinRoles ? Object.keys(entry.pinRoles) : []; }

function listDevices(opts) {
  const o = opts || {};
  return loadEntries()
    .filter((e) => e.class)
    .filter((e) => !o.class || e.class === o.class || e.class.startsWith(`${o.class}.`))
    .map((e) => ({
      name: e.name,
      class: e.class,
      roles: rolesOf(e),
      requiredRoles: e.requiredRoles || []
    }));
}

function deviceNames() { return loadEntries().filter((e) => e.class).map((e) => e.name); }

/**
 * Pick the best entry for a class + role set.
 * @param {{class:string, roles?:string[], prefer?:string}} want
 * @returns {{name, entry, binding, missing, candidates}}
 *   binding: role → net is filled by the caller (recipe ports); here we only
 *   return the pin(s) per role so the caller can expand pins.
 */
function bindDevice(want) {
  const w = want || {};
  if (!w.class) throw new Error('bindDevice needs a "class"');
  const wanted = w.roles || [];
  const all = listDevices({ class: w.class });
  if (!all.length) {
    throw new Error(`no device in the library has class "${w.class}" — add one with fetch-lcsc --class or curate an entry`);
  }
  const scored = all.map((d) => {
    const missing = wanted.filter((r) => !d.roles.includes(r));
    return { d, missing, score: missing.length * 10 + (d.roles.length - wanted.length) * 0.1 };
  }).sort((a, b) => a.score - b.score);

  if (w.prefer) {
    const hit = scored.find((s) => s.d.name === w.prefer);
    if (!hit) {
      throw new Error(`preferred device "${w.prefer}" is not in class "${w.class}" (known: ${scored.map((s) => s.d.name).join(', ')})`);
    }
    if (hit.missing.length) {
      throw new Error(`preferred device "${w.prefer}" lacks role(s) ${hit.missing.join(', ')} (has: ${hit.d.roles.join(', ')})`);
    }
    return { name: hit.d.name, candidates: scored.map((s) => `${s.d.name}${s.missing.length ? ` (缺 ${s.missing.join(',')})` : ''}`), missing: [], binding: hit.d };
  }

  const best = scored[0];
  if (best.missing.length) {
    // never guess: report exactly which capability is missing
    throw new Error(`no device in class "${w.class}" provides role(s) ${best.missing.join(', ')} — candidates: ${scored.map((s) => `${s.d.name} (缺 ${s.missing.join(',') || '无'})`).join('; ')}`);
  }
  return { name: best.d.name, candidates: scored.map((s) => s.d.name), missing: [], binding: best.d };
}

module.exports = { listDevices, deviceNames, bindDevice };
