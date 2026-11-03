'use strict';
/**
 * sch-patterns.js — circuit pattern macros for the schematic placer.
 *
 * Independent implementation of an idea from the reference layout engine
 * (eda-copilot `circuit-layout/patterns/`): recognise a reusable structure
 * inside a block and give its members a fixed, readable geometry instead of
 * letting the generic grid decide. No code is copied and no dependency is
 * added.
 *
 * Recognised here: a block made only of two-pin parts joined in a chain — LED
 * + series resistor, RC, voltage divider, pull-up ladder. The chain is stacked
 * along Y, supply end north and ground end south, shared pins facing each other
 * with a short wire; outer odd nets get ports from the router. A block whose
 * new frame would touch a neighbour keeps its generic placement, so this pass
 * can never make a sheet worse.
 *
 * A MIXED block (an IC plus its decoupling caps) is handled by absorbing the
 * largest two-pin sub-bank into one row beside the remaining parts (right or
 * above, whichever keeps the block smaller); the router's bank comb then turns
 * the row's shared pins into one rail and one flag. A row that would inflate
 * the block past 10% is rejected, so the generic placement is kept.
 */
const G = require('./geom');
const { partExtent } = require('./design');
const T = require('./sch-tokens');

// spacing comes from the token sheet — one rhythm for the whole drawing
const PIN_GAP = T.PIN_GAP;
const COL_GAP = T.COL_GAP;
const BANK_GAP = T.BANK_GAP;
const PAD = T.FRAME_PAD;
const SUB_PAD = T.FRAME_PAD;
const SUB_GATE = 1.10; // sub-bank row accepted only within 10% of the block area
const TITLE_H = T.TITLE_H;
const EPS = 1e-6;

const grid = (v) => Math.round(v / 10) * 10;
const unionRect = (a, b) => G.rect(Math.min(a.x1, b.x1), Math.min(a.y1, b.y1),
  Math.max(a.x2, b.x2), Math.max(a.y2, b.y2));

const pinsOf = (pl) => Object.values(pl.part.pins || {});
const pinRecord = (sym, part, net) => {
  const nums = Object.keys(part.pins || {}).filter((n) => part.pins[n] === net);
  if (nums.length !== 1) return null;
  return sym.pins.find((p) => String(p.num) === String(nums[0])) || null;
};

/**
 * Split a block's members into chains of two-pin parts.
 * Returns null unless EVERY member belongs to a path (no lone part, no loop).
 * Each chain: { ids:[...], shared:[net between i and i+1],
 *               top: net at ids[0] beyond shared[0],
 *               bottom: net at the last id beyond the last shared }.
 */
function blockChains(design, members) {
  if (members.length < 2) return null;
  const byId = new Map(members.map((pl) => [pl.part.id, pl]));
  const netParts = new Map();
  for (const pl of members) {
    const nets = pinsOf(pl);
    if (nets.length !== 2 || !pl.sym || pl.sym.pins.length !== 2) return null;
    for (const n of new Set(nets)) {
      if (!netParts.has(n)) netParts.set(n, []);
      netParts.get(n).push(pl.part.id);
    }
  }
  const adj = new Map(members.map((pl) => [pl.part.id, []]));
  for (const [net, ids] of netParts) {
    if (/^(NC|DNC\d*)$/i.test(net)) continue;
    if (ids.length !== 2 || ids[0] === ids[1]) continue;
    adj.get(ids[0]).push({ id: ids[1], net });
    adj.get(ids[1]).push({ id: ids[0], net });
  }
  for (const list of adj.values()) if (list.length > 2) return null;   // star

  const seen = new Set();
  const chains = [];
  for (const pl of members) {
    const id = pl.part.id;
    if (seen.has(id) || adj.get(id).length !== 1) continue;             // start at a path end
    const ids = [id];
    const shared = [];
    seen.add(id);
    let cur = id;
    for (;;) {
      const edge = adj.get(cur).find((e) => e.id !== ids[ids.length - 2]);
      if (!edge || seen.has(edge.id)) break;
      ids.push(edge.id);
      shared.push(edge.net);
      seen.add(edge.id);
      cur = edge.id;
    }
    if (ids.length < 2) return null;
    const nets = (pid) => new Set(pinsOf(byId.get(pid)));
    const outer = (pid, skip) => [...nets(pid)].find((n) => n !== skip) || null;
    chains.push({
      ids,
      shared,
      top: outer(ids[0], shared[0]),
      bottom: outer(ids[ids.length - 1], shared[shared.length - 1])
    });
  }
  if (seen.size !== members.length) return null;   // a loop or an isolated part
  return chains;
}

/** Reverse a chain's reading order (top ↔ bottom). */
function reverseChain(c) {
  const ids = c.ids.slice().reverse();
  const shared = c.shared.slice().reverse();
  return { ids, shared, top: c.bottom, bottom: c.top };
}

/**
 * Geometry for one chain read top→bottom.
 * Returns { steps:[{pl, sym, x, y, rot, extent}], bbox } in local coords
 * (the first part's north pin sits on y=0), or null when a member's two pins
 * cannot be made vertical.
 */
function layoutChain(chain, byId) {
  const steps = [];
  let northY = 0;
  for (let i = 0; i < chain.ids.length; i += 1) {
    const pl = byId.get(chain.ids[i]);
    const sym = pl.sym;
    const prevNet = i === 0 ? chain.top : chain.shared[i - 1];
    const nextNet = i === chain.ids.length - 1 ? chain.bottom : chain.shared[i];
    const a = pinRecord(sym, pl.part, prevNet);
    const b = pinRecord(sym, pl.part, nextNet);
    if (!a || !b || prevNet === nextNet) return null;
    let pick = null;
    for (const rot of [0, 90, 180, 270]) {
      const ra = G.rotate(a.x, a.y, rot);
      const rb = G.rotate(b.x, b.y, rot);
      if (Math.abs(ra.x - rb.x) > EPS || Math.abs(ra.y - rb.y) < EPS) continue;
      if (ra.y > rb.y) { pick = { rot, north: ra, south: rb }; break; }
    }
    if (!pick) return null;
    const x = -pick.north.x;                       // pin axis at x = 0
    const y = northY - pick.north.y;
    steps.push({ pl, sym, x, y, rot: pick.rot });
    northY = y + pick.south.y - PIN_GAP;           // next member's north pin
  }
  let bbox = null;
  for (const s of steps) {
    s.extent = partExtent(s.sym, s.x, s.y, s.rot);
    bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  }
  return { steps, bbox };
}

