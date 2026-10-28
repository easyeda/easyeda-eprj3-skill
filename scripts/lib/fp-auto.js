'use strict';
/**
 * fp-auto.js — parameterised land-pattern generator (pure geometry, zero deps).
 *
 * design.json accepts a footprint as
 *   "footprint": { "auto": "SOP8" }                          — family + pin count
 *   "footprint": { "auto": "LQFP", "pins": 48, "pitch": 19.7 } — explicit knobs
 * instead of hand-writing every pad. Land-pattern numbers carry external
 * evidence (JEDEC / IPC-7351B / real LCSC parts) — see
 * docs/footprint-evidence.md for the per-family table; test/dfm.js asserts the
 * key dimensions so they cannot drift silently.
 *
 * All units are mil. `pitch` = adjacent pad centre spacing. `span` = distance
 * from the part origin to the pad centre row/column.
 */

const PAD_TH = 60;   // through-hole pad copper (square)
const DRILL_STD = 32; // 0.1" header drill

/** Two in-line rows (SOP/SSOP/TSSOP/SOIC). Left column top→bottom = 1..n,
 *  right column bottom→top = n+1..2n (standard CCW numbering). */
function dualRow(pins, { span, pitch, padW, padH, hole }) {
  if (pins % 2) throw new Error(`dual-row footprint needs an even pin count (got ${pins})`);
  const perSide = pins / 2;
  const pads = [];
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round(((i - (perSide - 1) / 2) * pitch) * 100) / 100;
    pads.push([i + 1, -span, y, padW, padH]);
  }
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round((((perSide - 1) / 2) - i) * pitch * 100) / 100;
    pads.push([perSide + i + 1, span, y, padW, padH]);
  }
  return { pads, outline: bboxOutline(pads), hole };
}

/** Four sides (QFN/QFP). CCW from pin 1 at the top of the left edge. */
function quad(pins, { span, pitch, padW, padH }) {
  if (pins % 4) throw new Error(`quad footprint needs a pin count divisible by 4 (got ${pins})`);
  const perSide = pins / 4;
  const half = ((perSide - 1) / 2) * pitch;
  const pads = [];
  let num = 1;
  const yAt = (i) => Math.round((-half + i * pitch) * 100) / 100;
  const xAt = (i) => yAt(i);
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, -span, yAt(i), padH, padW]); // left
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, xAt(i), span, padW, padH]);  // bottom
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, span, yAt(perSide - 1 - i), padH, padW]); // right
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, xAt(perSide - 1 - i), -span, padW, padH]); // top
  return { pads, outline: bboxOutline(pads) };
}

/** Two in-line rows of through-hole pads (DIP). */
function dip(pins, { rowSpan, pitch, hole }) {
  if (pins % 2) throw new Error(`DIP needs an even pin count (got ${pins})`);
  const perSide = pins / 2;
  const pads = [];
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round(((i - (perSide - 1) / 2) * pitch) * 100) / 100;
    pads.push([i + 1, -rowSpan / 2, y, PAD_TH, PAD_TH, hole]);
  }
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round((((perSide - 1) / 2) - i) * pitch * 100) / 100;
    pads.push([perSide + i + 1, rowSpan / 2, y, PAD_TH, PAD_TH, hole]);
  }
  return { pads, outline: bboxOutline(pads, -10) };
}

/** Single row of through-hole pads (pin header). */
function header(pins, { pitch, hole }) {
  const pads = [];
  for (let i = 0; i < pins; i += 1) {
    const y = Math.round(((i - (pins - 1) / 2) * pitch) * 100) / 100;
    pads.push([i + 1, 0, y, PAD_TH, PAD_TH, hole]);
  }
  return { pads, outline: bboxOutline(pads) };
}

/** Double row of through-hole pads. */
function header2r(pins, { pitch, rowGap, hole }) {
  if (pins % 2) throw new Error(`double-row header needs an even pin count (got ${pins})`);
  const perSide = pins / 2;
  const pads = [];
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round(((i - (perSide - 1) / 2) * pitch) * 100) / 100;
    pads.push([i + 1, -rowGap / 2, y, PAD_TH, PAD_TH, hole]);
    pads.push([perSide + i + 1, rowGap / 2, y, PAD_TH, PAD_TH, hole]);
  }
  return { pads, outline: bboxOutline(pads) };
}

