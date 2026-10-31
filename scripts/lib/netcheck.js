'use strict';
/**
 * netcheck.js — schematic ↔ PCB netlist comparison (shared by the CLI
 * scripts/netcheck.js and build.js). Pure function over projectNetlist
 * output: every schematic pin must have a PCB pad on the same net, no net
 * may exist on one side only, no floating pins/pads.
 */
const N = require('./netlist');

/** Compare schematic and PCB netlists. Returns {match, summary, issues}.
 *  `baseOf` maps a multi-unit designator ("U34A") to its base ("U34") so a
 *  unit's schematic pins match the single footprint that carries them. */
function compare(all, baseOf) {
  // normalize multi-unit designators: exact via `baseOf` when the design is
  // available; otherwise strip the trailing unit letter ("U34A"→"U34") — safe
  // because the PCB component carries the base designator and only multi-unit
  // units are letter-suffixed.
  const pcbRefsAll = new Set();
  for (const pcbDoc of all.pcb || []) for (const pad of pcbDoc.netlist.pads) pcbRefsAll.add(pad.ref);
  const norm = (ref) => {
    if (baseOf && baseOf.has(ref)) return baseOf.get(ref);
    if (pcbRefsAll.has(ref)) return ref;
    const base = String(ref).replace(/[A-Z]+$/, '');
    return base && base !== ref && pcbRefsAll.has(base) ? base : ref;
  };
  const schByPin = new Map();   // "REF.pin" -> net
  const schNets = new Map();    // net -> Set("REF.pin")
  for (const s of all.perSheet) {
    for (const net of s.netlist.nets) {
      for (const p of net.pins) {
        if (p.ref === '?') continue;
        const key = `${norm(p.ref)}.${p.num}`;
        schByPin.set(key, net.name);
        if (!schNets.has(net.name)) schNets.set(net.name, new Set());
        schNets.get(net.name).add(key);
      }
    }
  }
  const schRefs = new Set([...schByPin.keys()].map((k) => k.split('.')[0]));
  const unconnected = [];
  for (const s of all.perSheet) {
    for (const u of s.netlist.unconnected) unconnected.push({ ref: u.ref, pin: u.num, where: `${s.schematic}/${s.sheet}` });
  }

  const issues = [];
  for (const pcbDoc of all.pcb) {
    const pcbByPin = new Map();
    const netless = [];
    for (const pad of pcbDoc.netlist.pads) {
      const key = `${norm(pad.ref)}.${pad.num}`;
      if (!pad.net) { netless.push(key); continue; }
      pcbByPin.set(key, pad.net);
    }
    // per-pad agreement
    for (const [key, net] of schByPin) {
      const ref = key.split('.')[0];
      if (!pcbByPin.has(key)) {
        if (pcbDoc.netlist.pads.some((p) => p.ref === ref)) {
          issues.push({ code: 'PAD_NET', pin: key, net, pcb: pcbDoc.pcb,
            msg: `schematic puts ${key} on "${net}" but its PCB pad has no net`,
            fix: `re-run build.js --force (pad nets come from the design); if the pad itself is missing, the footprint lacks that pin` });
        } else {
          issues.push({ code: 'NO_PAD', pin: key, net, pcb: pcbDoc.pcb,
            msg: `${key} is on schematic net "${net}" but the footprint has no pad for it`,
            fix: `use a footprint whose pads cover every mapped pin, or drop the pin from parts[].pins` });
        }
        continue;
      }
      const pcbNet = pcbByPin.get(key);
      if (pcbNet !== net) {
        issues.push({ code: 'NET_MISMATCH', pin: key, net, pcbNet, pcb: pcbDoc.pcb,
          msg: `${key}: schematic net "${net}" ≠ PCB net "${pcbNet}"`,
          fix: `re-run build.js --force; if it persists, fix parts[].pins of ${ref}` });
      }
    }
    // pads without a schematic counterpart
    for (const [key, net] of pcbByPin) {
      if (!schByPin.has(key)) {
        issues.push({ code: 'EXTRA_PAD', pin: key, net, pcb: pcbDoc.pcb,
          msg: `PCB pad ${key} is on net "${net}" but the schematic has no such pin`,
          fix: `add pin ${key.split('.')[1]} to parts[].pins of ${key.split('.')[0]}, or use a symbol whose pins match the footprint` });
      }
    }
    // parts present on one side only
    const pcbRefs = new Set(pcbDoc.netlist.pads.map((p) => norm(p.ref)));
    for (const ref of schRefs) {
      if (!pcbRefs.has(ref)) {
        issues.push({ code: 'NO_FOOTPRINT', ref, pcb: pcbDoc.pcb,
          msg: `part ${ref} is in the schematic but has no footprint on the PCB`,
          fix: `give ${ref} a "footprint" in the design (or set "pcb": false)` });
      }
    }
    for (const ref of pcbRefs) {
      if (!schRefs.has(ref)) {
        issues.push({ code: 'NO_SYMBOL', ref, pcb: pcbDoc.pcb,
          msg: `footprint ${ref} is on the PCB but has no schematic symbol`,
          fix: `add a parts[] entry for ${ref} (schematic and PCB are generated together)` });
      }
    }
    if (netless.length) {
      issues.push({ code: 'PAD_NO_NET', count: netless.length, pcb: pcbDoc.pcb,
        msg: `${netless.length} PCB pad(s) without a net: ${netless.slice(0, 6).join(' ')}${netless.length > 6 ? ' …' : ''}`,
        fix: `map every footprint pad in parts[].pins, then re-run build.js --force` });
    }
  }
  for (const u of unconnected) {
    issues.push({ code: 'PIN_FLOATING', pin: `${u.ref}.${u.pin}`, where: u.where,
      msg: `schematic pin ${u.ref}.${u.pin} connects to nothing (${u.where})`,
      fix: `map it in parts[].pins (or "NC"), then re-run build.js --force` });
  }
  return {
    match: issues.length === 0,
    summary: {
      schematic: { pins: schByPin.size, nets: schNets.size, parts: schRefs.size },
      pcb: all.pcb.map((p) => ({ pcb: p.pcb, pads: p.netlist.pads.length })),
      unconnected: unconnected.length
    },
    issues
  };
}

module.exports = { compare };
void N;