/** The net of a two-pin part that is not `net`. */
function otherNet(pl, net) {
  return Object.values(pl.part.pins || {}).find((n) => n !== net) || null;
}

/**
 * A block made only of two-pin parts that all share both nets (decoupling /
 * parallel pair bank) or one net with distinct partners (pull-up/down bank).
 * Chains are handled first; this covers the star/cycle shapes.
 * Returns { parts, north, south, common } or null.
 */
function blockBank(design, members) {
  if (members.length < 2) return null;
  const sets = [];
  for (const pl of members) {
    const nets = Object.values(pl.part.pins || {});
    if (nets.length !== 2 || !pl.sym || pl.sym.pins.length !== 2) return null;
    sets.push(new Set(nets));
  }
  const common = [...sets[0]].filter((n) => sets.every((s) => s.has(n)));
  if (!common.length || common.length > 2) return null;
  if (common.length === 1) {
    const others = members.map((pl, i) => [...sets[i]].find((n) => n !== common[0]));
    if (others.some((n) => !n) || new Set(others).size !== others.length) return null;
    const down = design.powers[common[0]] === 'down';
    return {
      parts: members,
      common: common[0],
      north: down ? null : common[0],
      south: down ? common[0] : null
    };
  }
  // parallel pair bank: supply north, ground south (deterministic otherwise)
  const [a, b] = common;
  const aUp = design.powers[a] === 'up';
  const bDown = design.powers[b] === 'down';
  const north = aUp || bDown ? a : b;
  return { parts: members, common: null, north, south: north === a ? b : a };
}

/**
 * Lay a bank as one row: every member aligned on its common pin, the common
 * side flat (north for a supply/signal, south for a ground), partners outward.
 */
function layoutBank(bank, byId) {
  const alignSouth = !bank.north && !!bank.south;
  const steps = [];
  let cursor = 0;
  for (const pl of bank.parts) {
    const sym = pl.sym;
    const commonNet = bank.common || (bank.north || bank.south);
    const aligned = bank.common ? commonNet : (alignSouth ? bank.south : bank.north);
    const outward = otherNet(pl, aligned);
    if (!outward) return null;
    const a = pinRecord(sym, pl.part, aligned);
    const b = pinRecord(sym, pl.part, outward);
    if (!a || !b) return null;
    let pick = null;
    for (const rot of [0, 90, 180, 270]) {
      const ra = G.rotate(a.x, a.y, rot);
      const rb = G.rotate(b.x, b.y, rot);
      if (Math.abs(ra.x - rb.x) > EPS || Math.abs(ra.y - rb.y) < EPS) continue;
      const aSouth = ra.y < rb.y;
      if (alignSouth ? aSouth : !aSouth) { pick = { rot, aligned: ra }; break; }
    }
    if (!pick) return null;
    const x = cursor - pick.aligned.x;
    const y = -pick.aligned.y;
    steps.push({ pl, sym, x, y, rot: pick.rot });
    const extent = partExtent(sym, x, y, pick.rot);
    steps[steps.length - 1].extent = extent;
    cursor = extent.x2 + BANK_GAP;
  }
  let bbox = null;
  for (const s of steps) bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  return { steps, bbox };
}

/**
 * Hub-and-satellites: ONE multi-pin part (a regulator, a connector, a
 * push-button) plus two-pin satellites that each share exactly one net with
 * it — the caps on VIN/VOUT, a crystal's load caps, an ESD array, a gate RC.
 * Human drawing convention: every satellite sits beside the anchor pin it
 * belongs to, its own shared pin facing the anchor, so the router draws one
 * short wire per satellite instead of a port/label.
 * Returns { anchor, sats, satNet } or null.
 */
function blockHub(members) {
  const isMulti = (pl) => Object.keys(pl.part.pins || {}).length > 2;
  const anchors = members.filter(isMulti);
  if (anchors.length !== 1) return null;
  const anchor = anchors[0];
  const sats = members.filter((pl) => pl !== anchor);
  // an IC's decoupling bank can be a dozen caps: allow up to 16 satellites
  // (they stack beside their anchor pins, so height grows but stays readable)
  if (sats.length < 1 || sats.length > 16) return null;
  const anchorNets = new Set(Object.values(anchor.part.pins || {}));
  const satNet = new Map();
  for (const s of sats) {
    const nets = Object.values(s.part.pins || {});
    if (nets.length !== 2 || !s.sym || s.sym.pins.length !== 2) return null;
    const shared = nets.find((n) => anchorNets.has(n) && !/^(NC|DNC\d*)$/i.test(n));
    if (!shared) return null;
    satNet.set(s, shared);
  }
  return { anchor, sats, satNet };
}

