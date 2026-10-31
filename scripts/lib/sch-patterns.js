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
 * Recognised here (phase 1): a block made only of two-pin parts joined in a
 * chain — LED + series resistor, RC, voltage divider, pull-up ladder. The
 * chain is stacked along Y, supply end north and ground end south, shared pins
 * facing each other with a short wire; outer odd nets get ports from the
 * router. A block whose new frame would touch a neighbour keeps its generic
 * placement, so this pass can never make a sheet worse.
 */
const G = require('./geom');
const { partExtent } = require('./design');

const PIN_GAP = 80;    // wire between two chain members (room for a side port)
const COL_GAP = 120;   // between independent chains in one block
const BANK_GAP = 120;  // between members of a parallel / pull bank row
const PAD = 110;       // frame padding around the chain
const TITLE_H = 60;
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
 * Apply chain macros to one candidate layout. Mutates `placements` and
 * `blocks`; returns { changed, portNets } — the number of blocks re-laid and
 * the chain-internal nets that should take a sideways port.
 */
function applyPatterns(design, placements, blocks) {
  const portNets = new Set();
  const byId = new Map(placements.map((pl) => [pl.part.id, pl]));
  if (byId.size !== placements.length) return { changed: 0, portNets };
  let changed = 0;
  for (const block of blocks) {
    const memberSet = new Set(block.members || []);
    const pls = placements.filter((pl) => memberSet.has(pl.part.id) && pl.sheet === block.sheet);
    if (pls.length < 2) continue;
    const chains = blockChains(design, pls);

    // orient every chain: ground south, supply north (when an end says so)
    const laid = [];
    let ok = true;
    if (chains) {
      for (const chain of chains) {
        const groundTop = design.powers[chain.top] === 'down';
        const groundBottom = design.powers[chain.bottom] === 'down';
        const supplyTop = design.powers[chain.top] === 'up';
        const supplyBottom = design.powers[chain.bottom] === 'up';
        let c = chain;
        if ((groundTop && !groundBottom) || (supplyBottom && !supplyTop)) c = reverseChain(c);
        const g = layoutChain(c, byId);
        if (!g) { ok = false; break; }
        for (const n of c.shared) portNets.add(n);
        laid.push(g);
      }
    } else {
      // star / cycle shapes: a parallel (decoupling) or pull-up/down bank
      const bank = blockBank(design, pls);
      if (!bank) continue;
      const g = layoutBank(bank, byId);
      if (!g) continue;
      laid.push(g);
    }
    if (!ok || !laid.length) continue;

    // chains side by side, tops aligned
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
    if (!box) continue;

    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    const cx = (block.rect.x1 + block.rect.x2) / 2;
    const rect = {
      x1: grid(cx - w / 2 - PAD),
      y1: block.rect.y1,                                  // keep the bottom edge
      x2: grid(cx + w / 2 + PAD),
      y2: grid(block.rect.y1 + TITLE_H + 2 * PAD + h)
    };
    // a pattern that would touch a neighbouring block is resolved by the
    // row re-pack below (blocks are pushed apart and their parts move with them)

    const ox = rect.x1 + PAD - box.x1;
    const oy = rect.y1 + TITLE_H + PAD - box.y1;
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
      y1: Math.min(rect.y1, frame.y1 - PAD - TITLE_H),
      x2: Math.max(rect.x2, frame.x2),
      y2: Math.max(rect.y2, frame.y2 + PAD)
    };
    changed += 1;
  }
  if (changed) repackBlocks(blocks, placements);
  return { changed, portNets };
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

module.exports = { applyPatterns, blockChains, layoutChain, PIN_GAP };
