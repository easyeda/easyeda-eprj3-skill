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

/** Two in-line rows (SOP/SSOP/TSSOP/SOT23-6). Left column TOP→bottom = 1..n,
 *  right column bottom→top = n+1..2n — the official-library orientation
 *  (EasyEDA SOIC-8 C7950: pin 1 top-left). */
function dualRow(pins, { span, pitch, padW, padH, hole }) {
  if (pins % 2) throw new Error(`dual-row footprint needs an even pin count (got ${pins})`);
  const perSide = pins / 2;
  const pads = [];
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round((((perSide - 1) / 2) - i) * pitch * 100) / 100;
    pads.push([i + 1, -span, y, padW, padH]);
  }
  for (let i = 0; i < perSide; i += 1) {
    const y = Math.round(((i - (perSide - 1) / 2) * pitch) * 100) / 100;
    pads.push([perSide + i + 1, span, y, padW, padH]);
  }
  return { pads, outline: bboxOutline(pads), hole };
}

/** Four sides (QFN/QFP). Per the official QFN-24 sample (MPU-6050, LCSC
 *  C24112): bottom row left→right = 1..n, right column bottom→top, top row
 *  right→left, left column bottom→top. Exact real parts (IC pinout entries)
 *  ship verbatim official pads instead — package conventions differ per part. */
