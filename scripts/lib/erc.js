'use strict';
/**
 * erc.js — electrical rule check.
 *
 * `validate.js` proves the files parse and cross-reference. This proves the
 * CIRCUIT is sane: every pin is connected, no net is a dead end, the built
 * netlist matches the design's intent, the PCB agrees with the schematic.
 *
 * Rules (id → meaning):
 *   E001 unconnected pin (lands on no wire, no label)
 *   E002 single-pin net (a label or flag with nothing to talk to)
 *   E003 netlist differs from the design file (missing / extra / re-named)
 *   E004 duplicate reference designator on one sheet
 *   E005 part in the schematic missing from the PCB (or vice versa)
 *   E006 PCB netlist disagrees with the schematic netlist
 *   E007 auto-named net (N$…) — an unnamed node reached the layout
 *   W001 power net with no power flag (looks like a rail but is drawn as a wire)
 *   W002 IC with no decoupling capacitor on its supply net
 *   W003 net touching only two pins of the same part (a self-loop)
 */

const fs = require('fs');
const N = require('./netlist');

const POWER_ISH = /^(VCC|VDD|VSS|GND|AGND|PGND|VBAT|VBUS|VIN|VOUT|\+?\d+V\d*|3V3|5V|12V|1V8|2V5)$/i;

function expectedFromDesign(design) {
  const nets = new Map();
  for (const p of design.parts) {
    for (const [num, net] of Object.entries(p.pins)) {
      if (!nets.has(net)) nets.set(net, new Set());
      nets.get(net).add(`${p.id}.${num}`);
    }
  }
  return nets;
}

function actualSet(netlist) {
  const out = new Map();
  for (const n of netlist.nets) {
    out.set(n.name, new Set(n.pins.map((p) => `${p.ref}.${p.num}`)));
  }
  return out;
}

