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

const PIN_GAP = 80;    // wire between two chain members (room for a side port)
const COL_GAP = 120;   // between independent chains in one block
const BANK_GAP = 120;  // between members of a parallel / pull bank row
const PAD = 110;       // frame padding around the chain
const SUB_PAD = 110;   // frame padding around a mixed block (matches the shelf)
const SUB_GATE = 1.10; // sub-bank row accepted only within 10% of the block area
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

    if (laid) {
      if (placeWholeBlock(laid, block)) changed += 1;
      continue;
    }

    // 3. mixed block: absorb the largest two-pin sub-bank (decoupling row).
    // The builder retries a candidate without this step when the row leaves the
    // router unable to find a clean path (see build.js), so it is safe to try.
    if (opt.noSubBanks) continue;
    const subs = findSubBanks(design, pls);
    if (!subs.length) continue;
    if (placeSubBanks(pls, subs, block)) { changed += 1; subBanks += 1; }
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
  applyPatterns, blockChains, blockBank, layoutChain, layoutBank,
  findSubBanks, placeSubBanks, PIN_GAP
};