/** Lay a hub block: anchor at the origin, satellites beside their anchor pins. */
function layoutHub(hub) {
  const { anchor, sats, satNet } = hub;
  const snap10 = (v) => Math.round(v / 10) * 10;

  const aRot = anchor.rotation || 0;
  const aExtent = partExtent(anchor.sym, 0, 0, aRot);
  const placed = [{ pl: anchor, sym: anchor.sym, x: 0, y: 0, rot: aRot, extent: aExtent }];
  const boxes = [aExtent];
  const overlaps = (r) => boxes.some((q) => G.rectsOverlap(G.expand(q, 4), r));

  const pinByNet = (pl, net) => {
    const num = Object.keys(pl.part.pins || {}).find((n) => pl.part.pins[n] === net);
    return pl.sym.pins.find((p) => String(p.num) === String(num)) || null;
  };
  // which side of the anchor does this pin open onto (client y-up: big y = top)
  const sideOf = (tip) => {
    const dx = tip.x - (aExtent.x1 + aExtent.x2) / 2;
    const dy = tip.y - (aExtent.y1 + aExtent.y2) / 2;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'top' : 'bottom';
  };
  const bySide = { left: [], right: [], top: [], bottom: [] };
  for (const s of sats) {
    const aPin = pinByNet(anchor, satNet.get(s));
    if (!aPin) return null;
    bySide[sideOf(G.pinTip(aPin, 0, 0, aRot))].push(s);
  }

  for (const side of ['left', 'right', 'top', 'bottom']) {
    let used = 0;   // stacking distance already consumed on this side
    for (const s of bySide[side]) {
      const net = satNet.get(s);
      const sPin = pinByNet(s, net);
      if (!sPin) return null;
      let done = null;
      for (let k = 0; k <= 6 && !done; k += 1) {
        for (const rot of [0, 90, 180, 270]) {
          const rel = partExtent(s.sym, 0, 0, rot);
          const rTip = G.rotate(sPin.x, sPin.y, rot);
          // the shared pin must point TOWARD the anchor: a satellite on the
          // anchor's left needs its pin on its right edge, and so on. (The
          // four tests were inverted, so no satellite ever faced the anchor
          // and real IC + decoupling blocks never formed a hub.)
          const px = s.sym.pins.map((p) => G.rotate(p.x, p.y, rot).x);
          const py = s.sym.pins.map((p) => G.rotate(p.x, p.y, rot).y);
          const facing = side === 'left' ? rTip.x >= Math.max(...px) - 0.01
            : side === 'right' ? rTip.x <= Math.min(...px) + 0.01
              : side === 'top' ? rTip.y <= Math.min(...py) + 0.01
                : rTip.y >= Math.max(...py) - 0.01;
          if (!facing) continue;
          const aPin = pinByNet(anchor, net);
          const aTip = G.pinTip(aPin, 0, 0, aRot);
          const stack = used + k * ((side === 'left' || side === 'right')
            ? (rel.y2 - rel.y1) : (rel.x2 - rel.x1) + T.HUB_STACK_GAP);
          const target = side === 'left' ? { x: aTip.x - T.HUB_GAP, y: aTip.y + stack }
            : side === 'right' ? { x: aTip.x + T.HUB_GAP, y: aTip.y + stack }
              : side === 'top' ? { x: aTip.x + stack, y: aTip.y + T.HUB_GAP }
                : { x: aTip.x + stack, y: aTip.y - T.HUB_GAP };
          const ox = snap10(target.x - rTip.x);
          const oy = snap10(target.y - rTip.y);
          const extent = partExtent(s.sym, ox, oy, rot);
          if (overlaps(extent)) continue;
          done = { pl: s, sym: s.sym, x: ox, y: oy, rot, extent };
          break;
        }
      }
      if (!done) return null;
      placed.push(done);
      boxes.push(done.extent);
      used += (side === 'left' || side === 'right'
        ? (done.extent.y2 - done.extent.y1) : (done.extent.x2 - done.extent.x1)) + T.HUB_STACK_GAP;
    }
  }
  let bbox = null;
  for (const s of placed) bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  return { steps: placed, bbox };
}

/**
 * Crystal + load caps: exactly three two-pin parts forming a triangle — X
 * joins live nets A and B, C1 hangs A→shunt, C2 hangs B→shunt (the shunt is a
 * declared ground). Human drawing: the crystal horizontal on top, one load
 * cap below each of its pins, shunt pins down to a shared ground rail.
 * Returns { anchor, caps: [{pl, liveNet, xTipSide}] } or null.
 */
function blockCrystal(design, members) {
  if (members.length !== 3) return null;
  const byNet = new Map();
  for (const pl of members) {
    const nets = Object.values(pl.part.pins || {});
    if (nets.length !== 2 || !pl.sym || pl.sym.pins.length !== 2) return null;
    for (const n of new Set(nets)) {
      if (!byNet.has(n)) byNet.set(n, []);
      byNet.get(n).push(pl);
    }
  }
  if (byNet.size !== 3 || [...byNet.values()].some((l) => l.length !== 2)) return null;
  let shunt = null;
  for (const [net, list] of byNet) {
    const down = design.powerNets && design.powerNets.get(net) === 'down';
    if (down || /GND|VSS/i.test(net)) shunt = net;
  }
  if (!shunt) return null;
  const anchor = members.find((pl) => !Object.values(pl.part.pins || {}).includes(shunt));
  if (!anchor) return null;
  const caps = members.filter((pl) => pl !== anchor);
  const live = [...byNet.keys()].filter((n) => n !== shunt);
  if (live.length !== 2) return null;
  // each cap owns one live net; both live nets must belong to the anchor
  const capOf = (net) => caps.find((pl) => Object.values(pl.part.pins || {}).includes(net));
  if (!capOf(live[0]) || !capOf(live[1]) || capOf(live[0]) === capOf(live[1])) return null;
  return { anchor, shunt, pairs: live.map((net) => ({ net, cap: capOf(net) })) };
}

/** Lay a crystal block: crystal horizontal on top, one cap below each pin. */
function layoutCrystal(blk) {
  const { anchor, pairs } = blk;
  const snap10 = (v) => Math.round(v / 10) * 10;

  const aPins = anchor.sym.pins;
  let aRot = null;
  let tips = null;
  // the anchor may be drawn with horizontal OR vertical pins: try all four
  // orientations and keep the one whose two pins are collinear horizontally
  for (const rot of [0, 90, 180, 270]) {
    const t = aPins.map((p) => G.pinTip(p, 0, 0, rot));
    if (Math.abs(t[0].y - t[1].y) < EPS && Math.abs(t[0].x - t[1].x) > EPS) { aRot = rot; tips = t; break; }
  }
  if (aRot === null) return null;
  const aNetL = anchor.part.pins[aPins[tips[0].x < tips[1].x ? 0 : 1].num];
  const placed = [{ pl: anchor, sym: anchor.sym, x: 0, y: 0, rot: aRot, extent: partExtent(anchor.sym, 0, 0, aRot) }];
  const boxes = [placed[0].extent];
  for (const { net, cap } of pairs) {
    const side = net === aNetL ? tips[0] : tips[1];
    const pinByNet = (pl, n) => {
      const num = Object.keys(pl.part.pins || {}).find((k) => pl.part.pins[k] === n);
      return pl.sym.pins.find((p) => String(p.num) === String(num)) || null;
    };
    const cPin = pinByNet(cap, net);
    if (!cPin || !pinByNet(cap, blk.shunt)) return null;
    let done = null;
    for (const dx of [0, -60, 60, -120, 120, -180, 180]) {
      if (done) break;
      for (const rot of [0, 90, 180, 270]) {
        const rTip = G.pinTip(cPin, 0, 0, rot);
        const cPins = cap.sym.pins;
        const t = cPins.map((p) => G.pinTip(p, 0, 0, rot));
        // the cap must stand VERTICAL with its shared pin on top
        if (Math.abs(t[0].x - t[1].x) > 0.01) continue;
        if (Math.abs(rTip.y - Math.max(t[0].y, t[1].y)) > 0.01) continue;
        const target = { x: side.x + dx, y: side.y - T.HUB_GAP };
        const ox = snap10(target.x - rTip.x);
        const oy = snap10(target.y - rTip.y);
        const extent = partExtent(cap.sym, ox, oy, rot);
        if (boxes.some((q) => G.rectsOverlap(G.expand(q, 4), extent))) continue;
        done = { pl: cap, sym: cap.sym, x: ox, y: oy, rot, extent };
        break;
      }
    }
    if (!done) return null;
    placed.push(done);
    boxes.push(done.extent);
  }
  let bbox = null;
  for (const s of placed) bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  return { steps: placed, bbox };
}

