'use strict';
/**
 * audit.js — assemble a SELF-CONTAINED netlist audit package.
 *
 * Every gate runs inside the build, and the agent that wrote design.json is the
 * same agent that reads the verdicts. An independent reviewer with no inherited
 * context can still judge the result if it is handed three things side by side:
 *
 *   spec       what the design ASKED for (part → pin → net, from design.json)
 *   built      what the schematic actually CONNECTS (recovered from the files)
 *   mechanical the tool's own diff between the two (evidence, not authority —
 *              the reviewer must recompute it from spec and built)
 *
 * `scripts/netlist.js --design <d> --audit <out>` writes this package;
 * SKILL.md hands the file to a fresh sub-agent, which returns the verdict
 * schema at the bottom of the package. The package never contains coordinates
 * or UUIDs: the reviewer needs connectivity, not geometry.
 */
const path = require('path');
const N = require('./netlist');
const { compare } = require('./netcheck');

const SCHEMA = 'eprj3-netlist-audit/1';

// "no connect" conventions accepted by the ERC (E002 exemption).
const NC_NET = /^(NC|DNC\d*|N\/C)$/i;
// names that LOOK like a rail — same family the ERC uses for W001/W002.
const POWER_ISH = /^(VCC|VDD|VSS|GND|AGND|PGND|VBAT|VBUS|VIN|VOUT|\+?\d+V\d*|3V3|5V|12V|12V0|1V8|2V5|\+5V|\+3V3)$/i;

/** The reviewer's checklist. Kept in the package so the prompt stays short. */
const RUBRIC = [
  'Recompute the expected net groups from spec.parts yourself (pin number -> net name). Do not trust mechanical.diff; use it only to check your own work.',
  'For every net name on either side, the set of "REF.pin" must be identical. A net that exists on one side only, or a pin missing/extra on a shared net, is NET_DIFF (severity error).',
  'A pin must sit on exactly one net. The same REF.pin on two built nets is BUILT_PIN_TWICE; two spec nets claiming one pin is PIN_TWICE. Both are errors.',
  'A pin whose spec net is NC/DNC* must not appear on any other net in built, and a pin with a real net in spec must not land on an NC net — NC_VIOLATION.',
  'Every net named in spec.powers must exist in built with flags >= 1 (a power flag was actually drawn) — POWER_FLAG_MISSING.',
  'Every pin mapped in spec.parts must exist in built (nets or unconnected). A pin that vanished means the symbol lacks it — PIN_MISSING.',
  'built.unconnected must be empty — a floating pin is an error even when no net references it.',
  'mechanical.netcheck.match must be true and its issues list must be empty — PCB_MISMATCH otherwise.',
  'Advisory only (severity warn): a net with a single pin and no power flag, an auto-named N$ net, a supply-looking name with no power flag, a part whose every mapped pin sits on one net, or a spec that expects more than the built netlist can show.',
  'If the package contradicts itself (a net in spec absent from built while mechanical.ok is true, a count that does not add up), report TAMPERED_OR_BROKEN_PACKAGE as an error.',
  'Report only what the package proves. Never invent parts, pads, nets or values that are not in it.'
];

const VERDICT = {
  output: 'one JSON object, no prose and no markdown fence',
  shape: {
    ok: 'boolean — true only when no finding has severity "error"',
    summary: 'one sentence: what you checked and what you found',
    findings: [
      {
        severity: 'error | warn',
        code: 'NET_DIFF | PIN_TWICE | BUILT_PIN_TWICE | NC_VIOLATION | PIN_MISSING | POWER_FLAG_MISSING | PCB_MISMATCH | SINGLE_PIN_NET | AUTO_NET | SHORT | TAMPERED_OR_BROKEN_PACKAGE',
        net: 'net name or null',
        pins: ['R1.2'],
        msg: 'what is wrong, with the evidence',
        fix: 'the exact design.json change that fixes it'
      }
    ]
  },
  rule: 'ok = no finding has severity "error". Warnings never change ok.'
};

function pinKey(ref, num) {
  return `${ref}.${num}`;
}

function symbolName(part) {
  const s = part.symbol;
  if (typeof s === 'string') return s;
  return (s && s.name) || (part.ic ? String(part.ic) : 'inline');
}

/**
 * Design part id → client designator. Multi-unit parts carry a unit id in the
 * design (U34A … U34G) while the client stores ONE base designator on every
 * unit's COMPONENT (U34). Every spec/built comparison must fold to the base.
 */
function unitBaseMap(design) {
  const m = new Map();
  for (const [base, info] of Object.entries((design && design.multiUnits) || {})) {
    for (const uid of (info && info.units) || []) m.set(uid, base);
  }
  return m;
}