function quad(pins, { span, pitch, padW, padH }) {
  if (pins % 4) throw new Error(`quad footprint needs a pin count divisible by 4 (got ${pins})`);
  const perSide = pins / 4;
  const half = ((perSide - 1) / 2) * pitch;
  const pads = [];
  let num = 1;
  const yAt = (i) => Math.round((-half + i * pitch) * 100) / 100;
  const xAt = (i) => yAt(i);
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, xAt(i), -span, padW, padH]);            // bottom l→r
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, span, yAt(i), padH, padW]);             // right b→t
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, xAt(perSide - 1 - i), span, padW, padH]); // top r→l
  for (let i = 0; i < perSide; i += 1, num += 1) pads.push([num, -span, yAt(i), padH, padW]);            // left b→t
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
// Land-pattern dimensions are calibrated against the **EasyEDA 官方库**
// (LCSC parts fetched from easyeda.com/api/products/{LCSC}/components) and
// JEDEC/IPC-7351B where no official sample is fetched yet. The per-family
// table with part ids lives in docs/footprint-evidence.md; test/dfm.js
// asserts the key numbers so they cannot drift silently.
const FAMILIES = {
  // SOT-23 — official MMBT5551 (C2145): pads 1.0×0.65 mm at x=±1.0 mm,
  // pin pitch 1.9 mm (P1.90 in the official package name — the two same-side
  // leads sit 1.9 mm apart, NOT 0.95). Pads 1/2 left, pad 3 right.
  SOT23:   { pins: 3, gen: () => { const pads = [[1, -39.4, 37.4, 39.4, 25.6], [2, -39.4, -37.4, 39.4, 25.6], [3, 39.4, 0, 39.4, 25.6]]; return { pads, outline: bboxOutline(pads) }; }, designator: 'Q' },
  // TSOT-23-5 — official ME6211C33 (C82942, P0.95-LS2.8): pads 1.16×0.46 mm,
  // in-column pitch 0.95 mm, row centres ±45.4; right column aligns with rows
  // 1 and 3 (pad4↔pad3, pad5↔pad1).
  'SOT23-5': { pins: 5, gen: () => { const pads = [[1, -45.4, 37.4, 45.6, 19.3], [2, -45.4, 0, 45.6, 19.3], [3, -45.4, -37.4, 45.6, 19.3], [4, 45.4, -37.4, 45.6, 19.3], [5, 45.4, 37.4, 45.6, 19.3]]; return { pads, outline: bboxOutline(pads) }; }, designator: 'U' },
  // TSOT-23-6 — same body class as SOT23-5 (no separate official sample yet).
  'SOT23-6': { pins: 6, gen: () => dualRow(6, { span: 45.4, pitch: 37.4, padW: 45.6, padH: 19.3 }), designator: 'U' },
  // SOT-223 — official AMS1117-3.3 (C6186, P2.30-LS7.0): inline row pads
  // 1.1×2.5 mm at 2.3 mm pitch, row centre ±2.97 mm; tab 3.6×2.34 mm on the
  // opposite side (official tab is pad "4" — an IC entry may re-number it).
  SOT223:  { pins: 4, gen: () => { const pads = [[1, -90.5, -116.9, 43.3, 98.4], [2, 0, -116.9, 43.3, 98.4], [3, 90.5, -116.9, 43.3, 98.4], [4, 0, 116.9, 141.7, 92.1]]; return { pads, outline: bboxOutline(pads) }; }, designator: 'U' },
  // Dual-row gull wing — official LM358DR (C7950, SOIC-8 P1.27-LS6.0): pads
  // 1.95 mm radial × 0.56 mm tangential, row centres ±2.7 mm, pitch 1.27 mm.
  // (The pre-1.15 numbers had the axes swapped and pads overlapping.)
  SOP:     { gen: (s) => dualRow(s.pins, { span: s.span || 106.5, pitch: s.pitch || 50, padW: 76.8, padH: 22.4 }), designator: 'U' },
  // SSOP — IPC-7351B derivation, official sample not fetched yet.
  SSOP:    { gen: (s) => dualRow(s.pins, { span: s.span || 130, pitch: s.pitch || 25.6, padW: 38, padH: 12 }), designator: 'U' },
  // TSSOP — IPC-7351B derivation (0.65 mm pitch class), official sample not
  // fetched yet.
  TSSOP:   { gen: (s) => dualRow(s.pins, { span: s.span || 112.7, pitch: s.pitch || 25.6, padW: 58, padH: 16 }), designator: 'U' },
  // DFN / LGA (report P4: sensors such as SHT30 / BMP280 only had hand-written
  // pads). Dual-row no-lead class, IPC-7351B-derived: radial pad 1.1×pitch,
  // tangential 0.5×pitch, pad centres = pin-span half + 1.3×pitch. No
  // thermal pad modelled — a package that needs one wants an inline
  // footprint. **Derivation, official sample pending** (footprint-evidence.md).
  DFN:     { gen: (s) => { const pitch = s.pitch || 25.6; const perSide = s.pins / 2;
              const padW = Math.max(9, Math.round(pitch * 1.1)); const padH = Math.max(9, Math.round(pitch * 0.5));
              const span = s.span || Math.round(((perSide - 1) * pitch) / 2 + pitch * 1.3);
              return dualRow(s.pins, { span, pitch, padW, padH }); }, designator: 'U' },
  LGA:     { gen: (s) => { const pitch = s.pitch || 25.6; const perSide = s.pins / 2;
              const padW = Math.max(10, Math.round(pitch * 0.8)); const padH = padW;
              const span = s.span || Math.round(((perSide - 1) * pitch) / 2 + pitch * 1.2);
              return dualRow(s.pins, { span, pitch, padW, padH }); }, designator: 'U' },
  // QFN — official MPU-6050 (C24112, QFN-24 4×4 0.5 mm): pads 0.8 mm radial ×
  // 0.28 mm tangential at ±2.0 mm → radial 1.6×pitch, centres = pin-span
  // half + 0.75 mm. **Thermal pad NOT modelled** — hand-write an inline
  // footprint (with the EP pad) for QFNs that need it.
  QFN:     { gen: (s) => { const pitch = s.pitch || 19.7; const perSide = s.pins / 4;
              const padW = Math.max(9, Math.round(pitch * 0.56)); const padH = Math.round(pitch * 1.6);
              const span = s.span || Math.round((perSide * pitch) / 2 - pitch / 2 + 29.5);
              return quad(s.pins, { span, pitch, padW, padH }); }, designator: 'U' },
  // LQFP — official STM32F103C8T6 (C8734, LQFP-48 7×7 0.5 mm): pads 0.27 mm
  // tangential × 1.5 mm radial at ±4.23 mm, pitch 0.5 mm → radial 3×pitch,
  // centres = pin-span half + 1.5 mm (gull-wing lead protrusion). Exact for
  // LQFP-48; other body sizes want an explicit `span` knob.
  QFP:     { gen: (s) => { const pitch = s.pitch || 19.7; const perSide = s.pins / 4;
              const padW = Math.max(9, Math.round(pitch * 0.54)); const padH = Math.round(pitch * 3);
              const span = s.span || Math.round(((perSide - 1) * pitch) / 2 + 59.1);
              return quad(s.pins, { span, pitch, padW, padH }); }, designator: 'U' },
  // through-hole
  DIP:     { gen: (s) => dip(s.pins, { rowSpan: s.rowSpan || 300, pitch: s.pitch || 100, hole: s.hole || DRILL_STD }), designator: 'U' },
  HDR:     { gen: (s) => header(s.pins, { pitch: s.pitch || 100, hole: s.hole || DRILL_STD }), designator: 'J' },
  HDR2R:   { gen: (s) => header2r(s.pins, { pitch: s.pitch || 100, rowGap: s.rowGap || 100, hole: s.hole || DRILL_STD }), designator: 'J' },
  // fixed-shape specials — numbers from recipe/button-debounce.json / crystal.json / usb-c-power.json
  SW_4P:   { pins: 4, gen: () => ({ pads: [[1, -100, -70, 60, 50], [2, -100, 70, 60, 50], [3, 100, -70, 60, 50], [4, 100, 70, 60, 50]], outline: [-140, -100, 140, 100] }), designator: 'SW' },
  XTAL:    { pins: 2, gen: () => ({ pads: [[1, -60, 0, 50, 60], [2, 60, 0, 50, 60]], outline: [-110, -80, 110, 80] }), designator: 'Y' },
  OSC:     { pins: 4, gen: () => ({ pads: [[1, -60, -40, 40, 40], [2, 60, -40, 40, 40], [3, 60, 40, 40, 40], [4, -60, 40, 40, 40]], outline: [-110, -80, 110, 80] }), designator: 'Y' },
  // USB-C — official TYPE-C-31-M-12 (C165948): POWER-ONLY subset at the
  // official merged-pad positions (A1B12/A4B9 = merged GND/VBUS across both
  // rows; A5/B5 = CC). DP/DM/SBU/shell are NOT modelled — a pin mapped
  // without a pad fails ERC (E006); use a hand-written inline footprint for
  // full-featured USB-C.
  USB_C:   { pins: 6, gen: () => ({ pads: [['A1B12', -126, -97.4, 23.6, 51.2], ['A4B9', -94.5, -97.4, 23.6, 51.2], ['A5', -49.2, -97.4, 11.8, 51.2], ['B5', 68.9, -97.4, 11.8, 51.2], ['B4A9', 94.5, -97.4, 23.6, 51.2], ['B1A12', 126, -97.4, 23.6, 51.2]], outline: [-194, -123, 194, 123] }), designator: 'J' }
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
  } else if (['SOP', 'SSOP', 'TSSOP', 'DIP', 'HDR2R', 'DFN', 'LGA'].includes(familyName)) {
    if (s.pins % 2) throw new Error(`${familyName} pin count must be even (got ${s.pins})`);
  } else if (familyName === 'HDR' && s.pins < 2) {
    throw new Error('HDR needs at least 2 pins');
  }
  const { pads, outline, hole } = family.gen(s);
  const outPads = pads.map((p) => (hole && p.length === 5 ? p.concat(hole) : p));
  // A bare family token ("QFN", "SOP8") is not a package name a library can be
  // read from: derive the descriptive form from the real geometry, like the
  // official names (`QFN-24_L6.1-W6.1-P0.50`). An author-supplied datasheet
  // name (it carries the `_` separators) is kept verbatim.
  const given = spec.name;
  const keepGiven = typeof given === 'string' && given.includes('_');
  return {
    name: keepGiven ? given : describePackage(familyName, outPads, outline),
    designator: spec.designator || family.designator || 'U',
    pads: outPads,
    outline
  };
}