/**
 * Try every catalog pattern on a SUBSET of a mixed block (the compositional
 * equivalent of picking the closest slide layout): chain, bank, hub, crystal.
 * Returns { steps, bbox, memberIds, power } or null.
 */
function tryPatternsOn(design, members) {
  if (members.length < 2) return null;
  // callers pass PLACEMENTS ({part, sym}); a raw design part has no `.part`
  if (!members.every((pl) => pl && pl.part && pl.sym && Array.isArray(pl.sym.pins))) return null;
  const byId = new Map(members.map((pl) => [pl.part.id, pl]));
  if (byId.size !== members.length) return null;
  const pack = (g, power) => g && {
    steps: g.steps, bbox: g.bbox,
    memberIds: g.steps.map((s) => s.pl.part.id),
    power: !!power
  };
  const chains = blockChains(design, members);
  if (chains) {
    const out = [];
    const shared = [];
    for (const chain of chains) {
      const groundTop = design.powers[chain.top] === 'down';
      const groundBottom = design.powers[chain.bottom] === 'down';
      const supplyBottom = design.powers[chain.bottom] === 'up';
      const supplyTop = design.powers[chain.top] === 'up';
      let c = chain;
      if ((groundTop && !groundBottom) || (supplyBottom && !supplyTop)) c = reverseChain(c);
      const g = layoutChain(c, byId);
      if (!g) { out.length = 0; break; }
      shared.push(...c.shared);
      out.push(g);
    }
    if (out.length) {
      return { groups: out.map((g) => pack(g)), memberIds: members.map((pl) => pl.part.id), shared };
    }
  }
  const bank = blockBank(design, members);
  if (bank) {
    const g = layoutBank(bank, byId);
    if (g) {
      const shared = bank.common ? [bank.common] : [bank.north, bank.south];
      return { groups: [pack(g, shared.some((n) => n && design.powers && design.powers[n]))], memberIds: members.map((pl) => pl.part.id) };
    }
  }
  const hub = blockHub(members);
  if (hub) {
    const g = layoutHub(hub);
    if (g) return { groups: [pack(g)], memberIds: members.map((pl) => pl.part.id) };
  }
  const cry = blockCrystal(design, members);
  if (cry) {
    const g = layoutCrystal(cry);
    if (g) return { groups: [pack(g)], memberIds: members.map((pl) => pl.part.id) };
  }
  const sb = blockSeriesBank(design, members);
  if (sb) {
    const g = layoutSeriesBank(sb);
    if (g) return { groups: [pack(g)], memberIds: members.map((pl) => pl.part.id) };
  }
  const br = blockBridge(members);
  if (br) {
    const g = layoutBridge(br);
    if (g) return { groups: [pack(g)], memberIds: members.map((pl) => pl.part.id) };
  }
  const la = blockLinkArray(members);
  if (la) {
    const g = layoutLinkArray(la);
    if (g) return { groups: [pack(g)], memberIds: members.map((pl) => pl.part.id) };
  }
  return null;
}

/**
 * Composite placement: pattern groups stack DOWNWARD below the parts that
 * stay put (the title strip lives on the top edge), left-aligned to the
 * content; the frame wraps everything and keeps its top edge. The block is
 * only re-laid while the composed frame stays within the area gate (1.45×
 * when a group is a supply/ground bank, else 1.10×) — otherwise the generic
 * placement survives untouched.
 */
function placeComposite(block, pls, groups) {
  const moved = new Set();
  groups.forEach((g) => g.memberIds.forEach((id) => moved.add(id)));
  // snapshot first: a rejected composition must leave the generic placement
  // EXACTLY as it was (moving parts and then not updating the frame corrupts
  // the block)
  const snapshot = pls.map((pl) => ({ pl, x: pl.x, y: pl.y, rotation: pl.rotation, extent: Object.assign({}, pl.extent) }));
  const restore = () => {
    for (const s of snapshot) {
      s.pl.x = s.x; s.pl.y = s.y; s.pl.rotation = s.rotation; s.pl.extent = s.extent;
    }
  };
  let restBox = null;
  for (const pl of pls) {
    if (moved.has(pl.part.id)) continue;
    restBox = restBox ? unionRect(restBox, pl.extent) : pl.extent;
  }
  const areaOf = (r) => Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);
  const oldArea = areaOf(block.rect);
  let box = restBox;
  let top = restBox ? restBox.y1 - COL_GAP : 0;   // y of the next group's TOP edge
  for (const g of groups) {
    for (const g2 of g.groups) {
      const dx = (restBox ? restBox.x1 : 0) - g2.bbox.x1;
      const dy = top - g2.bbox.y2;
      let gbox = null;
      for (const st of g2.steps) {
        st.pl.x = grid(st.x + dx);
        st.pl.y = grid(st.y + dy);
        st.pl.rotation = st.rot;
        st.pl.extent = partExtent(st.sym, st.pl.x, st.pl.y, st.pl.rotation);
        gbox = gbox ? unionRect(gbox, st.pl.extent) : st.pl.extent;
      }
      box = box ? unionRect(box, gbox) : gbox;
      top = gbox.y1 - COL_GAP;
    }
  }
  if (!box) { restore(); return false; }
  const rect = {
    x1: grid(box.x1 - PAD), y1: grid(box.y1 - PAD),
    x2: grid(box.x2 + PAD), y2: block.rect.y2
  };
  const gate = groups.some((g) => g.power) ? 1.45 : 1.10;
  if (areaOf(rect) > oldArea * gate) { restore(); return false; }
  block.rect = rect;
  return true;
}

