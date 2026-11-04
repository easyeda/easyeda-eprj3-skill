'use strict';
/**
 * select.js — device selection by CLASS + PIN ROLES (typed recipes).
 *
 * A typed recipe says what it needs ("an I2C sensor with VDD/VSS/SDA/SCL"),
 * not which chip to use. 2.x resolves model devices through the EDA client
 * (the local IC cache is gone), so class-based auto-selection needs an explicit
 * device: recipes must pin `ic` (device name) or `lcsc` (Cxxxx). The helpers
 * stay for API compatibility and report that requirement.
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


function loadEntries() {
  // no local cache in 2.x: the system library is read through the EDA client
  // at build time, and a recipe must name the device it wants
  return [];
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
    throw new Error(`class-based device selection is gone in 2.x (no local library cache): pin the device with "ic": "<system-library name>" (or "lcsc": "Cxxxx") for class "${w.class}"`);
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