/** Footprint outline = pad bounding box, optionally inset (`shrink`). */
function bboxOutline(pads, shrink) {
  const s = shrink || 0;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const p of pads) {
    const w = (p[3] || PAD_TH) / 2 + 15;
    const h = (p[4] || PAD_TH) / 2 + 15;
    x1 = Math.min(x1, p[1] - w);
    x2 = Math.max(x2, p[1] + w);
    y1 = Math.min(y1, p[2] - h);
    y2 = Math.max(y2, p[2] + h);
  }
  return [Math.round(x1 + s), Math.round(y1 + s), Math.round(x2 - s), Math.round(y2 - s)];
}

// Family registry. `pins` fixed → omit from the spec; else required.
// Land-pattern dimensions cite external evidence in docs/footprint-evidence.md
// (JEDEC / IPC-7351B / a real LCSC part); test/dfm.js asserts the key ones so
// they cannot drift silently.
const FAMILIES = {
  // SOT small outline — spans per JEDEC MO-178 / IPC-7351B: SOT-23 (TO-236AB)
  // lead span 2.1–2.5 mm → pad centres ±47 mil; TSOT-23-5/-6 lead span 2.8 mm
  // → ±55 mil. Pad size 24×30 (0.61×0.76 mm), in-row pitch 37 mil (0.95 mm).
  SOT23:   { pins: 3, gen: () => { const pads = [[1, -47, -18.5, 24, 30], [2, -47, 18.5, 24, 30], [3, 47, 0, 24, 30]]; return { pads, outline: bboxOutline(pads) }; }, designator: 'Q' },
  'SOT23-5': { pins: 5, gen: () => { const pads = [[1, -55, -37, 24, 30], [2, -55, 0, 24, 30], [3, -55, 37, 24, 30], [4, 55, -18.5, 24, 30], [5, 55, 18.5, 24, 30]]; return { pads, outline: bboxOutline(pads) }; }, designator: 'U' },
  'SOT23-6': { pins: 6, gen: () => dualRow(6, { span: 55, pitch: 37, padW: 24, padH: 30 }), designator: 'U' },
  SOT223:  { pins: 4, gen: () => ({ pads: [[1, -90, -100, 28, 40], [2, 0, -100, 28, 40], [3, 90, -100, 28, 40], [4, 0, 150, 60, 100]], outline: [-135, -135, 135, 215] }), designator: 'U' },
  // dual-row gull wing — calibrated on SOIC_8P (rs485.json): 24x55 at ±80, pitch 50
  SOP:     { gen: (s) => dualRow(s.pins, { span: s.span || 80, pitch: s.pitch || 50, padW: 24, padH: 55 }), designator: 'U' },
  SSOP:    { gen: (s) => dualRow(s.pins, { span: s.span || 95, pitch: s.pitch || 25.6, padW: 20, padH: 38 }), designator: 'U' },
  TSSOP:   { gen: (s) => dualRow(s.pins, { span: s.span || 120, pitch: s.pitch || 37, padW: 24, padH: 28 }), designator: 'U' },
  // quad no-lead / gull wing — span from body half-width: bodyHalf =
  // perSide·pitch/2 + margin, pad centres sit inside the body edge.
  QFN:     { gen: (s) => { const pitch = s.pitch || 20; const perSide = s.pins / 4;
              const padW = Math.max(9, Math.round(pitch * 0.45)); const padH = Math.round(pitch * 1.35);
              const span = s.span || Math.round((perSide * pitch) / 2 + 20 - padH / 2);
              return quad(s.pins, { span, pitch, padW, padH }); }, designator: 'U' },
  QFP:     { gen: (s) => { const pitch = s.pitch || 19.7; const perSide = s.pins / 4;
              const padW = Math.max(9, Math.round(pitch * 0.55)); const padH = Math.round(pitch * 2.8);
              const span = s.span || Math.round((perSide * pitch) / 2 + 30 - padW / 2);
              return quad(s.pins, { span, pitch, padW, padH }); }, designator: 'U' },
  // through-hole
  DIP:     { gen: (s) => dip(s.pins, { rowSpan: s.rowSpan || 300, pitch: s.pitch || 100, hole: s.hole || DRILL_STD }), designator: 'U' },
  HDR:     { gen: (s) => header(s.pins, { pitch: s.pitch || 100, hole: s.hole || DRILL_STD }), designator: 'J' },
  HDR2R:   { gen: (s) => header2r(s.pins, { pitch: s.pitch || 100, rowGap: s.rowGap || 100, hole: s.hole || DRILL_STD }), designator: 'J' },
  // fixed-shape specials — numbers from recipe/button-debounce.json / crystal.json / usb-c-power.json
  SW_4P:   { pins: 4, gen: () => ({ pads: [[1, -100, -70, 60, 50], [2, -100, 70, 60, 50], [3, 100, -70, 60, 50], [4, 100, 70, 60, 50]], outline: [-140, -100, 140, 100] }), designator: 'SW' },
  XTAL:    { pins: 2, gen: () => ({ pads: [[1, -60, 0, 50, 60], [2, 60, 0, 50, 60]], outline: [-110, -80, 110, 80] }), designator: 'Y' },
  OSC:     { pins: 4, gen: () => ({ pads: [[1, -60, -40, 40, 40], [2, 60, -40, 40, 40], [3, 60, 40, 40, 40], [4, -60, 40, 40, 40]], outline: [-110, -80, 110, 80] }), designator: 'Y' },
  // POWER-ONLY USB-C: VBUS (A4/A9/B4/B9), GND (A1/A12/B1/B12) and CC1/CC2
  // (A5/B5) only — DP/DM/SBU/shield are NOT modelled. Map those pins on a
  // hand-written footprint instead; a pin without a pad fails ERC (E006).
  USB_C:   { pins: 10, gen: () => ({ pads: [['A4', -60, 80, 24, 32], ['A9', -60, 40, 24, 32], ['A5', -60, 0, 24, 32], ['A1', -60, -40, 24, 32], ['A12', -60, -80, 24, 32], ['B4', 60, 80, 24, 32], ['B9', 60, 40, 24, 32], ['B5', 60, 0, 24, 32], ['B1', 60, -40, 24, 32], ['B12', 60, -80, 24, 32]], outline: [-140, -130, 140, 130] }), designator: 'J' }
};

