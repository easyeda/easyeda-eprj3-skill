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
 *   E008 two outputs drive one net (design-context rule: directions come from
 *         the symbol/IC specs, not from the built records)
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
  // how many sheets carry each net name — cross-sheet nets (ports) legitimately
  // have one pin per sheet, so the per-sheet single-pin rule must not fire
  const netSheetCount = new Map();
  for (const s of all.perSheet) {
    for (const net of s.netlist.nets) netSheetCount.set(net.name, (netSheetCount.get(net.name) || 0) + 1);
  }
  for (const s of all.perSheet) {
    const nl = s.netlist;
    const label = `${s.schematic}/${s.sheet}`;

    // E001 — unconnected pins
    for (const u of nl.unconnected) {
      errors.push({
        id: 'E001',
        sheet: label,
        msg: `unconnected pin ${u.ref}.${u.num} (${u.name}) at ${u.x},${u.y}`,
        ref: u.ref, pin: u.num,
        fix: `set parts[].pins["${u.num}"] of ${u.ref} in the design to a net (or "NC" if intentionally unused), then re-run build.js --force`
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
      if (n > 1) errors.push({
        id: 'E004', sheet: label,
        msg: `duplicate designator "${ref}" (${n}×)`,
        fix: `give each occurrence a unique parts[].id (e.g. ${ref}A / ${ref}B)`
      });
    }

    // E002 / E007 / W003 — per net
    for (const net of nl.nets) {
      const real = net.pins;
      // NC/DNC nets are the deliberate "no connect" convention: a lone pin on
      // one of them is intentional, not a wiring mistake. A net that also
      // exists on another sheet is a cross-sheet (port) net — its per-sheet
      // single pin joins the global net through the port.
      if (real.length === 1 && !net.flags && (netSheetCount.get(net.name) || 0) < 2 && !/^(NC|DNC\d*)$/i.test(net.name)) {
        errors.push({
          id: 'E002',
          sheet: label,
          net: net.name,
          msg: `net "${net.name}" has only one pin (${real[0].ref}.${real[0].num})`,
          fix: `wire the pin to something, declare the net in "powers", or rename it "NC" in parts[].pins if intentionally unconnected`
        });
      }
      if (net.auto || /^N\$/.test(net.name)) {
        warnings.push({
          id: 'E007',
          sheet: label,
          net: net.name,
          msg: `auto-named net "${net.name}" — pins touch but no label/wire names it`,
          fix: `rename the net in parts[].pins to something meaningful (uppercase, e.g. SPI_CLK)`
        });
      }
      const refs = new Set(real.map((p) => p.ref));
      if (real.length === 2 && refs.size === 1) {
        // legal same-part bridges (USB-C A6/B6 dual contacts, connector 3V3
        // pairs, module-internal jumpers) must not spam W003: exempt power
        // nets, connector-class parts (designator J or ≥6 pins), and parts
        // that declare `bridge: "ok"`
        const partDef = options.design && options.design.parts.find((x) => x.id === real[0].ref);
        const bridged = !partDef || partDef.bridge === 'ok' || /^J/i.test(real[0].ref);
        const comp = nl.components.find((c) => c.ref === real[0].ref);
        const connectorish = comp && comp.pins.length >= 6;
        const powerNet = options.design && options.design.powers && options.design.powers[net.name] !== undefined;
        if (!bridged && !connectorish && !powerNet) {
          warnings.push({
            id: 'W003',
            sheet: label,
            net: net.name,
            msg: `net "${net.name}" only bridges two pins of the same part (${real[0].ref})`,
            fix: `check ${real[0].ref}'s parts[].pins — two of its pins map to "${net.name}"; usually one of them is a typo (declare "bridge": "ok" on the part if the bridge is intentional)`
          });
        }
      }
      if (POWER_ISH.test(net.name) && !net.flags) {
        warnings.push({
          id: 'W001',
          sheet: label,
          net: net.name,
          msg: `power net "${net.name}" has no power flag (drawn as a plain wire)`,
          fix: `declare "${net.name}" in the design's "powers" (style "up" for supplies, "down" for ground)`
        });
      }
    }

    // W002 — decoupling heuristic: an IC (>=8 pins) should have a capacitor
    // from its supply net to ground. Supply-ish net names only — ground names
    // (VSS/GND) match POWER_ISH but obviously do not "power" anything.
    const capRefs = new Set();
    for (const n of nl.nets) {
      if (!/^(VCC|VDD|VDDA|VBAT|VBUS|VIN|VOUT|AVDD|3V3|5V|1V8|2V5|\+5V|\+3V3)$/i.test(n.name)) continue;
      const users = n.pins.filter((p) => p.ref !== '?').map((p) => p.ref);
      const hasCap = users.some((r) => /^C\d/.test(r));
      const ics = users.filter((r) => /^(U|IC)\d/.test(r));
      if (ics.length && !hasCap) {
        warnings.push({
          id: 'W002',
          sheet: label,
          net: n.name,
          msg: `supply net "${n.name}" powers ${ics.join(', ')} with no decoupling capacitor`,
          fix: `add a 100nF capacitor from "${n.name}" to ground — or run: node scripts/autofix.js --design <file> (adds them automatically)`
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
        errors.push({
          id: 'E003', net,
          msg: `design net "${net}" is missing from the built schematic`,
          fix: `re-run build.js --force; if it persists, check which parts[].pins reference "${net}"`
        });
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
            + (extra.length ? ` — extra ${extra.join(', ')}` : ''),
          fix: `re-run build.js --force; if it persists, check parts[].pins entries that reference "${net}" (suspect: ${[...missing, ...extra][0].split('.')[0]})`
        });
      }
    }
    for (const net of built.keys()) {
      if (!expected.has(net)) {
        errors.push({
          id: 'E003', net,
          msg: `built net "${net}" is not in the design`,
          fix: `remove or rename "${net}" in parts[].pins, then re-run build.js --force`
        });
      }
    }
  }

  // E008 — two outputs driving one net. Pin directions live in the design's
  // symbol/IC specs (the client only stores an unverified Pin Type enum, so we
  // do not write directions into records) — hence this rule needs the design
  // context, which build.js always has; standalone `erc.js` without --design
  // skips it.
  if (options.design) {
    const dirByRef = new Map();
    for (const p of options.design.parts) {
      if (p.pinDirs && Object.keys(p.pinDirs).length) dirByRef.set(p.id, p.pinDirs);
    }
    for (const s of all.perSheet) {
      for (const net of s.netlist.nets) {
        const outs = net.pins.filter((p) => (dirByRef.get(p.ref) || {})[String(p.num)] === 'O');
        if (outs.length >= 2) {
          errors.push({
            id: 'E008',
            sheet: `${s.schematic}/${s.sheet}`,
            net: net.name,
            msg: `net "${net.name}" is driven by ${outs.length} outputs (${outs.map((p) => `${p.ref}.${p.num}`).join(', ')})`,
            fix: `one driver per net — mark one side as an input/high-Z in the symbol or IC spec, or tie one driver through a gate/resistor`
          });
        }
      }
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
              msg: `PCB pad ${pin} has no net, but the schematic puts it on "${net}"`,
              fix: `re-run build.js --force (PCB pad nets are generated from the design)`
            });
          }
          continue;
        }
        if (pcbNet !== net) {
          errors.push({
            id: 'E006',
            msg: `PCB pad ${pin} is on net "${pcbNet}" but the schematic puts it on "${net}"`,
            fix: `re-run build.js --force; if it persists, fix the "${pin.split('.')[0]}" entry in parts[]`
          });
        }
      }
      const schRefs = new Set([...schByPin.keys()].map((k) => k.split('.')[0]));
      for (const r of schRefs) {
        if (!pcbRefs.has(r) && r !== '?') {
          errors.push({
            id: 'E005',
            msg: `part "${r}" is in the schematic but has no PCB footprint`,
            fix: `give "${r}" a "footprint" in the design (or set "pcb": false)`
          });
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