/**
 * Absorb ONE hub out of a mixed block: pick a multi-pin part and the two-pin
 * parts that share a net with it (its caps, ESD, gate RC) even when the block
 * holds other ICs. Without this, a block with two or more ICs never matches
 * the whole-block hub and falls back to the generic grid.
 * Returns { steps, bbox, memberIds } or null.
 */
function findHubSubset(members) {
  const isMulti = (pl) => Object.keys(pl.part.pins || {}).length > 2;
  const twoPin = (pl) => {
    const nets = Object.values(pl.part.pins || {});
    return nets.length === 2 && pl.sym && pl.sym.pins.length === 2;
  };
  const anchors = members.filter(isMulti);
  if (!anchors.length) return null;
  let best = null;
  for (const a of anchors) {
    const aNets = new Set(Object.values(a.part.pins || {}));
    const sats = members.filter((pl) => pl !== a && twoPin(pl)
      && Object.values(pl.part.pins || {}).some((n) => aNets.has(n) && !/^(NC|DNC\d*)$/i.test(n)));
    if (!sats.length) continue;
    const hub = blockHub([a, ...sats]);
    if (!hub) continue;
    const g = layoutHub(hub);
    if (!g) continue;
    const cand = { steps: g.steps, bbox: g.bbox, memberIds: [a, ...sats].map((pl) => pl.part.id) };
    if (!best || cand.memberIds.length > best.memberIds.length) best = cand;
  }
  return best;
}

/**
 * Two-anchor bridge: TWO multi-pin parts with two-pin parts strung between
 * them — AC-coupling caps between a codec and an amplifier, series resistors
 * between a PHY and a connector. A bridge part touches one anchor's net on
 * one pin and the other anchor's net on the other; at least one such link
 * must span the two anchors, otherwise this is not a bridge.
 * Returns { left, right, links } or null.
 */
function blockBridge(members) {
  const isMulti = (pl) => Object.keys(pl.part.pins || {}).length > 2;
  const anchors = members.filter(isMulti);
  if (anchors.length !== 2) return null;
  const bridges = members.filter((pl) => !isMulti(pl));
  if (!bridges.length || bridges.length > 12) return null;
  const netsOf = (pl) => new Set(Object.values(pl.part.pins || {}));
  const na = netsOf(anchors[0]);
  const nb = netsOf(anchors[1]);
  const links = [];
  for (const b of bridges) {
    const nets = [...netsOf(b)];
    if (nets.length !== 2 || !b.sym || b.sym.pins.length !== 2) return null;
    links.push({ b, toA: nets.filter((n) => na.has(n)), toB: nets.filter((n) => nb.has(n)) });
  }
  if (!links.some((l) => l.toA.length && l.toB.length)) return null;
  return { left: anchors[0], right: anchors[1], links };
}

/** Lay a bridge block: anchors side by side, bridges stacked in the corridor. */
function layoutBridge(blk) {
  const snap10 = (v) => Math.round(v / 10) * 10;
  const { left, right, links } = blk;
  // anchors keep their declared orientation; pins facing the corridor either
  // way — the router handles the short hop
  const lRot = left.rotation || 0;
  const rRot = right.rotation || 0;
  const lExt = partExtent(left.sym, 0, 0, lRot);
  const rExt = partExtent(right.sym, 0, 0, rRot);
  const bExts = links.map((l) => l.b.extent || partExtent(l.b.sym, 0, 0, 0));
  const corridor = Math.max(...bExts.map((e) => e.x2 - e.x1)) + 2 * T.HUB_GAP;
  const rx = snap10(lExt.x2 + corridor - rExt.x1);
  if (!Number.isFinite(rx) || rx <= 0) return null;
  const placed = [
    { pl: left, sym: left.sym, x: 0, y: 0, rot: lRot, extent: lExt },
    { pl: right, sym: right.sym, x: rx, y: 0, rot: rRot, extent: partExtent(right.sym, rx, 0, rRot) }
  ];
  const cx = (lExt.x2 + placed[1].extent.x1) / 2;   // corridor centre
  const n = links.length;
  for (let i = 0; i < n; i += 1) {
    const { b, toA } = links[i];
    let done = null;
    for (const rot of [0, 90, 180, 270]) {
      const t = b.sym.pins.map((p) => G.pinTip(p, 0, 0, rot));
      if (Math.abs(t[0].y - t[1].y) > 0.01) continue;          // horizontal bridge
      const pinA = Object.keys(b.part.pins || {}).find((k) => toA.includes(b.part.pins[k]));
      if (!pinA) continue;
      const pA = b.sym.pins.find((p) => String(p.num) === String(pinA));
      const rA = G.pinTip(pA, 0, 0, rot);
      // A-side pin must be the LEFT end (so the signal reads left→right)
      if (Math.abs(rA.x - Math.min(t[0].x, t[1].x)) > 0.01) continue;
      const y = Math.round(((i - (n - 1) / 2) * T.HUB_STACK_GAP * 2) / 10) * 10;
      const local = partExtent(b.sym, 0, 0, rot);
      const lc = { x: (local.x1 + local.x2) / 2, y: (local.y1 + local.y2) / 2 };
      const ox = snap10(cx - lc.x);
      const oy = snap10(y - lc.y);
      done = { pl: b, sym: b.sym, x: ox, y: oy, rot, extent: partExtent(b.sym, ox, oy, rot) };
      break;
    }
    if (!done) return null;
    placed.push(done);
  }
  let bbox = null;
  for (const s of placed) bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  return { steps: placed, bbox };
}

/**
 * Independent link array: a block of two-pin parts where NO net is shared by
 * two members — DNP option straps (rail A ↔ rail B), AC-coupling arrays, a
 * set of termination links. Nothing groups them, but the grid scatters them;
 * the tidy answer is one column of horizontal links with their ends aligned.
 * Returns { links } or null.
 */
function blockLinkArray(members) {
  if (members.length < 2) return null;
  const ok = members.every((pl) => Object.values(pl.part.pins || {}).length === 2
    && pl.sym && pl.sym.pins.length === 2);
  if (!ok) return null;
  const count = new Map();
  for (const pl of members) {
    for (const n of new Set(Object.values(pl.part.pins || {}))) {
      if (/^(NC|DNC\d*)$/i.test(n)) continue;
      count.set(n, (count.get(n) || 0) + 1);
    }
  }
  if ([...count.values()].some((c) => c > 1)) return null;   // shared nets: chain/bank territory
  return { links: members };
}

