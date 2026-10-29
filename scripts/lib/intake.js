'use strict';
/**
 * intake.js — requirement capture, clarification and defaults.
 *
 * The gap this closes: an agent asked to "make a sensor board" has no fixed
 * contract for what it still needs to know, so it either guesses silently or
 * writes a thousand words of prose. Here the requirement form is a fixed
 * schema, every field is one of three tiers, and the mapping from words to
 * recipes is a table — so the agent asks exactly the open questions, applies
 * documented defaults to the rest, and gets a buildable design.json back.
 *
 * Tiers:
 *   required  — no design without it; `check` exits 1 and prints the question
 *   ask       — one question each, with the default it would use; ask once,
 *               together, never serially (round trips cost the user time)
 *   default   — never asked; the default is applied and *reported*, so a human
 *               can veto it at the confirmation gate (docs/intake.md)
 *
 * Selection results are cached (`lib/cache.js`) keyed by the requirement hash,
 * so a repeated request costs one lookup instead of a re-derivation.
 */
const crypto = require('crypto');
const M = require('./merge');
const C = require('./cache');

// ---------------------------------------------------------------- fields
/**
 * tier: required | ask | default
 * get:  read the value out of a requirement object
 * def:  default value (undefined → derived by `infer`)
 * q:    the exact question to ask (zh / en)
 */
const FIELDS = [
  { key: 'name', tier: 'default', def: 'board',
    note: '工程名；缺省 "board"' },
  { key: 'function', tier: 'required',
    q: { zh: '这块板子要实现什么功能？（一句话，含输入与输出，例如“读取 BME280 并通过 UART 上报”）',
         en: 'What must this board do? One line, input → output.' } },
  { key: 'power.input', tier: 'required',
    q: { zh: '输入电源是什么？（电压 + 来源，例如 “5V USB-C” / “12V DC 端子”）',
         en: 'Input supply: voltage and source (e.g. "5V USB-C", "12V DC").' } },
  { key: 'power.rails', tier: 'ask', infer: inferRails,
    q: { zh: '需要哪些内部电源轨？（如 3V3 / 5V；不填按功能推断）',
         en: 'Which internal rails are needed? (blank = inferred from function)' } },
  { key: 'power.current_mA', tier: 'ask', def: 200,
    q: { zh: '整板最大电流大约多少 mA？（决定线宽与是否用 DC-DC）',
         en: 'Rough max board current in mA? (drives track widths / DC-DC choice)' } },
  { key: 'interfaces', tier: 'ask', def: [],
    q: { zh: '对外接口有哪些？（USB-C / UART / I2C / SPI / RS-485 / 按键 / LED…）',
         en: 'External interfaces (USB-C, UART, I2C, SPI, RS-485, keys, LEDs…)?' } },
  { key: 'mcu', tier: 'ask', def: null,
    q: { zh: '有主控吗？型号或系列（如 STM32F103 / ESP32 / 无）',
         en: 'Any MCU? Part or family (STM32F103 / ESP32 / none)?' } },
  { key: 'board.width', tier: 'ask', def: null,
    q: { zh: '板框尺寸（mil 或 mm）有硬性限制吗？（不填由元件数自动扩板）',
         en: 'Hard board size limit? (blank = auto-grow to fit parts)' } },
  { key: 'board.layers', tier: 'ask', def: 2,
    q: { zh: '层数？（本 skill 不布线不铺铜，层数只是记录；>2 层的布线在客户端完成）',
         en: 'Layer count? (this skill never routes or pours — the number is recorded; the copper happens in the client)' } },
  { key: 'schematic.sheets', tier: 'ask', def: 1,
    q: { zh: '原理图：全部电路模块放在同一页，还是按模块分页？（模块多/块 >8 个建议分页；每页内的跨页网络用网络端口连接）',
         en: 'Schematic: all modules on ONE sheet, or split across sheets? (>8 blocks suggest splitting; cross-sheet nets join through net ports)' } },
  { key: 'package', tier: 'default', def: '0603',
    note: '阻容封装偏好：0402 / 0603；默认 0603（DFM 最稳）' },
  { key: 'constraints.differential', tier: 'default', def: [],
    note: '差分对网络名，会写进 expect.pairs 由意图门禁核查' },
  { key: 'constraints.crystal', tier: 'ask', def: null,
    q: { zh: '需要晶振吗？频率（如 8MHz；有 MCU 时默认需要）',
         en: 'Crystal needed? Frequency (default: yes when an MCU is present)' } },
  { key: 'cost.target_usd', tier: 'default', def: null,
    note: 'BOM 目标单价（美元）；当前只做记录，不做选价' },
  { key: 'cost.quantity', tier: 'default', def: 10,
    note: '数量；影响工艺建议，不影响生成' },
  { key: 'environment.temp_c', tier: 'default', def: [-20, 70],
    note: '工作温度区间，用于元件温度等级提示' },
  { key: 'output.schematic_only', tier: 'default', def: false,
    note: 'true → 只出原理图，跳过 PCB' },
  { key: 'recipes', tier: 'default', def: [],
    note: '显式指定 recipe 名单，绕过关键词匹配' }
];

