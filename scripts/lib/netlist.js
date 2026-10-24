'use strict';
/**
 * netlist.js -?recover the ELECTRICAL truth from an authored project.
 *
 * The format validator proves the files are well formed. This module answers a
 * different question: which pin is actually connected to which, after the
 * coordinates, wire endpoints and net labels are resolved? Everything that
 * checks electrical correctness (ERC, netlist diff, dead-net warnings) is built
 * on top of it.
 *
 * Connectivity rules mirror the client's:
 *   - a wire's segments join their two endpoints
 *   - a pin connects where its TIP lands (exact coordinate equality -?that is
 *     what the client snaps to)
 *   - a pin landing anywhere on a wire segment also connects (T junction)
 *   - every wire carrying the same NET name is the same net (label semantics)
 *   - a power flag / net port connects at its origin and injects its net name
 */

const fs = require('fs');
const path = require('path');
const E = require('./eprj3');
const G = require('./geom');
const P = require('./parts');

const key = (x, y) => `${G.round(x)},${G.round(y)}`;

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(a) {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let root = a;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(a) !== root) {
      const next = this.parent.get(a);
      this.parent.set(a, root);
      a = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a); const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Split a sheet container into its embedded docs and the SCH_PAGE main doc. */
function readSheet(file) {
  const lines = E.readLines(file);
  const docs = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('{"type":"DOCHEAD"}')) {
      const r = E.parseRecord(l);
      cur = { docType: r && r.body && r.body.docType, uuid: r && r.body && r.body.uuid, records: [] };
      docs.push(cur);
    } else if (cur) {
      const r = E.parseRecord(l);
      if (r) cur.records.push(r);
    }
  }
  // An empty/truncated file has no DOCHEAD at all. Returning a record-less
  // stub lets ERC report the real condition (netlist ≠ design) instead of
  // crashing on `main.records`.
  const main = docs.find((d) => d.docType === 'SCH_PAGE') || docs[docs.length - 1]
    || { docType: null, uuid: null, records: [] };
  return { docs, main };
}

function attrsByParent(records, parentId) {
  return records.filter((r) => r.type === 'ATTR' && r.body && r.body.parentId === parentId);
}

/**
 * Electrical netlist of one sheet.
 * @returns {{
 *   components: [{ref, x, y, rotation, symbolUuid, pins:[{num,name,x,y}]}],
 *   nets: [{name, pins:[{ref, num, name}], auto:boolean}],
 *   unconnected: [{ref, num, name, x, y}],
 *   pinCount, wireCount
 * }}
 */
