'use strict';
/**
 * intent.js — the fifth gate: does the DESIGN match its stated intent?
 *
 * The other gates prove the files agree with design.json (E003) and the copper
 * obeys the rules (DRC). Neither can catch an intent mistake IN design.json
 * itself: an LED whose anode lands on ground, a divider wired backwards, a
 * supply rail with no decoupling. This gate checks the design against what it
 * DECLARES about itself:
 *
 *   "parts[].polarity": { "1": "+", "2": "-" }   — pin polarity marks
 *   "expect": {
 *     "decoupling": true,                         — every supply net gets a cap to ground
 *     "pairs": [["USB_DP", "USB_DM"]],            — differential pairs must exist with equal pin counts
 *     "valueRange": [{ "ref": "R1", "min": "100R", "max": "1k" }],
 *     "divider": [{ "input": "VIN", "output": "FB", "top": "R1", "bottom": "R2", "ratio": 0.55, "tol": 0.05 }]
 *   }
 *
 * Everything here is computable from the design alone — E003 already proves
 * the built netlist matches it.
 */

const G = require('./geom');

const I_RULES = {
  I001: { level: 'error', weight: 15, text: 'polarized part wired backwards' },
  I002: { level: 'error', weight: 10, text: 'supply net without a decoupling capacitor' },
  I003: { level: 'error', weight: 8, text: 'declared pair missing or unbalanced' },
  I004: { level: 'error', weight: 8, text: 'part value outside its declared range' },
  I005: { level: 'error', weight: 10, text: 'divider wiring or ratio wrong' },
  I006: { level: 'warn', weight: 2, text: 'declared pair is not routed as a pair' },
  I007: { level: 'error', weight: 12, text: 'real-chip pin definitions hand-authored without a source' }
};

/** "10k" → 10000, "330R" → 330, "100nF" → 1e-7, "4.7uF" → 4.7e-6, "1MΩ" → 1e6. */
function parseValue(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(p|n|u|U|μ|µ|k|K|M|m|R|r|G|g)?\s*(F|f|H|h|Ω|ohm|OHM)?$/.exec(String(v).trim());
  if (!m) return null;
  const num = Number(m[1]);
  const pfx = m[2] || '';
  const unit = (m[3] || '').toLowerCase();
  if (unit === 'f' || unit === 'h') {
    // capacitance / inductance: m is milli here
    const scale = { p: 1e-12, n: 1e-9, u: 1e-6, U: 1e-6, 'μ': 1e-6, 'µ': 1e-6, m: 1e-3, '': 1 };
    return num * (scale[pfx] !== undefined ? scale[pfx] : 1);
  }
  // resistance or plain number: R=1, k=1e3, M=1e6, G=1e9
  const scale = { '': 1, R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, g: 1e9 };
  return num * (scale[pfx] !== undefined ? scale[pfx] : 1);
}

/**
 * @param d   normalized design (design.js normalize output)
 * @returns {errors, warnings, checks:[{id,text}]} — checks are the rules that ran
 */
