'use strict';
/**
 * authoring.js — the OFFICIAL design authoring helpers.
 *
 * Big boards (50–150 parts) are not hand-written as JSON: the agent writes a
 * short generator file (`board.gen.js`) that receives the helper object `A`
 * and returns the design. build.js runs it with `--gen board.gen.js`.
 *
 *   module.exports = (A) => {
 *     A.name('esp32s31-hmi');
 *     A.power('3V3', 'up'); A.power('GND', 'down');
 *     A.block('POWER', { desc: '电源输入与保护' });
 *     A.cap('VBUS', 'GND', '10uF');
 *     A.chip({ id: 'U9', name: 'TG28', pins: { 1: 'VSYS', 2: 'GND' },
 *              footprint: { auto: 'QFN', pins: 20 }, autoNC: true,
 *              pinoutSource: '按 datasheet 手工绘制（用户已确认）' });
 *     A.block('MCU', { desc: '主控' });
 *     A.ic({ id: 'U1', ic: 'STM32F103C8T6', pins: { 1: '3V3' }, autoNC: true });
 *     A.place('J1', [300, 150, 0]);
 *     return A.design();
 *   };
 *
 * Refdes are auto-numbered per prefix when omitted; parts join the current
 * block; connectors (A.conn / designator J) are W003-exempt; `autoNC` maps
 * every unmapped inline/IC pin to "NC".
 */