function sheetNetlist(file) {
  const { docs, main } = readSheet(file);
  const recs = main.records;

  const symbolByUuid = new Map();
  for (const d of docs) {
    if (d.docType !== 'SYMBOL') continue;
    symbolByUuid.set(d.uuid, P.parseSymbolEntry({ symbolDoc: d.records.map((r) => E.formatRecord(r.head, r.body)) }));
  }

  const components = [];
  const nodes = [];
  for (const r of recs) {
    if (r.type !== 'COMPONENT') continue;
    const b = r.body || {};
    const attrs = attrsByParent(recs, r.id);
    const designator = (attrs.find((a) => a.body.key === 'Designator') || {}).body;
    const symAttr = attrs.find((a) => a.body.key === 'Symbol');
    const globalNet = attrs.find((a) => a.body.key === 'Global Net Name');
    const dn = b.attrs && b.attrs.DeviceName ? JSON.parse(b.attrs.DeviceName) : null;
    const ref = (designator && designator.value) || (dn && dn.name) || '?';
    const sym = symAttr ? symbolByUuid.get(symAttr.body.value) : null;

    const pins = [];
    if (sym) {
      for (const pin of sym.pins) {
        const t = G.pinTip(pin, b.x, b.y, b.rotation || 0);
        pins.push({ num: String(pin.num), name: pin.name, x: t.x, y: t.y });
      }
    }
    components.push({
      ref,
      x: b.x, y: b.y, rotation: b.rotation || 0,
      symbolUuid: symAttr ? symAttr.body.value : null,
      power: globalNet ? globalNet.body.value : null,
      pins
    });
    if (globalNet) {
      nodes.push({ x: b.x, y: b.y, net: globalNet.body.value, ref, pin: null });
    }
  }

  // ---------------------------------------------------------- wires
  const uf = new UnionFind();
  const wireNets = [];
  const segments = [];
  const wireIds = new Set(recs.filter((r) => r.type === 'WIRE').map((r) => r.id));
  for (const r of recs) {
    if (r.type !== 'LINE' || !r.body || !wireIds.has(r.body.lineGroup)) continue;
    const b = r.body;
    const a = key(b.startX, b.startY);
    const c = key(b.endX, b.endY);
    uf.union(a, c);
    segments.push({ a, c, seg: { x1: b.startX, y1: b.startY, x2: b.endX, y2: b.endY }, wire: b.lineGroup });
  }
  for (const r of recs) {
    if (r.type !== 'ATTR' || !r.body || r.body.key !== 'NET' || !r.body.parentId) continue;
    if (!wireIds.has(r.body.parentId)) continue;
    wireNets.push({ wire: r.body.parentId, net: r.body.value });
  }

  // label semantics: every wire of the same net is one net
  const netRoots = new Map();
  for (const wn of wireNets) {
    const segs = segments.filter((s) => s.wire === wn.wire);
    if (!segs.length) continue;
    const root = uf.find(segs[0].a);
    if (!netRoots.has(wn.net)) netRoots.set(wn.net, []);
    netRoots.get(wn.net).push(root);
  }
  for (const [, roots] of netRoots) {
    for (let i = 1; i < roots.length; i += 1) uf.union(roots[0], roots[i]);
  }

  // ---------------------------------------------------------- pins
  const pinNodes = [];
  const unconnected = [];
  for (const comp of components) {
    for (const pin of comp.pins) {
      const k = key(pin.x, pin.y);
      // A pin connects where a wire ENDPOINT lands on its tip. A wire that
      // merely crosses a pin does NOT connect in the client (and treating it as
      // connected invents nets that the board does not have).
      const seg = segments.find((s) => s.a === k || s.c === k);
      if (seg) {
        uf.union(k, seg.a);
        pinNodes.push({ key: k, comp: comp.ref, pin: pin.num, name: pin.name, x: pin.x, y: pin.y, flag: !!comp.power });
      } else {
        unconnected.push({ ref: comp.ref, num: pin.num, name: pin.name, x: pin.x, y: pin.y });
        pinNodes.push({ key: k, comp: comp.ref, pin: pin.num, name: pin.name, x: pin.x, y: pin.y, flag: !!comp.power, floating: true });
      }
    }
  }
  for (const n of nodes) uf.union(key(n.x, n.y), `net:${n.net}`);

  // ---------------------------------------------------------- name the groups
  const rootNet = new Map();
  for (const wn of wireNets) {
    const segs = segments.filter((s) => s.wire === wn.wire);
    if (!segs.length) continue;
    // Register EVERY segment, not just the first: a wire may hold disjoint runs
    // (stub+label encoding), and each run's root needs the label too.
    for (const seg of segs) {
      rootNet.set(uf.find(seg.a), wn.net);
      rootNet.set(uf.find(seg.c), wn.net);
    }
  }
  for (const n of nodes) rootNet.set(uf.find(key(n.x, n.y)), n.net);

  const groups = new Map();
  for (const pn of pinNodes) {
    const root = uf.find(pn.key);
    if (!groups.has(root)) groups.set(root, { name: rootNet.get(root) || null, pins: [], flags: 0 });
    const g = groups.get(root);
    // Power flags / net ports are connection points, not component electrodes:
    // they name a net but never appear as a pin in the netlist.
    if (pn.flag || pn.comp === '?') g.flags += 1;
    else g.pins.push({ ref: pn.comp, num: pn.pin, name: pn.name, x: pn.x, y: pn.y });
  }
  // a net name declared by a wire anywhere in the group names the whole group
  for (const [root, g] of groups) {
    if (g.name) continue;
    const named = pinNodes.find((p) => uf.find(p.key) === root && rootNet.get(root));
    if (named) g.name = rootNet.get(root);
  }

  // pins that share a root but no wire (direct pin-on-pin touching) still count
  const named = new Map();
  let autoIdx = 0;
  const nets = [];
  const pinTouching = new Map();
  for (const [root, g] of groups) {
    if (!g.pins.length) continue;
    let name = g.name;
    if (!name && g.pins.length > 1) {
      // pins physically coincident but unwired: a real connection in the client
      autoIdx += 1;
      name = `N$${autoIdx}`;
    }
    if (!name) {
      // single unconnected pin -?no net at all
      continue;
    }
    if (named.has(name)) {
      named.get(name).pins.push(...g.pins);
      named.get(name).flags += g.flags;
    } else {
      const entry = { name, pins: g.pins.slice(), flags: g.flags, auto: name.startsWith('N$') };
      named.set(name, entry);
      nets.push(entry);
    }
  }
  void pinTouching;

  // merge groups that share a name (labels on disconnected wires)
  const merged = new Map();
  for (const n of nets) {
    if (!merged.has(n.name)) merged.set(n.name, { name: n.name, pins: [], flags: 0, auto: n.auto });
    merged.get(n.name).pins.push(...n.pins);
    merged.get(n.name).flags += n.flags;
  }

  return {
    components,
    nets: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unconnected,
    pinCount: pinNodes.length,
    wireCount: segments.length
  };
}