/** Lay a link array: one column, every link horizontal, ends aligned. */
function layoutLinkArray(blk) {
  const snap10 = (v) => Math.round(v / 10) * 10;
  const placed = [];
  let railY = 0;
  for (const pl of blk.links) {
    let done = null;
    for (const rot of [0, 90, 180, 270]) {
      const t = pl.sym.pins.map((p) => G.pinTip(p, 0, 0, rot));
      if (Math.abs(t[0].y - t[1].y) > 0.01) continue;           // horizontal link
      const local = partExtent(pl.sym, 0, 0, rot);
      const lc = { x: (local.x1 + local.x2) / 2, y: (local.y1 + local.y2) / 2 };
      const ox = snap10(-lc.x);
      const oy = snap10(railY - lc.y);
      done = { pl, sym: pl.sym, x: ox, y: oy, rot, extent: partExtent(pl.sym, ox, oy, rot) };
      break;
    }
    if (!done) return null;
    placed.push(done);
    railY = done.extent.y1 - T.HUB_STACK_GAP;
  }
  let bbox = null;
  for (const s of placed) bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  return { steps: placed, bbox };
}

/**
 * Series + shunt stage (a DCDC/filter output): a RAIL net carries shunt parts
 * (their other pin is a declared supply/ground or another shared net) plus one
 * or more series elements feeding it (their other pin belongs to them alone —
 * the SW node, an antenna feed, a filter input).
 *
 * Roles are read from the topology, never from refdes or part numbers:
 *   shunt  — its other net is power/ground or has ≥2 members
 *   series — its other net has exactly one member (itself)
 * Returns { rail, shunts, series } or null.
 */
function blockSeriesBank(design, members) {
  if (members.length < 3) return null;
  const twoPin = members.filter((pl) => Object.values(pl.part.pins || {}).length === 2
    && pl.sym && pl.sym.pins.length === 2);
  if (twoPin.length !== members.length) return null;
  const byNet = new Map();
  for (const pl of twoPin) {
    for (const n of new Set(Object.values(pl.part.pins || {}))) {
      if (/^(NC|DNC\d*)$/i.test(n)) continue;
      if (!byNet.has(n)) byNet.set(n, []);
      byNet.get(n).push(pl);
    }
  }
  const other = (pl, net) => Object.values(pl.part.pins || {}).find((n) => n && n !== net) || null;
  const power = (n) => !!(design.powerNets && design.powerNets.get(n)) || !!(design.powers && design.powers[n]);
  let best = null;
  for (const [rail, parts] of byNet) {
    if (parts.length < 3) continue;
    const shunts = [];
    const series = [];
    for (const pl of parts) {
      const o = other(pl, rail);
      if (!o) continue;
      const shared = (byNet.get(o) || []).length >= 2;
      if (power(o) || shared) shunts.push(pl); else series.push(pl);
    }
    if (!series.length || shunts.length < 2) continue;
    if (series.length + shunts.length !== parts.length) continue;
    const cand = { rail, shunts, series };
    if (!best || shunts.length > best.shunts.length) best = cand;
  }
  return best;
}

/** Lay a series+shunt stage: series column on the left feeding a shunt row. */
function layoutSeriesBank(blk) {
  const snapL = (v) => Math.round(v / 10) * 10;
  const { rail, shunts, series } = blk;
  const pinByNet = (pl, n) => {
    const num = Object.keys(pl.part.pins || {}).find((k) => pl.part.pins[k] === n);
    return pl.sym.pins.find((p) => String(p.num) === String(num)) || null;
  };
  const placed = [];
  // ---- shunt row: every shunt vertical, its rail pin on top at y = 0
  let cursor = 0;
  for (const q of shunts) {
    const qPin = pinByNet(q, rail);
    if (!qPin) return null;
    let done = null;
    for (const rot of [0, 90, 180, 270]) {
      const t = q.sym.pins.map((p) => G.pinTip(p, 0, 0, rot));
      if (Math.abs(t[0].x - t[1].x) > 0.01) continue;                     // must stand vertical
      if (Math.abs(G.pinTip(qPin, 0, 0, rot).y - Math.max(t[0].y, t[1].y)) > 0.01) continue;
      const rTip = G.pinTip(qPin, 0, 0, rot);
      const ox = snapL(cursor - rTip.x);
      const oy = snapL(0 - rTip.y);
      done = { pl: q, sym: q.sym, x: ox, y: oy, rot, extent: partExtent(q.sym, ox, oy, rot) };
      break;
    }
    if (!done) return null;
    placed.push(done);
    cursor = done.extent.x2 + T.BANK_GAP;
  }
  const rowLeft = placed.reduce((m, s) => Math.min(m, s.extent.x1), Infinity);
  // ---- series column: each element horizontal, its rail pin pointing right
  const entryX = rowLeft - T.BANK_GAP;
  let sy = 0;
  for (const s of series) {
    const sPin = pinByNet(s, rail);
    if (!sPin) return null;
    let done = null;
    for (const rot of [0, 90, 180, 270]) {
      const t = s.sym.pins.map((p) => G.pinTip(p, 0, 0, rot));
      if (Math.abs(t[0].y - t[1].y) > 0.01) continue;                     // must lie horizontal
      const rTip = G.pinTip(sPin, 0, 0, rot);
      if (Math.abs(rTip.x - Math.max(t[0].x, t[1].x)) > 0.01) continue;    // rail pin on the RIGHT
      const ox = snapL(entryX - rTip.x);
      const oy = snapL(sy - rTip.y);
      done = { pl: s, sym: s.sym, x: ox, y: oy, rot, extent: partExtent(s.sym, ox, oy, rot) };
      break;
    }
    if (!done) return null;
    placed.push(done);
    sy -= (done.extent.y2 - done.extent.y1) + T.HUB_STACK_GAP;
  }
  let bbox = null;
  for (const s of placed) bbox = bbox ? unionRect(bbox, s.extent) : s.extent;
  return { steps: placed, bbox };
}

/**
 * Mixed block: the block as a whole is neither a chain nor a bank, but a
 * SUBSET of its two-pin members is (the decoupling caps beside an IC). Find
 * the disjoint banks, largest first; each comes back already laid out.
 */