const MIL_MM = 25.4 / 1000;   // 1 mil in mm

/** Official-style package description from the generated land pattern. */
function describePackage(family, pads, outline) {
  const mm = (v) => v * MIL_MM;
  const w = mm(outline[2] - outline[0]);
  const h = mm(outline[3] - outline[1]);
  const L = Math.max(w, h);
  const W = Math.min(w, h);
  // pitch = smallest positive centre spacing between pads in one column/row
  const cols = new Map();
  const rows = new Map();
  for (const p of pads) {
    const kx = Math.round(p[1] * 10);
    if (!cols.has(kx)) cols.set(kx, []);
    cols.get(kx).push(p[2]);
    const ky = Math.round(p[2] * 10);
    if (!rows.has(ky)) rows.set(ky, []);
    rows.get(ky).push(p[1]);
  }
  let pitch = Infinity;
  for (const line of [...cols.values(), ...rows.values()]) {
    line.sort((a, b) => a - b);
    for (let i = 1; i < line.length; i += 1) {
      const d = line[i] - line[i - 1];
      if (d > 0.5) pitch = Math.min(pitch, d);
    }
  }
  const pinCount = `${family}-${pads.length}`;
  return `${pinCount}_L${L.toFixed(1)}-W${W.toFixed(1)}`
    + (Number.isFinite(pitch) ? `-P${mm(pitch).toFixed(2)}` : '');
}

// LQFP is the everyday name for a fine-pitch QFP body.
FAMILIES.LQFP = FAMILIES.QFP;

module.exports = { FAMILIES, expandAuto, catalogue };