function createAuthoring() {
  const design = {
    powers: {},
    blocks: [],
    parts: [],
    nets: {},
    pcb: {}
  };
  const counters = {};
  let currentBlock = null;
  let expect_ = null;
  // every id ever handed out (auto-numbered OR explicit) — a later explicit id
  // colliding with an auto one is a hard error at the point of use (report P3)
  const usedIds = new Set();
  const die = (msg) => { throw new Error(msg); };

  const nextRef = (prefix) => {
    counters[prefix] = counters[prefix] || 0;
    let id;
    do {
      counters[prefix] += 1;
      id = `${prefix}${counters[prefix]}`;
    } while (usedIds.has(id));
    return id;
  };

  const joinBlock = (id) => {
    if (currentBlock !== null) design.blocks[currentBlock].parts.push(id);
  };

  const push = (p) => {
    if (usedIds.has(p.id)) die(`duplicate part id "${p.id}"`);
    usedIds.add(p.id);
    design.parts.push(p);
    joinBlock(p.id);
    return p;
  };

  const A = {
    // ------- document level
    name(n) { design.name = n; return A; },
    sheets(n) { design.sheets = n; return A; },
    board(w, h) { if (w || h) design.board = { width: w || 1600, height: h || 1000 }; return A; },
    power(net, dir) { design.powers[net] = dir === 'down' ? 'down' : 'up'; return A; },
    net(net, opts) { design.nets[net] = opts || {}; return A; },
    frame(opts) { design.frame = opts || {}; return A; },
    pcbRules(rules) { design.pcb = Object.assign({}, design.pcb, { rules }); return A; },
    place(id, pos) { design.pcb.place = design.pcb.place || {}; design.pcb.place[id] = pos; return A; },
    pair(a, b) { expect_ = expect_ || {}; expect_.pairs = expect_.pairs || []; expect_.pairs.push([a, b]); return A; },
    expect(obj) { expect_ = Object.assign(expect_ || {}, obj); return A; },
    autoNC() { design.autoNC = true; return A; },

    // ------- blocks: every part after block() joins it
    block(title, opts) {
      const o = opts || {};
      design.blocks.push({ title, desc: o.desc, sheet: o.sheet, parts: [] });
      currentBlock = design.blocks.length - 1;
      return A;
    },

    // ------- generic part (full control)
    part(obj) {
      const p = Object.assign({}, obj);
      if (!p.id) {
        // default prefix from the symbol's own designator (report P3: diodes
        // used to come out as U8)
        const prefix = (p.symbol && typeof p.symbol === 'object' && p.symbol.designator)
          || p.designator || 'U';
        p.id = nextRef(String(prefix).replace(/\?$/, ''));
      }
      return push(p);
    },

    // ------- passives / diodes / leds
    res(net1, net2, value, fp) { return push({ id: nextRef('R'), symbol: 'RES', footprint: fp || 'R0603', value, pins: { 1: net1, 2: net2 } }); },
    cap(net1, net2, value, fp) { return push({ id: nextRef('C'), symbol: 'CAP', footprint: fp || 'C0603', value, pins: { 1: net1, 2: net2 } }); },
    ind(net1, net2, value, fp) { return push({ id: nextRef('L'), symbol: 'IND', footprint: fp || 'L0603', value, pins: { 1: net1, 2: net2 } }); },
    diode(net1, net2, value, fp, opts) {
      const o = opts || {};
      const p = { id: nextRef(o.idPrefix || 'D'), symbol: 'DIODE', footprint: fp || 'SMA', value, pins: { 1: net1, 2: net2 } };
      if (o.role) p.role = o.role;
      return push(p);
    },
    led(netA, netK, value, fp) {
      return push({ id: nextRef('D'), symbol: 'LED', footprint: fp || 'LED0603', value, polarity: { 1: '+', 2: '-' }, pins: { 1: netA, 2: netK } });
    },

    // ------- IC by library entry (official evidence path)
    ic(opts) {
      const o = Object.assign({}, opts);
      if (!o.id) o.id = nextRef('U');
      o.autoNC = o.autoNC !== false;                 // IC parts default to autoNC
      return push(o);
    },

    // ------- chip: inline symbol + footprint (self-build fallback path)
    // `pins` maps pin → NET. `pinNames` maps pin → SYMBOL PIN NAME, so a real
    // IC can have pin 1 named "G" while its net is "PUMP_EN" (report P1).
    // Without pinNames the pin name defaults to the net name. `pins` may also
    // be an array ['num:name:dir:side', …] (explicit spec form).
    chip(opts) {
      const o = Object.assign({}, opts);
      if (!o.id) o.id = nextRef(o.designator || 'U');
      if (usedIds.has(o.id)) die(`duplicate part id "${o.id}" — the id is already taken (explicit id or auto-numbered)`);
      const pinsIn = o.pins || {};
      const pinNames = o.pinNames || null;
      let pinList;
      let netMap;
      if (Array.isArray(pinsIn)) {
        pinList = pinsIn.map((s) => String(s));
        netMap = Object.fromEntries(pinsIn.map((s) => {
          const t = String(s).split(':');
          return [t[0], t[1] || t[0]];
        }));
      } else {
        pinList = Object.entries(pinsIn).map(([num, net]) => `${num}:${(pinNames && pinNames[num]) || net}`);
        netMap = Object.assign({}, pinsIn);
      }
      const symbol = {
        name: o.symbolName || `${o.name || o.id}_SYM`,
        designator: o.designator || 'U',
        pins: pinList
      };
      if (o.pitch) symbol.pitch = o.pitch;
      const p = {
        id: o.id,
        symbol,
        footprint: o.footprint,
        value: o.value,
        name: o.name,
        pins: netMap
      };
      if (o.autoNC !== false) p.autoNC = true;
      if (o.pinoutSource) p.pinoutSource = o.pinoutSource;
      if (o.bridge) p.bridge = 'ok';
      return push(p);
    },

    // ------- connector: W003-exempt by construction
    conn(opts) {
      const o = Object.assign({}, opts);
      if (!o.id) o.id = nextRef('J');
      o.designator = o.designator || 'J';
      o.bridge = 'ok';
      return A.chip(o);
    },

    // ------- output
    design() {
      const out = Object.assign({}, design);
      if (expect_) out.expect = expect_;
      return out;
    }
  };
  return A;
}

module.exports = { createAuthoring };