/** PCB netlist, straight from the PAD_NET records. */
function pcbNetlist(file) {
  const lines = E.readLines(file);
  const recs = [];
  for (const l of lines) {
    const r = E.parseRecord(l);
    if (r) recs.push(r);
  }
  const refByComp = new Map();
  for (const r of recs) {
    if (r.type !== 'ATTR' || !r.body) continue;
    if (r.body.key === 'Designator' && r.body.parentId) refByComp.set(r.body.parentId, r.body.value);
  }
  const pads = [];
  for (const r of recs) {
    if (r.type !== 'PAD_NET') continue;
    let parsed;
    try { parsed = JSON.parse(r.id); } catch { continue; }
    if (!Array.isArray(parsed) || parsed[0] !== 'PAD_NET') continue;
    const comp = parsed[1];
    pads.push({ ref: refByComp.get(comp) || comp, num: parsed[2], net: r.body.padNet || '' });
  }
  const nets = new Map();
  for (const p of pads) {
    if (!p.net) continue;
    if (!nets.has(p.net)) nets.set(p.net, []);
    nets.get(p.net).push({ ref: p.ref, num: p.num });
  }
  return {
    pads,
    nets: [...nets.entries()].map(([name, pins]) => ({ name, pins })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

/** All sheets of a project, by schematic/sheet name. */
function projectNetlist(dir) {
  const project = E.Project.load(dir);
  const perSheet = [];
  for (const sheet of Object.values(project.profile.sheets)) {
    const file = project.sheetFile(sheet);
    if (!fs.existsSync(file)) continue;
    const sch = project.profile.schematics[sheet.schematic_uuid];
    perSheet.push({
      schematic: sch ? sch.name : '?',
      sheet: sheet.title,
      file,
      netlist: sheetNetlist(file)
    });
  }
  const pcb = [];
  for (const p of Object.values(project.profile.pcbs)) {
    const f = path.join(dir, 'pcb', `${p.title}.epcb2`);
    if (fs.existsSync(f)) pcb.push({ pcb: p.title, netlist: pcbNetlist(f) });
  }
  return { project, perSheet, pcb };
}

module.exports = {
  key,
  UnionFind,
  readSheet,
  sheetNetlist,
  pcbNetlist,
  projectNetlist
};