/** Catalogue for docs/CLI: [{name, pins, knobs:[…]}]. */
function catalogue() {
  return Object.entries(FAMILIES).map(([name, f]) => ({
    name,
    pins: f.pins || 'N (even' + (name === 'QFN' || name === 'QFP' ? ', %4' : '') + ')',
    knobs: f.pins
      ? []
      : (name === 'DIP' ? ['pitch', 'rowSpan', 'hole']
        : name.startsWith('HDR') ? ['pitch', name === 'HDR2R' ? 'rowGap' : null, 'hole'].filter(Boolean)
          : ['pins', 'pitch', 'span'])
  }));
}

/**
 * Expand `{auto, ...knobs}` into a buildInlineFootprintEntry spec
 * `{name, designator, pads, outline}`. Non-auto specs pass through untouched.
 */
function expandAuto(spec) {
  if (!spec || typeof spec !== 'object' || !spec.auto) return spec;
  const wanted = String(spec.auto).toUpperCase();
  let familyName = wanted;
  let suffixPins = null;
  if (!FAMILIES[wanted]) {
    // compound names: "SOP8" → family SOP + 8 pins, "HDR2R6" → HDR2R + 6.
    // Longest family name wins so "SOT23-5" is never eaten by "SOT23".
    const names = Object.keys(FAMILIES).sort((a, b) => b.length - a.length);
    for (const n of names) {
      if (wanted.startsWith(n) && /^\d+$/.test(wanted.slice(n.length))) {
        familyName = n;
        suffixPins = Number(wanted.slice(n.length));
        break;
      }
    }
  }
  const family = FAMILIES[familyName];
  if (!family) {
    throw new Error(`unknown auto footprint "${spec.auto}" (families: ${Object.keys(FAMILIES).join(', ')})`);
  }
  const s = Object.assign({}, spec);
  if (family.pins !== undefined) s.pins = family.pins;
  else if (suffixPins && !s.pins) s.pins = suffixPins;
  if (!s.pins) throw new Error(`auto footprint "${spec.auto}" needs "pins"`);
  if (familyName === 'QFN' || familyName === 'QFP') {
    if (s.pins % 4) throw new Error(`${familyName} pin count must be divisible by 4 (got ${s.pins})`);
  } else if (['SOP', 'SSOP', 'TSSOP', 'DIP', 'HDR2R'].includes(familyName)) {
    if (s.pins % 2) throw new Error(`${familyName} pin count must be even (got ${s.pins})`);
  } else if (familyName === 'HDR' && s.pins < 2) {
    throw new Error('HDR needs at least 2 pins');
  }
  const { pads, outline, hole } = family.gen(s);
  const outPads = pads.map((p) => (hole && p.length === 5 ? p.concat(hole) : p));
  return {
    name: spec.name || wanted,
    designator: spec.designator || family.designator || 'U',
    pads: outPads,
    outline
  };
}

// LQFP is the everyday name for a fine-pitch QFP body.
FAMILIES.LQFP = FAMILIES.QFP;

module.exports = { FAMILIES, expandAuto, catalogue };