/** Expected connectivity, straight from the design's pin→net maps. */
function specGroups(design) {
  const groups = new Map();      // net -> Set("REF.pin")
  const pinToNets = new Map();   // "REF.pin" -> [net]
  const pinNet = new Map();      // "REF.pin" -> first declared net
  const partPins = new Map();    // ref -> [pin num]
  if (!design || !Array.isArray(design.parts)) return { groups, pinToNets, pinNet, partPins };
  const unitBase = unitBaseMap(design);
  const refOf = (id) => unitBase.get(id) || id;
  for (const part of design.parts) {
    const ref = refOf(part.id);
    const pins = part.pins && typeof part.pins === 'object' ? part.pins : {};
    for (const [num, net] of Object.entries(pins)) {
      const pin = pinKey(ref, num);
      const name = String(net);
      if (!groups.has(name)) groups.set(name, new Set());
      groups.get(name).add(pin);
      if (!pinToNets.has(pin)) pinToNets.set(pin, []);
      if (!pinToNets.get(pin).includes(name)) pinToNets.get(pin).push(name);
      if (!pinNet.has(pin)) pinNet.set(pin, name);
      if (!partPins.has(ref)) partPins.set(ref, []);
      partPins.get(ref).push(String(num));
    }
  }
  return { groups, pinToNets, pinNet, partPins };
}

/** Recovered connectivity, merged across sheets (net names are global). */
function builtGroups(all) {
  const groups = new Map();      // net -> {name, pins:Set, flags, sheets:Set}
  const pinToNets = new Map();   // "REF.pin" -> [net]
  const unconnected = [];
  for (const s of all.perSheet) {
    const label = `${s.schematic}/${s.sheet}`;
    for (const net of s.netlist.nets) {
      if (!groups.has(net.name)) {
        groups.set(net.name, { name: net.name, pins: new Set(), flags: 0, sheets: new Set() });
      }
      const g = groups.get(net.name);
      g.flags += net.flags || 0;
      g.sheets.add(label);
      for (const p of net.pins) {
        if (p.ref === '?') continue;
        const pin = pinKey(p.ref, p.num);
        g.pins.add(pin);
        if (!pinToNets.has(pin)) pinToNets.set(pin, []);
        if (!pinToNets.get(pin).includes(net.name)) pinToNets.get(pin).push(net.name);
      }
    }
    for (const u of s.netlist.unconnected) {
      if (u.ref === '?') continue;
      unconnected.push({ pin: pinKey(u.ref, u.num), name: u.name, where: label });
    }
  }
  return { groups, pinToNets, unconnected };
}

/** Net-by-net set difference between spec and built. */
function diffSpec(spec, built) {
  const names = [...new Set([...spec.groups.keys(), ...built.groups.keys()])].sort();
  const nets = [];
  for (const name of names) {
    const want = spec.groups.get(name) || new Set();
    const have = built.groups.has(name) ? built.groups.get(name).pins : new Set();
    const missing = [...want].filter((p) => !have.has(p)).sort();
    const extra = [...have].filter((p) => !want.has(p)).sort();
    if (!missing.length && !extra.length) continue;
    nets.push({ name, spec: [...want].sort(), built: [...have].sort(), missing, extra });
  }
  return { ok: nets.length === 0, nets };
}

/** Pins claimed by more than one net — a short, whichever side it is on. */
function pinsOnTwoNets(pinToNets) {
  const out = [];
  for (const [pin, nets] of pinToNets) {
    if (nets.length > 1) out.push({ pin, nets: [...nets].sort() });
  }
  return out.sort((a, b) => a.pin.localeCompare(b.pin));
}

/** Spec pins that the built schematic does not know at all (symbol lacks them). */
function missingPins(spec, built) {
  const present = new Set(built.pinToNets.keys());
  for (const u of built.unconnected) present.add(u.pin);
  const out = [];
  for (const [part, nums] of spec.partPins) {
    for (const num of nums) {
      const pin = pinKey(part, num);
      if (!present.has(pin)) out.push({ pin, net: spec.pinNet.get(pin) || null });
    }
  }
  return out.sort((a, b) => a.pin.localeCompare(b.pin));
}

/** NC declared on one side, a real net built on the other (either direction). */
function ncViolations(spec, built) {
  const out = [];
  for (const [pin, specNet] of spec.pinNet) {
    const actual = built.pinToNets.get(pin) || [];
    for (const builtNet of actual) {
      const specNc = NC_NET.test(specNet);
      const builtNc = NC_NET.test(builtNet);
      if (specNc !== builtNc) out.push({ pin, specNet, builtNet });
    }
  }
  return out.sort((a, b) => a.pin.localeCompare(b.pin));
}

/**
 * Advisory smells. They never flip mechanical.ok — a warn is a question for the
 * reviewer, not a verdict, so a false positive cannot start a rebuild loop.
 */