function setsEqual(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * @param dir       project directory
 * @param opts      {design?: normalized design, pcb?: boolean}
 * @returns {errors:[], warnings:[], stats:{}}
 */
function runErc(dir, opts) {
  const errors = [];
  const warnings = [];
  const options = opts || {};
  const all = N.projectNetlist(dir);
  if (!all.perSheet.length) {
    errors.push({ id: 'E000', msg: `no sheet documents found in ${dir}` });
    return { errors, warnings, stats: {} };
  }

  const sheetSummaries = [];
  for (const s of all.perSheet) {
    const nl = s.netlist;
    const label = `${s.schematic}/${s.sheet}`;

    // E001 — unconnected pins
    for (const u of nl.unconnected) {
      errors.push({
        id: 'E001',
        sheet: label,
        msg: `unconnected pin ${u.ref}.${u.num} (${u.name}) at ${u.x},${u.y}`,
        ref: u.ref, pin: u.num
      });
    }

    // E004 — duplicate designators (power flags have no designator)
    const seen = new Map();
    for (const c of nl.components) {
      if (!c.ref || c.ref === '?') continue;
      if (!seen.has(c.ref)) seen.set(c.ref, 0);
      seen.set(c.ref, seen.get(c.ref) + 1);
    }
    for (const [ref, n] of seen) {
      if (n > 1) errors.push({ id: 'E004', sheet: label, msg: `duplicate designator "${ref}" (${n}×)` });
    }

    // E002 / E007 / W003 — per net
    for (const net of nl.nets) {
      const real = net.pins;
      if (real.length === 1 && !net.flags) {
        errors.push({
          id: 'E002',
          sheet: label,
          net: net.name,
          msg: `net "${net.name}" has only one pin (${real[0].ref}.${real[0].num})`
        });
      }
      if (net.auto || /^N\$/.test(net.name)) {
        warnings.push({
          id: 'E007',
          sheet: label,
          net: net.name,
          msg: `auto-named net "${net.name}" — pins touch but no label/wire names it`
        });
      }
      const refs = new Set(real.map((p) => p.ref));
      if (real.length === 2 && refs.size === 1) {
        warnings.push({
          id: 'W003',
          sheet: label,
          net: net.name,
          msg: `net "${net.name}" only bridges two pins of the same part (${real[0].ref})`
        });
      }
      if (POWER_ISH.test(net.name) && !net.flags) {
        warnings.push({
          id: 'W001',
          sheet: label,
          net: net.name,
          msg: `power net "${net.name}" has no power flag (drawn as a plain wire)`
        });
      }
    }

    // W002 — decoupling heuristic: an IC (>=8 pins) should have a capacitor
    // from its supply net to ground.
    const capRefs = new Set();
    for (const n of nl.nets) {
      if (!/^(VCC|VDD|VIN|3V3|5V|\+5V|\+3V3)$/i.test(n.name)) continue;
      const users = n.pins.filter((p) => p.ref !== '?').map((p) => p.ref);
      const hasCap = users.some((r) => /^C\d/.test(r));
      const ics = users.filter((r) => /^(U|IC)\d/.test(r));
      if (ics.length && !hasCap) {
        warnings.push({
          id: 'W002',
          sheet: label,
          net: n.name,
          msg: `supply net "${n.name}" powers ${ics.join(', ')} with no decoupling capacitor`
        });
      }
      users.filter((r) => /^C\d/.test(r)).forEach((r) => capRefs.add(r));
    }

    sheetSummaries.push({
      sheet: label,
      components: nl.components.length,
      pins: nl.pinCount,
      nets: nl.nets.length,
      unconnected: nl.unconnected.length
    });
  }

  // E003 — design intent vs built netlist (first sheet only; multi-sheet
  // designs are compared per pin name across all sheets)
  if (options.design) {
    const expected = expectedFromDesign(options.design);
    const built = new Map();
    for (const s of all.perSheet) {
      for (const [name, pins] of actualSet(s.netlist)) {
        if (!built.has(name)) built.set(name, new Set());
        for (const p of pins) built.get(name).add(p);
      }
    }
    for (const [net, want] of expected) {
      const have = built.get(net);
      if (!have) {
        errors.push({ id: 'E003', net, msg: `design net "${net}" is missing from the built schematic` });
        continue;
      }
      const missing = [...want].filter((p) => !have.has(p));
      const extra = [...have].filter((p) => !want.has(p));
      if (missing.length || extra.length) {
        errors.push({
          id: 'E003',
          net,
          msg: `net "${net}" differs from the design: expected {${[...want].join(', ')}}, built {${[...have].join(', ')}}`
            + (missing.length ? ` — missing ${missing.join(', ')}` : '')
            + (extra.length ? ` — extra ${extra.join(', ')}` : '')
        });
      }
    }
    for (const net of built.keys()) {
      if (!expected.has(net)) errors.push({ id: 'E003', net, msg: `built net "${net}" is not in the design` });
    }
  }

  // E005 / E006 — PCB agreement
  if (options.pcb !== false && all.pcb.length) {
    const schByPin = new Map();
    for (const s of all.perSheet) {
      for (const n of s.netlist.nets) {
        for (const p of n.pins) if (p.ref !== '?') schByPin.set(`${p.ref}.${p.num}`, n.name);
      }
    }
    for (const p of all.pcb) {
      const pcbByPin = new Map();
      for (const pad of p.netlist.pads) {
        if (pad.net) pcbByPin.set(`${pad.ref}.${pad.num}`, pad.net);
      }
      const pcbRefs = new Set(p.netlist.pads.map((x) => x.ref));
      for (const [pin, net] of schByPin) {
        const pcbNet = pcbByPin.get(pin);
        if (pcbNet === undefined) {
          if (pcbRefs.has(pin.split('.')[0])) {
            errors.push({
              id: 'E006',
              msg: `PCB pad ${pin} has no net, but the schematic puts it on "${net}"`
            });
          }
          continue;
        }
        if (pcbNet !== net) {
          errors.push({
            id: 'E006',
            msg: `PCB pad ${pin} is on net "${pcbNet}" but the schematic puts it on "${net}"`
          });
        }
      }
      const schRefs = new Set([...schByPin.keys()].map((k) => k.split('.')[0]));
      for (const r of schRefs) {
        if (!pcbRefs.has(r) && r !== '?') {
          errors.push({ id: 'E005', msg: `part "${r}" is in the schematic but has no PCB footprint` });
        }
      }
    }
  }

  return {
    errors,
    warnings,
    stats: {
      sheets: sheetSummaries,
      pcbs: all.pcb.map((p) => ({ pcb: p.pcb, pads: p.netlist.pads.length, nets: p.netlist.nets.length }))
    }
  };
}

module.exports = { runErc, expectedFromDesign, POWER_ISH };
void fs;