const CONFIRM = [
  '电源方案（输入轨、内部轨、电流）',
  '主控与关键器件选型',
  '对外接口定义与命名',
  '板框尺寸 / 层数',
  '自动修复将写入的内容（差异摘要）'
];

// ---------------------------------------------------------------- features
// Keyword → recipe. `at` is the merge order: power chain first, then the MCU,
// then peripherals, then indicators (blocks follow signal flow).
const FEATURES = [
  { recipe: 'usb-c-power', at: 0, any: ['usb', 'usb-c', 'usbc', 'type-c'], field: 'interfaces' },
  { recipe: 'buck-5v', at: 1, when: needsBuck },
  { recipe: 'ldo-3v3', at: 2, when: needsLdo },
  { recipe: 'power-tree', at: 3, when: needsTree },
  { recipe: 'mcu-min', at: 4, any: ['mcu', 'stm32', 'esp32', 'arduino', 'avr', '单片机', '最小系统', '主控'], fields: ['function', 'mcu'] },
  { recipe: 'crystal', at: 5, when: needsCrystal, fields: ['constraints.crystal', 'mcu'] },
  { recipe: 'i2c-sensor', at: 6, any: ['i2c', 'smbus', 'sensor', '传感器', '温湿度', 'bme280', 'bmp280'], fields: ['interfaces', 'function'] },
  { recipe: 'uart-bridge', at: 7, any: ['uart', 'serial', '串口', 'ttl', 'ch340', 'cp2102'], fields: ['interfaces', 'function'] },
  { recipe: 'rs485', at: 8, any: ['rs485', 'rs-485', '485', 'modbus'], fields: ['interfaces', 'function'] },
  { recipe: 'mosfet-switch', at: 9, any: ['mosfet', 'mos', 'relay', '继电器', '电机', 'motor', 'load switch', '负载', '开关管', '驱动'], fields: ['interfaces', 'function'] },
  { recipe: 'divider', at: 10, any: ['divider', '分压', 'adc 量程', 'battery sense', '电压采样'], fields: ['function', 'interfaces'] },
  { recipe: 'rc-lowpass', at: 11, any: ['低通', 'lowpass', 'low-pass', '滤波', 'filter', 'rc'], fields: ['function', 'interfaces'] },
  { recipe: 'rc-highpass', at: 12, any: ['高通', 'highpass', 'high-pass'], fields: ['function', 'interfaces'] },
  { recipe: 'led-indicator', at: 13, any: ['led', '指示', '状态灯', 'blink', '呼吸'], fields: ['interfaces', 'function'] },
  { recipe: 'button-debounce', at: 14, any: ['button', '按键', '开关输入', 'push', 'debounce', '消抖'], fields: ['interfaces', 'function'] }
];

// ---------------------------------------------------------------- helpers
function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, key, val) {
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = val;
}