function suspicions(spec, built, design) {
  const out = [];
  for (const g of [...built.groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const pins = [...g.pins].sort();
    const nc = NC_NET.test(g.name);
    const rail = POWER_ISH.test(g.name);
    if (pins.length === 1 && !nc && !rail && !g.flags) {
      out.push({ severity: 'warn', code: 'SINGLE_PIN_NET', net: g.name, pins, msg: `net "${g.name}" has one pin (dead end)` });
    }
    if (/^N\$/.test(g.name)) {
      out.push({ severity: 'warn', code: 'AUTO_NET', net: g.name, pins, msg: `net "${g.name}" is auto-named — nothing labels it` });
    }
    if (rail && !g.flags) {
      out.push({ severity: 'warn', code: 'POWER_FLAG_MISSING', net: g.name, pins, msg: `supply-looking net "${g.name}" has no power flag` });
    }
  }

  // every mapped pin of a part on one single net = a shorted part
  const netsByRef = new Map();
  for (const g of built.groups.values()) {
    for (const pin of g.pins) {
      const ref = pin.split('.')[0];
      if (!netsByRef.has(ref)) netsByRef.set(ref, new Set());
      netsByRef.get(ref).add(g.name);
    }
  }
  const declared = new Map(((design && design.parts) || []).map((p) => [p.id, p]));
  const specPins = spec ? spec.partPins : new Map();
  for (const [ref, nets] of netsByRef) {
    if (nets.size !== 1) continue;
    const net = [...nets][0];
    if (NC_NET.test(net) || /^J/i.test(ref)) continue;    // NC group / connectors bridge by design
    const part = declared.get(ref);
    if (part && part.bridge === 'ok') continue;
    const mapped = specPins.get(ref) || [];
    if (mapped.length < 2) continue;
    out.push({ severity: 'warn', code: 'SHORT', net, pins: mapped.map((n) => pinKey(ref, n)).sort(),
      msg: `every mapped pin of ${ref} sits on "${net}" — the part is shorted` });
  }
  return out;
}

/**
 * Build the package.
 * @param {string} dir     project directory
 * @param {object|null} design normalized design (design.readDesign) or null
 */
function buildPackage(dir, design) {
  const all = N.projectNetlist(dir);
  const spec = design ? specGroups(design) : null;
  const built = builtGroups(all);
  const netcheck = compare(all);

  const diff = spec ? diffSpec(spec, built) : null;
  const missing = spec ? missingPins(spec, built) : [];
  const twistSpec = spec ? pinsOnTwoNets(spec.pinToNets) : [];
  const twistBuilt = pinsOnTwoNets(built.pinToNets);
  const nc = spec ? ncViolations(spec, built) : [];
  const smell = suspicions(spec, built, design);
  const unitBase = design ? unitBaseMap(design) : new Map();

  const mechanicalOk = netcheck.match
    && built.unconnected.length === 0
    && twistBuilt.length === 0
    && (!spec || (diff.ok && missing.length === 0 && twistSpec.length === 0 && nc.length === 0));

  return {
    schema: SCHEMA,
    project: {
      dir: path.resolve(dir),
      name: (design && design.name) || path.basename(path.resolve(dir)),
      designFile: design && design.file ? path.resolve(design.file) : null
    },
    spec: design ? {
      name: design.name,
      powers: design.powers || {},
      parts: design.parts.map((p) => ({
        id: p.id,
        // the designator the client prints; multi-unit parts (id U34A) all
        // fold to one base ref (U34) — compare against this, not id
        ref: unitBase.get(p.id) || p.id,
        symbol: symbolName(p),
        value: p.value === undefined ? null : p.value,
        pins: Object.assign({}, p.pins)
      })),
      expect: design.expect || null
    } : null,
    built: {
      sheets: all.perSheet.map((s) => ({
        schematic: s.schematic,
        sheet: s.sheet,
        pins: s.netlist.pinCount,
        nets: s.netlist.nets.length,
        unconnected: s.netlist.unconnected.length
      })),
      nets: [...built.groups.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((g) => ({ name: g.name, pins: [...g.pins].sort(), flags: g.flags, sheets: [...g.sheets].sort() })),
      unconnected: built.unconnected.sort((a, b) => a.pin.localeCompare(b.pin)),
      pcb: all.pcb.map((p) => ({
        pcb: p.pcb,
        nets: p.netlist.nets
          .map((n) => ({ name: n.name, pads: n.pins.map((x) => pinKey(x.ref, x.num)).sort() }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }))
    },
    mechanical: {
      ok: mechanicalOk,
      specAvailable: !!design,
      netcheck: { match: netcheck.match, summary: netcheck.summary, issues: netcheck.issues },
      diff,
      missingPins: missing,
      pinTwice: { spec: twistSpec, built: twistBuilt },
      ncViolations: nc,
      suspicions: smell
    },
    rubric: RUBRIC,
    verdictSchema: VERDICT
  };
}

module.exports = { SCHEMA, RUBRIC, VERDICT, buildPackage, specGroups, builtGroups, diffSpec };