function findSubBanks(design, pls) {
  const eligible = pls.filter((pl) => {
    const nets = Object.values(pl.part.pins || {});
    return nets.length === 2 && pl.sym && pl.sym.pins.length === 2;
  });
  if (eligible.length < 2 || eligible.length > 8) return [];
  const byNet = new Map();
  for (const pl of eligible) {
    for (const n of new Set(Object.values(pl.part.pins))) {
      if (/^(NC|DNC\d*)$/i.test(n)) continue;
      if (!byNet.has(n)) byNet.set(n, []);
      byNet.get(n).push(pl);
    }
  }
  const seen = new Set();
  const cands = [];
  for (const list of byNet.values()) {
    if (list.length < 2) continue;
    const key = list.map((pl) => pl.part.id).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const bank = blockBank(design, list);
    if (!bank) continue;
    const g = layoutBank(bank, null);
    if (!g) continue;
    // a bank tied to a declared supply/ground is a decoupling bank: its row is
    // worth a larger frame because the router can then collapse the shared
    // side into one rail + one flag
    const shared = bank.common ? [bank.common] : [bank.north, bank.south];
    const power = shared.some((n) => n && design.powers && design.powers[n]);
    cands.push({ bank, members: list, g, size: list.length, power });
  }
  cands.sort((a, b) => b.size - a.size
    || a.members[0].part.id.localeCompare(b.members[0].part.id));
  const used = new Set();
  const out = [];
  for (const c of cands) {
    if (c.members.some((pl) => used.has(pl.part.id))) continue;
    if (c.members.length === pls.length) continue;   // whole-block path owns it
    for (const pl of c.members) used.add(pl.part.id);
    out.push(c);
  }
  return out;
}

/**
 * Lay each sub-bank as a row beside the parts that stay put, try both anchors
 * (right of them / above them), and keep the smaller block. The frame is
 * recomputed from the resulting parts, so vacated space is reclaimed; a block
 * that would grow by more than SUB_GATE keeps its generic placement.
 */
function placeSubBanks(pls, banks, block) {
  const bankIds = new Set();
  for (const b of banks) for (const pl of b.members) bankIds.add(pl.part.id);
  let restBox = null;
  for (const pl of pls) {
    if (bankIds.has(pl.part.id)) continue;
    restBox = restBox ? unionRect(restBox, pl.extent) : pl.extent;
  }
  if (!restBox) return 0;

  const areaOf = (r) => Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);
  const oldArea = areaOf(block.rect);

  // anchor the rows to the right of the rest, or below it (the title strip
  // now sits on the top edge, so the space underneath is free)
  let best = null;
  for (const mode of ['right', 'below']) {
    const steps = [];
    let box = restBox;
    let cursorX = restBox.x2 + BANK_GAP;
    let cursorY = restBox.y1 - BANK_GAP;
    for (const b of banks) {
      const g = b.g;
      const ox = mode === 'right' ? cursorX - g.bbox.x1 : restBox.x1 - g.bbox.x1;
      const oy = mode === 'right' ? restBox.y1 - g.bbox.y1 : cursorY - g.bbox.y2;
      let bankBox = null;
      for (const s of g.steps) {
        const x = grid(s.x + ox);
        const y = grid(s.y + oy);
        const extent = partExtent(s.sym, x, y, s.rot);
        steps.push({ pl: s.pl, x, y, rot: s.rot, extent });
        bankBox = bankBox ? unionRect(bankBox, extent) : extent;
      }
      box = unionRect(box, bankBox);
      if (mode === 'right') cursorX = bankBox.x2 + BANK_GAP;
      else cursorY = bankBox.y1 - BANK_GAP;
    }
    if (!best || areaOf(box) < areaOf(best.box)) best = { mode, steps, box };
  }
  if (!best) return 0;

  const rect = {
    x1: grid(best.box.x1 - SUB_PAD),
    y1: grid(best.box.y1 - SUB_PAD),
    x2: grid(best.box.x2 + SUB_PAD),
    y2: grid(best.box.y2 + SUB_PAD + TITLE_H)
  };
  if (process.env.SCH_PATTERN_DEBUG) {
    console.error(`SUB-BANK "${block.title}" mode=${best.mode} area ${oldArea.toFixed(0)} → ${areaOf(rect).toFixed(0)}`
      + ` (${(areaOf(rect) / oldArea).toFixed(2)}×)`);
  }
  // decoupling rows are accepted up to 1.45×: one rail + one flag per supply
  // and per ground is worth more than the area, and the user asked for the
  // caps to sit side by side; other banks keep the conservative gate
  const gate = banks.some((b) => b.power) ? 1.45 : SUB_GATE;
  if (areaOf(rect) > oldArea * gate) return 0;

  for (const p of best.steps) {
    p.pl.x = p.x;
    p.pl.y = p.y;
    p.pl.rotation = p.rot;
    p.pl.extent = p.extent;
  }
  block.rect = rect;
  return 1;
}

/** Pack already-laid chains/banks side by side and replace the block frame. */
function placeWholeBlock(laid, block) {
  let cursor = 0;
  let box = null;
  for (const g of laid) {
    const dx = cursor - g.bbox.x1;
    for (const s of g.steps) {
      s.x += dx;
      s.extent = partExtent(s.sym, s.x, s.y, s.rot);
      box = box ? unionRect(box, s.extent) : s.extent;
    }
    cursor = g.bbox.x2 + dx + COL_GAP;
  }
  if (!box) return false;

  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const cx = (block.rect.x1 + block.rect.x2) / 2;
  const rect = {
    x1: grid(cx - w / 2 - PAD),
    y1: grid(block.rect.y2 - (TITLE_H + 2 * PAD + h)),  // keep the top edge
    x2: grid(cx + w / 2 + PAD),
    y2: block.rect.y2
  };
  // a pattern that would touch a neighbouring block is resolved by the
  // row re-pack below (blocks are pushed apart and their parts move with them)

  const ox = rect.x1 + PAD - box.x1;
  const oy = rect.y2 - TITLE_H - PAD - box.y2;          // title strip at the top
  for (const g of laid) {
    for (const s of g.steps) {
      s.pl.x = grid(s.x + ox);
      s.pl.y = grid(s.y + oy);
      s.pl.rotation = s.rot;
      s.pl.extent = partExtent(s.sym, s.pl.x, s.pl.y, s.pl.rotation);
    }
  }
  // the frame must wrap the SNAPPED extents, not the pre-snap box
  let frame = null;
  for (const g of laid) for (const s of g.steps) frame = frame ? unionRect(frame, s.pl.extent) : s.pl.extent;
  block.rect = {
    x1: Math.min(rect.x1, frame.x1),
    y1: Math.min(rect.y1, frame.y1 - PAD),
    x2: Math.max(rect.x2, frame.x2),
    y2: Math.max(rect.y2, frame.y2 + PAD + TITLE_H)
  };
  return true;
}