/**
 * "3.3V" / "3V3" / "3.3" → "3V3"; "5V USB-C" → "5V"; "VBUS" → "VBUS".
 * Idempotent: a canonical rail name comes back unchanged.
 */
function railName(spec) {
  const s = String(spec).trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (/^V[A-Z0-9]+$/.test(s)) return s;                       // VBUS / VIN / VCC
  if (/^\d+V\d+$/.test(s)) return s;                          // 3V3, 1V8
  if (/^\d+V?$/.test(s)) return `${s.replace(/V$/i, '')}V`;   // 5 → 5V
  const m = s.match(/(\d+(?:\.\d+)?)/);                       // "5VUSB-C" → 5V
  if (!m) return s.replace(/[^A-Z0-9]/g, '') || 'VIN';
  return m[1].includes('.') ? `${m[1].split('.')[0]}V${m[1].split('.')[1]}` : `${m[1]}V`;
}

function volts(spec) {
  const m = String(spec).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Track width for a supply rail, mil. Anchored on the published rule of thumb
 * in docs/development.md (≈1 A per 30 mil on 2 oz); a rail that only feeds
 * logic is better off thin, because a 30 mil trunk cannot pass a row of 0603
 * pads without violating clearance.
 */
function railWidth(current_mA) {
  const c = Number(current_mA) || 0;
  if (c >= 2000) return 40;
  if (c >= 1000) return 30;
  if (c >= 500) return 20;
  return 16;
}

function textOf(req, fields) {
  return (fields || ['function', 'interfaces'])
    .map((f) => getPath(req, f))
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function inferRails(req) {
  const t = textOf(req, ['function', 'interfaces', 'mcu', 'power.input']);
  const rails = [];
  if (/3\.?3|3v3|esp32|stm32|arm|mcu|单片机|i2c|sensor/.test(t)) rails.push('3V3');
  if (/5v|usb|uart|ch340|relay|5 ?v/.test(t)) rails.push('5V');
  if (!rails.length) rails.push('3V3');
  return [...new Set(rails)];
}

function needsBuck(req) {
  const inV = volts(getPath(req, 'power.input'));
  const rails = getPath(req, 'power.rails') || [];
  return inV != null && inV > 6 && rails.some((r) => railName(r) === '5V');
}
function needsLdo(req) {
  const rails = getPath(req, 'power.rails') || [];
  return rails.some((r) => railName(r) === '3V3');
}
function needsTree(req) {
  const rails = getPath(req, 'power.rails') || [];
  return rails.map(railName).length > 2;
}
function needsCrystal(req) {
  const c = getPath(req, 'constraints.crystal');
  if (c) return true;
  return !!getPath(req, 'mcu') || /\bmcu\b|stm32|esp32|单片机/.test(textOf(req, ['function', 'mcu']));
}

// ---------------------------------------------------------------- check
/**
 * Split a requirement object into the three tiers.
 * @returns {ready, missing:[{key,q}], ask:[{key,q,default}], defaults:[{key,value,note}], notes:[string]}
 */
function check(req) {
  const missing = [];
  const ask = [];
  const defaults = [];
  const notes = [];
  for (const f of FIELDS) {
    const v = getPath(req, f.key);
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (f.tier === 'required') {
      if (empty) missing.push({ key: f.key, q: f.q });
      continue;
    }
    if (f.tier === 'ask') {
      if (empty) {
        const dv = f.infer ? f.infer(req) : f.def;
        ask.push({ key: f.key, q: f.q, fallback: dv });
      }
      continue;
    }
    if (empty && f.def !== undefined) {
      setPath(req, f.key, f.def);
      // Only report a default the reader could actually veto; null/[] is noise.
      const meaningful = !(f.def === null || (Array.isArray(f.def) && !f.def.length));
      if (meaningful) defaults.push({ key: f.key, value: f.def, note: f.note });
    }
  }
  const layers = getPath(req, 'board.layers');
  if (layers && layers > 2) notes.push(`层数 ${layers}：本工具链按 2 层布线，其余层需在客户端人工复核`);
  if (getPath(req, 'package') === '0805') notes.push('0805 暂无预设封装，按 0603 生成（可在 design 中改回）');
  return { ready: !missing.length, missing, ask, defaults, notes };
}

// ---------------------------------------------------------------- resolve
/** Materialise the ask-tier fallbacks so matching has data to work with. */
function fillAsk(req, chk) {
  for (const a of chk.ask) {
    const v = getPath(req, a.key);
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) setPath(req, a.key, a.fallback);
  }
  return req;
}

/** Requirement → {design, plan}. Deterministic: same requirement ⇒ same design. */
function resolve(req, opts) {
  const o = opts || {};
  const overrides = o.params || {};
  const forced = o.recipes && o.recipes.length ? o.recipes : (getPath(req, 'recipes') || []);
  const chk = check(req);
  if (!chk.ready) {
    const err = new Error('requirement incomplete — ask these first');
    err.intake = chk;
    throw err;
  }
  // Ask-tier fields were reported, not filled: materialise the documented
  // fallback so feature matching has something to match against. They stay in
  // plan.openQuestions, so the confirmation gate still shows them.
  fillAsk(req, chk);

  const rails = (getPath(req, 'power.rails') || []).map(railName);
  const current = getPath(req, 'power.current_mA') || 200;

  const picked = (forced.length
    ? forced.map((n) => ({ recipe: n, at: 0 }))
    : FEATURES.filter((f) => matches(req, f, rails))
  ).slice().sort((a, b) => (a.at - b.at) || a.recipe.localeCompare(b.recipe));

  const inputVolts = volts(getPath(req, 'power.input'));
  const hasUsb = picked.some((f) => f.recipe === 'usb-c-power');
  // A USB-C socket already IS the 5V input, so the bus net is VBUS; without it
  // the input rail keeps its own voltage name (12V, 24V…).
  const busNet = hasUsb ? 'VBUS' : railName(getPath(req, 'power.input') || 'VIN');
  // A requested rail that equals the input voltage is not a separate net.
  const alias = (r) => {
    const n = railName(r);
    if (hasUsb && volts(n) === inputVolts) return busNet;
    return n;
  };
  const ctx = { busNet, alias, rails, upstream: makeUpstream(busNet, rails) };
  const finalRails = [...new Set(rails.map(alias))];

  let design = {
    name: getPath(req, 'name') || 'board',
    powers: { GND: 'down' },
    blocks: [],
    parts: [],
    nets: {},
    pcb: {}
  };
  // Strategy (1.13): the skill NEVER lays copper — no pour is ever written.
  // Copper is finished by a human in the client; build.js reports the `rats`
  // (nets awaiting copper) for that handoff.
  const bw = getPath(req, 'board.width');
  const bh = getPath(req, 'board.height');
  if (bw && bh) design.board = { width: Number(bw), height: Number(bh) };
  if (getPath(req, 'output.schematic_only')) design.pcb = false;
  // 单页/多页：intake 的询问结果直接进 design 契约（blocks 自动按页分配，
  // 也可以在 blocks[].sheet 里显式指定）
  const sheets = Number(getPath(req, 'schematic.sheets'));
  if (sheets > 1) design.sheets = Math.floor(sheets);

  const used = [];
  const cache = o.noCache ? null : C.open('intake');
  const derivedNotes = [];
  for (const f of picked) {
    const params = Object.assign(paramsFor(), overrides);
    const netMap = netsFor(f.recipe, ctx);
    const recipeSig = M.recipeSignature(f.recipe);
    // the key includes the recipe CONTENT fingerprint: an edited recipe
    // (e.g. adding pinoutSource) must invalidate stale cached resolves
    const key = `${f.recipe}|${recipeSig}|${JSON.stringify(params)}|${JSON.stringify(netMap)}`;
    const hit = cache && cache.get(key);
    const resolved = hit ? hit.value : M.resolveRecipe(f.recipe, params, netMap);
    if (cache && !hit) cache.set(key, resolved, f.recipe);
    const merged = M.merge(design, resolved.recipe, {
      params: resolved.params,
      netRenames: netMap,
      suffix: `_${f.recipe.replace(/[^a-z0-9]/gi, '').slice(0, 3)}`,
      onPowerConflict: (net, kept, wanted) => derivedNotes.push(`网络 "${net}" 电源属性冲突：保留 ${kept}，忽略 ${wanted}（${f.recipe}）`)
    });
    design = merged.design;
    used.push({
      recipe: f.recipe,
      fromCache: !!hit,
      params: resolved.params,
      parts: merged.summary.addedParts,
      // typed recipes resolve their device by class + roles; fixed-model ones
      // bake a specific chip in (report §9) — the plan reports which is which
      deviceClass: (resolved.device && resolved.device.class) || null,
      device: (resolved.device && resolved.device.name) || null
    });
  }
  if (cache) cache.save();

  // Linear-regulator sanity: a big drop at real current is a heat problem, not
  // a topology preference. Suggest the two-stage chain — but never silently add
  // a buck, because that changes the BOM and the BOM is a confirmation point.
  for (const u of used) {
    if (u.recipe !== 'ldo-3v3') continue;
    const feed = ctx.upstream('3V3');
    const drop = (volts(feed) || 0) - 3.3;
    if (drop > 6 && current >= 150 && !used.some((x) => x.recipe === 'buck-5v')) {
      derivedNotes.push(`LDO 从 ${feed} 直接降到 3V3：压差 ${drop.toFixed(1)} V × ${current} mA ≈ ${(drop * current / 1000).toFixed(2)} W 热耗散。建议加一级 buck（recipes 里显式加 "buck-5v"）或确认电流很小`);
    }
  }

  if (!used.length) derivedNotes.push('没有匹配到任何 recipe：需要手写 parts/blocks（docs/build.md）');
  applyPackage(design, getPath(req, 'package'));

  // Handoff annotations derived from the requirement, not from taste:
  //  · a rail's width follows declared current (30 mil ≈ 1 A @ 2 oz per
  //    docs/development.md) — recorded on the net as intent for the human who
  //    routes in the client (this skill never lays copper);
  //  · pcb.rules stays a DRC contract only — nothing is "pre-armed" for a
  //    router that no longer exists.
  const width = railWidth(current);
  for (const rail of [busNet, ...finalRails]) {
    if (rail === 'GND') continue;
    design.powers[rail] = 'up';
    design.nets[rail] = Object.assign({ width }, design.nets[rail] || {});
  }
  // pcb.rules is a DRC contract only (clearance/trackWidth/edgeClearance +
  // DFM floors). Since 1.13 there is no router, so nothing is "pre-armed" for
  // it — dense boards no longer need fine rules, only a honest floor for the
  // pad-spacing check and for copper a human later adds in the client.
  if (req.pcb && req.pcb.rules) {
    design.pcb = design.pcb || {};
    design.pcb.rules = req.pcb.rules;
  }
  if (finalRails.length > 2 && !used.some((u) => u.recipe === 'power-tree')) {
    derivedNotes.push('多于 2 个电源轨：考虑显式 recipes:["power-tree"]');
  }
  design.expect = design.expect || {};
  design.expect.decoupling = true;
  const pairs = getPath(req, 'constraints.differential') || [];
  if (pairs.length) design.expect.pairs = pairs;

  const plan = {
    name: design.name,
    input: busNet,
    rails: finalRails,
    current_mA: current,
    board: design.board || 'auto-grow',
    layers: getPath(req, 'board.layers') || 2,
    package: getPath(req, 'package') || '0603',
    recipes: used.map((u) => ({ recipe: u.recipe, parts: u.parts.length, fromCache: u.fromCache, deviceClass: u.deviceClass, device: u.device })),
    parts: design.parts.length,
    railWidth: width,
    rules: design.pcb && design.pcb.rules ? design.pcb.rules : null,
    nets: [...new Set(design.parts.flatMap((p) => Object.values(p.pins || {})))].sort(),
    defaults: chk.defaults,
    openQuestions: chk.ask,
    notes: chk.notes.concat(derivedNotes)
  };
  return { design, plan, used };
}

function matches(req, f, rails) {
  if (f.when) return !!f.when(req, rails);
  const t = textOf(req, f.fields || ['function', 'interfaces']);
  return f.any.some((k) => t.includes(k));
}

/** Recipe params derived from the requirement (`--set` overrides these). */
function paramsFor() {
  return {};
}

/** Which rail a recipe's own `VIN` pin is fed from (its output's upstream). */
const OUTPUT_RAIL = { 'ldo-3v3': '3V3', 'buck-5v': '5V', 'power-tree': '3V3' };

/**
 * Canonical recipe nets → this design's net names, applied to EVERY recipe so
 * module boundaries join up: `3V3` in mcu-min and `3V3` in ldo-3v3 must be the
 * same net, and a regulator's `VIN` must land on the rail above it, not on the
 * raw input bus.
 * ctx: { busNet, hasUsb, alias, rails, upstream } — `upstream(out)` is the
 * lowest-voltage net strictly above `out` (12V → buck → 5V → LDO → 3V3 chains).
 */
function netsFor(name, ctx) {
  const map = {};
  if (ctx.hasUsb) map.VBUS = ctx.busNet;
  map['3V3'] = ctx.alias('3V3');
  map['5V'] = ctx.alias('5V');
  const out = OUTPUT_RAIL[name];
  map.VIN = out ? ctx.upstream(out) : ctx.alias('5V');
  if (name === 'power-tree') {
    for (const r of ctx.rails) map[railName(r)] = ctx.alias(railName(r));
  }
  return map;
}

/** The lowest available net strictly above `out`'s voltage (else the bus). */
function makeUpstream(busNet, rails) {
  const seen = new Set([busNet]);
  const candidates = [{ net: busNet, v: volts(busNet) }];
  for (const r of rails) {
    if (seen.has(r)) continue;
    seen.add(r);
    candidates.push({ net: r, v: volts(r) });
  }
  return (out) => {
    const target = volts(out);
    if (target == null) return busNet;
    const above = candidates
      .filter((c) => c.net !== out && c.v != null && c.v > target)
      .sort((a, b) => a.v - b.v);
    return above.length ? above[0].net : busNet;
  };
}

/** Rewrite the R/C/L preset packages to the requested one where a preset exists. */
function applyPackage(design, pkg) {
  if (!pkg || pkg === '0603') return;
  const alt = { '0402': { R0603: 'R0402', C0603: 'C0402', L0603: 'L0402' },
               '0603': { R0402: 'R0603', C0402: 'C0603', L0402: 'L0603' } };
  const table = alt[pkg];
  if (!table) return;
  for (const p of design.parts) {
    if (typeof p.footprint === 'string' && table[p.footprint]) p.footprint = table[p.footprint];
  }
}

// ---------------------------------------------------------------- render
/** One compact block the agent pastes into its reply — the confirmation gate. */
function renderPlan(plan) {
  const L = [];
  L.push(`方案 ${plan.name}`);
  L.push(`  电源  输入 ${plan.input} → 轨 ${(plan.rails || []).join(' / ') || '—'}（${plan.current_mA} mA）`);
  L.push(`  板框  ${typeof plan.board === 'string' ? plan.board : `${plan.board.width}×${plan.board.height} mil`} · ${plan.layers} 层 · 封装 ${plan.package} · 只布局（布线/铺铜在客户端完成）`);
  L.push(`  模块  ${plan.recipes.map((r) => `${r.recipe}(${r.parts})${r.fromCache ? '*' : ''}`).join(' + ') || '无匹配 recipe — 需手写 design'}`);
  // coverage (report §9 P4): typed recipes pick their part by class + roles;
  // fixed-model ones still bake a specific chip in
  const typed = plan.recipes.filter((r) => r.deviceClass);
  const fixed = plan.recipes.filter((r) => !r.deviceClass);
  if (plan.recipes.length) {
    L.push(`  覆盖  类型化 ${typed.length}（${typed.map((r) => `${r.recipe}→${r.device}`).join(', ') || '无'}）`
      + ` · 固定模板 ${fixed.length}（${fixed.map((r) => r.recipe).join(', ') || '无'}）`
      + `${fixed.length ? ' — 固定模板写死了型号，换型请改用类型化 recipe 或 board.gen.js' : ''}`);
  }
  L.push(`  规模  ${plan.parts} parts · ${plan.nets.length} nets`);
  if (plan.rules || plan.railWidth) {
    L.push(`  注记  电源轨 ${plan.railWidth} mil（供客户端布线参考的电流注记）${plan.rules ? ` · DRC 规则 ${Object.entries(plan.rules).map(([k, v]) => `${k}=${v}`).join(' / ')}` : ''}`);
  }
  L.push(`  网络  ${plan.nets.slice(0, 14).join(' ')}${plan.nets.length > 14 ? ' …' : ''}`);
  if (plan.defaults.length) {
    L.push(`  默认  ${plan.defaults.map((d) => `${d.key}=${Array.isArray(d.value) ? d.value.join(',') : (JSON.stringify(d.value))}`).join('  ')}`);
  }
  if (plan.openQuestions.length) {
    L.push('  待确认');
    for (const a of plan.openQuestions) {
      const d = (a.fallback === null || a.fallback === undefined) ? '不填即自动' : JSON.stringify(a.fallback);
      L.push(`    · ${a.q.zh || a.q}  → 不回答则用 ${d}`);
    }
  }
  for (const n of plan.notes) L.push(`  注意  ${n}`);
  L.push('  下一步  node scripts/build.js --design <file> --dir <dir> --plan   # 先看方案，确认后去掉 --plan 构建');
  return L.join('\n');
}

function renderQuestions(chk) {
  const L = [];
  if (chk.missing.length) {
    L.push('必填（缺了不能开始）：');
    for (const m of chk.missing) L.push(`  ${m.key}: ${m.q.zh || m.q}`);
  }
  if (chk.ask.length) {
    L.push('建议一次问完（带默认值，不答就用默认）：');
    for (const a of chk.ask) {
      const d = (a.fallback === null || a.fallback === undefined) ? '不填即自动' : JSON.stringify(a.fallback);
      L.push(`  ${a.key}: ${a.q.zh || a.q}  [默认 ${d}]`);
    }
  }
  if (chk.defaults.length) {
    L.push('已套用默认（无需回答，可在确认点否决）：');
    for (const d of chk.defaults) L.push(`  ${d.key}=${Array.isArray(d.value) ? d.value.join(',') : JSON.stringify(d.value)} — ${d.note}`);
  }
  for (const n of chk.notes) L.push(`  注意 ${n}`);
  L.push(`确认点（${CONFIRM.length}）: ${CONFIRM.join(' / ')}`);
  return L.join('\n');
}

/** Fixed empty form — copy, fill, hand to `intake.js resolve`. */
function template() {
  return {
    name: 'my-board',
    function: '',
    power: { input: '', rails: [], current_mA: null },
    interfaces: [],
    mcu: null,
    board: { width: null, height: null, layers: 2 },
    package: '0603',
    constraints: { differential: [], crystal: null },
    cost: { target_usd: null, quantity: 10 },
    environment: { temp_c: [-20, 70] },
    output: { schematic_only: false },
    recipes: []
  };
}

function fieldsTable() {
  const rows = FIELDS.map((f) => {
    const d = f.infer ? '推断' : (f.def === undefined ? '—' : JSON.stringify(f.def));
    return `${f.tier.padEnd(8)} ${f.key.padEnd(26)} ${d.padEnd(18)} ${(f.q ? (f.q.zh || f.q) : f.note || '').slice(0, 60)}`;
  });
  return ['tier     key                        default            说明/问题', ...rows].join('\n');
}

function reqHash(req) {
  return crypto.createHash('sha256').update(JSON.stringify(req)).digest('hex').slice(0, 16);
}

module.exports = { FIELDS, FEATURES, CONFIRM, check, resolve, renderPlan, renderQuestions, template, fieldsTable, railName, volts, railWidth, getPath, reqHash };