function runIntent(d, opts) {
  const placedOnly = !!(opts && opts.placedOnly);
  const errors = [];
  const warnings = [];
  const checks = [];
  const add = (code, msg, extra) => errors.push(Object.assign({
    id: code, level: I_RULES[code].level, msg, rule: I_RULES[code].text
  }, extra || {}));
  const addW = (code, msg, extra) => warnings.push(Object.assign({
    id: code, level: 'warn', msg, rule: I_RULES[code].text
  }, extra || {}));

  const expect = d.expect || {};
  const byId = new Map(d.parts.map((p) => [p.id, p]));
  const downNets = new Set([...d.powerNets.entries()].filter(([, v]) => v === 'down').map(([n]) => n));
  const upNets = new Set([...d.powerNets.entries()].filter(([, v]) => v === 'up').map(([n]) => n));

  // ---- polarity: what a polarity mark can prove about a 2-pin part.
  //   "+" (anode) on a ground net → reversed, UNLESS the part declares role
  //     "shunt" (a TVS/clamp legitimately puts its anode on ground). With the
  //     anode at ground the part never conducts from any positive net — this
  //     is the reversed-LED / reversed-electrolytic killer.
  //   A cathode on ground is NOT an error: that is the standard low-side LED,
  //   the electrolytic's "-" and a signal clamp. "- on a supply" is fine too
  //   (flyback diode clamping a rail, series diode into the downstream rail).
  //   Rails-to-rails orientation is undecidable from nets alone → not judged.
  let polChecked = 0;
  for (const p of d.parts) {
    if (!p.polarity) continue;
    polChecked += 1;
    const shunt = p.role === 'shunt';
    for (const [pin, mark] of Object.entries(p.polarity)) {
      const net = p.pins[pin];
      if (!net) continue;
      if (mark === '+' && downNets.has(net) && !shunt) {
        add('I001', `part ${p.id}: pin ${pin} is marked "+" but sits on ground net "${net}" — reverse it (if this is a TVS/clamp, declare "role": "shunt" instead)`, {
          ref: p.id, pin, fix: `swap the two pins in parts[].pins of ${p.id}, or add "role": "shunt" if the anode belongs on ground, then re-run build.js --force`
        });
      }
    }
  }
  if (polChecked) checks.push({ id: 'polarity', parts: polChecked });

  // ---- I007: pin definitions of real devices must not be hand-invented.
  // A multi-pin inline symbol whose value looks like a manufacturer part
  // number (or whose pin names carry GPIO-style port names) needs a declared
  // source: an "ic" entry (official-library evidence) or a "pinoutSource"
  // note (datasheet/官方库出处) added AFTER checking the datasheet. Generic
  // stand-ins stay legal by declaring what they are.
  const GPIOish = /(GPIO|P[ABCDEF][0-9]+)/i;
  const mpnLike = (v) => /^[A-Z]{1,5}[-]?[0-9][0-9A-Z\-]*$/i.test(String(v || '').trim());
  let pinoutsChecked = 0;
  for (const p of d.parts) {
    if (!p.symbol || typeof p.symbol !== 'object' || !Array.isArray(p.symbol.pins)) continue;
    if (p.ic || p.pinoutSource) continue;
    if (p.symbol.pins.length < 8) continue;
    const names = p.symbol.pins.map((s) => (typeof s === 'string' ? (s.split(':')[1] || '') : (s.name || '')));
    const gpioNames = names.some((n) => GPIOish.test(n));
    if (!gpioNames && !mpnLike(p.value)) continue;
    pinoutsChecked += 1;
    add('I007', `part ${p.id}: ${p.symbol.pins.length}-pin inline symbol${p.value ? ` ("${p.value}")` : ''} looks like a real device — its pin definitions must not be invented`, {
      ref: p.id,
      fix: `use an "ic" entry (official-library evidence), or verify the pinout against the datasheet and declare "pinoutSource": "<datasheet URL / 出处>" on the part; for a generic stand-in set "pinoutSource": "通用示例符号（非特定型号）"`
    });
  }
  if (pinoutsChecked) checks.push({ id: 'pinoutSource', parts: pinoutsChecked });

  // ---- decoupling: every supply net needs a capacitor to a ground net.
  if (expect.decoupling) {
    checks.push({ id: 'decoupling' });
    for (const net of upNets) {
      const hasCap = d.parts.some((p) => /^C/i.test(p.id)
        && Object.values(p.pins).includes(net)
        && [...downNets].some((g) => Object.values(p.pins).includes(g)));
      if (!hasCap) {
        add('I002', `supply net "${net}" has no decoupling capacitor to ground`, {
          net,
          fix: `add a 100nF capacitor from "${net}" to ground — or run: node scripts/autofix.js --design <file>`
        });
      }
    }
  }

  // ---- pairs: both nets must exist with the same pin count.
  for (const pair of expect.pairs || []) {
    checks.push({ id: 'pair', nets: pair });
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [a, b] = pair;
    const pinsOf = (net) => d.parts.flatMap((p) => Object.entries(p.pins)
      .filter(([, n]) => n === net).map(([num]) => `${p.id}.${num}`));
    const pa = pinsOf(a);
    const pb = pinsOf(b);
    if (!pa.length || !pb.length) {
      add('I003', `declared pair [${a}, ${b}]: ${!pa.length ? `"${a}" is unused` : `"${b}" is unused`}`, {
        fix: `check the net names in parts[].pins — a pair member with no pins is a typo`
      });
    } else if (pa.length !== pb.length) {
      add('I003', `declared pair [${a}, ${b}] is unbalanced: ${pa.length} pin(s) vs ${pb.length} pin(s)`, {
        fix: `a differential pair needs the same pin count on both sides — check parts[].pins`
      });
    } else if (!placedOnly) {
      // placed-only boards route pairs by hand in the client — the warning is
      // permanent there and carries no information (report: mimo §7.7)
      addW('I006', `pair [${a}, ${b}] declared — finish the pair side by side in the client`, {
        fix: `informational: keep the two nets side by side manually with pcb.place if length matching matters`
      });
    }
  }

  // ---- valueRange: parse the declared min/max and the part's own value.
  for (const r of expect.valueRange || []) {
    checks.push({ id: 'valueRange', ref: r.ref });
    const p = byId.get(r.ref);
    if (!p) {
      add('I004', `valueRange references unknown part "${r.ref}"`);
      continue;
    }
    const v = p.value === null ? null : parseValue(p.value);
    const lo = r.min !== undefined ? parseValue(r.min) : null;
    const hi = r.max !== undefined ? parseValue(r.max) : null;
    if (v === null) {
      addW('I004', `part ${p.id}: value "${p.value}" is not parseable as a number (expected like 330R / 10k / 100nF)`, {
        ref: p.id, fix: `write the value in engineering notation, e.g. "4k7" or "10k"`
      });
      continue;
    }
    if ((lo !== null && v < lo) || (hi !== null && v > hi)) {
      add('I004', `part ${p.id}: value ${p.value} is outside the declared range [${r.min} .. ${r.max}]`, {
        ref: p.id,
        fix: `pick a value inside [${r.min} .. ${r.max}] for ${p.id} in the design`
      });
    }
  }

  // ---- divider: wiring first, then the ratio from the actual values.
  for (const dv of expect.divider || []) {
    checks.push({ id: 'divider', output: dv.output });
    const top = byId.get(dv.top);
    const bottom = byId.get(dv.bottom);
    const pinsOn = (p, net) => p && Object.values(p.pins).includes(net);
    if (!top || !bottom) {
      add('I005', `divider references unknown part "${!top ? dv.top : dv.bottom}"`);
      continue;
    }
    if (!pinsOn(top, dv.input) || !pinsOn(top, dv.output)) {
      add('I005', `divider top ${dv.top} must sit between "${dv.input}" and "${dv.output}"`, {
        fix: `wire ${dv.top} pin 1 to "${dv.input}" and pin 2 to "${dv.output}" in parts[].pins`
      });
    }
    if (!pinsOn(bottom, dv.output) || !(pinsOn(bottom, [...downNets][0]) || [...downNets].some((g) => pinsOn(bottom, g)))) {
      add('I005', `divider bottom ${dv.bottom} must sit between "${dv.output}" and ground`, {
        fix: `wire ${dv.bottom} pin 1 to "${dv.output}" and pin 2 to a ground net in parts[].pins`
      });
    }
    const rt = parseValue(top.value);
    const rb = parseValue(bottom.value);
    if (rt !== null && rb !== null && rt > 0) {
      const ratio = rb / (rt + rb);
      const tol = dv.tol === undefined ? 0.05 : dv.tol;
      if (Math.abs(ratio - dv.ratio) > tol) {
        add('I005', `divider ratio ${ratio.toFixed(3)} is outside ${dv.ratio}±${tol} (${dv.top}=${top.value}, ${dv.bottom}=${bottom.value})`, {
          fix: `recompute the resistor pair: ratio = bottom/(top+bottom) — aim for ${dv.ratio}`
        });
      }
    }
  }

  return {
    errors,
    warnings,
    checks,
    stats: { rules: Object.keys(I_RULES).length, ran: checks.length }
  };
}

module.exports = { runIntent, parseValue, I_RULES };
void G;