/**
 * Apply pattern macros to one candidate layout. Mutates `placements` and
 * `blocks`; returns { changed, subBanks, portNets } — the number of blocks
 * re-laid, how many of those were mixed-block sub-banks (the builder retries
 * without them when routing cannot find a clean path), and the chain-internal
 * nets that should take a sideways port.
 */
function applyPatterns(design, placements, blocks, options) {
  const opt = options || {};
  const portNets = new Set();
  const byId = new Map(placements.map((pl) => [pl.part.id, pl]));
  if (byId.size !== placements.length) return { changed: 0, subBanks: 0, portNets };
  let changed = 0;
  let subBanks = 0;
  for (const block of blocks) {
    const memberSet = new Set(block.members || []);
    const pls = placements.filter((pl) => memberSet.has(pl.part.id) && pl.sheet === block.sheet);
    if (pls.length < 2) continue;

    // 1. whole block is a pure two-pin chain
    let laid = null;
    const chains = blockChains(design, pls);
    if (chains) {
      const out = [];
      let ok = true;
      for (const chain of chains) {
        // orient every chain: ground south, supply north (when an end says so)
        const groundTop = design.powers[chain.top] === 'down';
        const groundBottom = design.powers[chain.bottom] === 'down';
        const supplyTop = design.powers[chain.top] === 'up';
        const supplyBottom = design.powers[chain.bottom] === 'up';
        let c = chain;
        if ((groundTop && !groundBottom) || (supplyBottom && !supplyTop)) c = reverseChain(c);
        const g = layoutChain(c, byId);
        if (!g) { ok = false; break; }
        for (const n of c.shared) portNets.add(n);
        out.push(g);
      }
      if (ok && out.length) laid = out;
    }

    // 2. whole block is a parallel (decoupling) or pull-up/down bank
    if (!laid) {
      const bank = blockBank(design, pls);
      if (bank) {
        const g = layoutBank(bank, byId);
        if (g) {
          laid = [g];
          if (process.env.SCH_PATTERN_DEBUG && chains) {
            console.error(`PATTERN "${block.title}": chain layout failed → whole-block bank`);
          }
        }
      }
    }

    // 2b. hub-and-satellites: one multi-pin part + its caps/ESD/RC satellites
    if (!laid) {
      const hub = blockHub(pls);
      if (hub) {
        const g = layoutHub(hub);
        if (g) laid = [g];
      }
    }

    // 2c. crystal + load caps (a three-part triangle on a declared ground)
    if (!laid) {
      const cry = blockCrystal(design, pls);
      if (cry) {
        const g = layoutCrystal(cry);
        if (g) laid = [g];
      }
    }

    if (laid) {
      if (placeWholeBlock(laid, block)) changed += 1;
      continue;
    }

    // 3. composite block: absorb pattern groups one at a time — the caps
    // bank, then a hub, then a crystal, then a chain — until nothing in the
    // catalog matches. The builder retries a candidate without this pass when
    // it leaves the router unable to find a clean path (see build.js).
    if (opt.noSubBanks) continue;
    let rest = pls.slice();
    const groups = [];
    for (let guard = 0; guard < 8 && rest.length >= 2; guard += 1) {
      const m = tryPatternsOn(design, rest);
      if (m) {
        groups.push(m);
        if (m.shared) for (const n of m.shared) portNets.add(n);
        const ids = new Set(m.memberIds);
        rest = rest.filter((pl) => !ids.has(pl.part.id));
        continue;
      }
      // the whole remainder matched nothing: a multi-rail decoupling block is
      // several independent banks side by side — absorb the largest one and
      // loop, so each rail still becomes an aligned row
      const hubOnly = findHubSubset(rest);
      if (hubOnly) {
        groups.push({ groups: [{ steps: hubOnly.steps, bbox: hubOnly.bbox }], memberIds: hubOnly.memberIds });
        const ids = new Set(hubOnly.memberIds);
        rest = rest.filter((pl) => !ids.has(pl.part.id));
        continue;
      }
      const banks = findSubBanks(design, rest);
      if (!banks.length) break;
      const b = banks[0];
      groups.push({
        groups: [{ steps: b.g.steps, bbox: b.g.bbox, power: b.power }],
        memberIds: b.members.map((pl) => pl.part.id),
        power: b.power
      });
      const ids = new Set(b.members.map((pl) => pl.part.id));
      rest = rest.filter((pl) => !ids.has(pl.part.id));
    }
    if (!groups.length) continue;
    if (placeComposite(block, pls, groups)) { changed += 1; subBanks += 1; }
  }
  if (changed) repackBlocks(blocks, placements);
  return { changed, subBanks, portNets };
}

/**
 * Keep patterned frames apart: blocks in one sheet are visited in order and a
 * later block is pushed right when its (grown) frame would touch an earlier
 * one. Its parts move with it, so routing sees the same relative geometry.
 */
function repackBlocks(blocks, placements) {
  const byId = new Map(placements.map((pl) => [pl.part.id, pl]));
  const GAP = 100;
  const sheets = [...new Set(blocks.map((b) => b.sheet || 1))];
  for (const sheet of sheets) {
    const list = blocks.filter((b) => (b.sheet || 1) === sheet);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (!G.rectsOverlap(G.expand(a.rect, 20), b.rect)) continue;
        const dx = grid(a.rect.x2 + GAP - b.rect.x1);
        if (dx <= 0) continue;
        b.rect.x1 += dx;
        b.rect.x2 += dx;
        for (const id of b.members || []) {
          const pl = byId.get(id);
          if (!pl || (pl.sheet || 1) !== sheet) continue;
          pl.x += dx;
          pl.extent.x1 += dx;
          pl.extent.x2 += dx;
        }
      }
    }
  }
}

module.exports = {
  applyPatterns, blockChains, blockBank, blockHub, blockCrystal, blockSeriesBank,
  blockBridge, findHubSubset, layoutChain, layoutBank, layoutHub, layoutCrystal,
  layoutSeriesBank, layoutBridge, blockLinkArray, layoutLinkArray,
  findSubBanks, placeSubBanks, tryPatternsOn, PIN_GAP
};
