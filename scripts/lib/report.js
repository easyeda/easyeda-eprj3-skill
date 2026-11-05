'use strict';
/**
 * report.js — write project-report.md from a built project.
 *
 * After a build the user gets a human-readable report alongside the .eprj3:
 * what the board is, its functional blocks, the signal flow between them, the
 * power tree, the net overview, the gate results, known limitations and
 * auto-derived suggestions. Everything is computed from design.json and the
 * built project (never guessed): the AI only needs to top up the judgement
 * sections (a one-line function summary, extra suggestions).
 *
 * `scripts/report.js` is the CLI; `make-board.js` calls this directly so the
 * one-shot path writes the report for free.
 */
const path = require('path');

const NC = /^(NC|DNC\d*|N\/C)$/i;

function symbolName(part) {
  const s = part.symbol;
  if (typeof s === 'string') return s;
  return (s && s.name) || (part.ic ? String(part.ic) : 'inline');
}

/** net -> merged {pins:Set, flags, sheets:Set} across every sheet. */
function mergedNets(all) {
  const out = new Map();
  for (const s of all.perSheet) {
    for (const net of s.netlist.nets) {
      if (!out.has(net.name)) {
        out.set(net.name, { name: net.name, pins: new Set(), flags: 0, sheets: new Set() });
      }
      const g = out.get(net.name);
      g.flags += net.flags || 0;
      g.sheets.add(`${s.schematic}/${s.sheet}`);
      for (const p of net.pins) if (p.ref !== '?') g.pins.add(`${p.ref}.${p.num}`);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function blockIndex(design) {
  const m = new Map();
  (design.blocks || []).forEach((b, i) => { for (const id of b.parts) m.set(id, i); });
  return m;
}

/** signal nets that cross at least two blocks (consecutive flow edges). */
function signalEdges(design) {
  const bIdx = blockIndex(design);
  const netBlocks = new Map();   // net -> sorted block indices
  for (const part of design.parts) {
    const bi = bIdx.get(part.id);
    if (bi === undefined) continue;
    for (const net of Object.values(part.pins)) {
      if (design.powerNets.has(net) || NC.test(net)) continue;
      if (!netBlocks.has(net)) netBlocks.set(net, []);
      const list = netBlocks.get(net);
      if (!list.includes(bi)) list.push(bi);
    }
  }
  const edges = [];
  for (const [net, idxs] of netBlocks) {
    if (idxs.length < 2) continue;
    idxs.sort((a, b) => a - b);
    for (let i = 1; i < idxs.length; i += 1) {
      edges.push({ from: idxs[i - 1], to: idxs[i], net });
    }
  }
  // deterministic: sort by from, then to, then net name
  edges.sort((a, b) => a.from - b.from || a.to - b.to || a.net.localeCompare(b.net));
  return edges;
}

/** power rail (up/down) -> blocks that reference it. */
function railBlocks(design) {
  const bIdx = blockIndex(design);
  const out = new Map();
  for (const [net, dir] of design.powerNets) out.set(net, { dir, blocks: new Set() });
  for (const part of design.parts) {
    const bi = bIdx.get(part.id);
    if (bi === undefined) continue;
    for (const net of Object.values(part.pins)) {
      if (out.has(net)) out.get(net).blocks.add(bi);
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/["\n]/g, (c) => (c === '"' ? '\\"' : ' '));
}

function deviceName(part) {
  if (part.ic) return String(part.ic);
  if (part.name) return String(part.name);
  return symbolName(part);
}

function footprintName(part, byRef) {
  const b = byRef && byRef.get(part.id);
  if (b && b.footprint) return b.footprint;
  const f = part.footprint;
  if (!f) return part.ic || part.libraryRef ? '官方库封装' : '—';
  if (typeof f === 'string') return f;
  if (f.name) return f.name;
  if (f.auto) return `自动 ${f.auto}`;
  return '自定义';
}

/** BOM rows grouped by device + value + footprint (one row per orderable
 *  group, designators listed). `build.bom` (written by build.js) carries the
 *  real footprint name of system-library parts; without it the design alone
 *  still yields a complete table. */
function bomGroups(design, build) {
  const byRef = new Map(((build && build.bom) || []).map((b) => [b.ref, b]));
  const groups = new Map();
  for (const p of design.parts) {
    const b = byRef.get(p.id);
    const device = (b && b.device) || deviceName(p);
    const value = (b && b.value) || p.value || '';
    const fp = footprintName(p, byRef);
    const lcsc = (b && b.lcsc) || (p.libraryRef && p.libraryRef.lcsc) || '';
    const key = [device, value, fp, lcsc].join('\u0001');
    if (!groups.has(key)) groups.set(key, { device, value, fp, lcsc, refs: [] });
    groups.get(key).refs.push(p.id);
  }
  return [...groups.values()];
}

/** One arrow per module pair, labelled with the nets it carries (up to three
 *  names + a count). The per-net detail lives in the net overview — the
 *  diagram keeps only what is readable at a glance. Returns null when no
 *  signal crosses a module boundary. */
function mermaidSignal(design, edges) {
  const blocks = design.blocks || [];
  const pairs = new Map();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    if (!pairs.has(key)) pairs.set(key, { from: e.from, to: e.to, nets: [] });
    pairs.get(key).nets.push(e.net);
  }
  if (!pairs.size) return null;
  const involved = new Set();
  for (const p of pairs.values()) { involved.add(p.from); involved.add(p.to); }
  const lines = ['```mermaid', 'flowchart LR'];
  for (const i of [...involved].sort((a, b) => a - b)) lines.push(`  B${i}["${esc(blocks[i].title)}"]`);
  for (const p of [...pairs.values()].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const nets = [...new Set(p.nets)].sort();
    const label = nets.length <= 3 ? nets.join(' / ') : `${nets.slice(0, 3).join(' / ')} +${nets.length - 3}`;
    lines.push(`  B${p.from} -->|"${esc(label)}"| B${p.to}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** Converters = parts whose pins touch two or more supply rails (an LDO/buck
 *  between VIN and VOUT, a charger between VBUS and VBAT). They give the power
 *  diagram its hierarchy; without them every rail is a sibling. */
function railConverters(design) {
  const ups = new Set([...design.powerNets].filter(([, d]) => d === 'up').map(([n]) => n));
  const out = [];
  for (const p of design.parts) {
    const rails = [...new Set(Object.values(p.pins || {}).filter((n) => ups.has(n)))];
    if (rails.length >= 2) out.push({ id: p.id, label: `${p.id} · ${deviceName(p)}`, rails });
  }
  return out;
}

/** Rail hierarchy: root rail + one link per converter, plus the rails nothing
 *  feeds (listed in the report text rather than invented on the diagram). */
function powerLinks(design) {
  const rails = [...design.powerNets].filter(([, d]) => d === 'up').map(([n]) => n);
  const meta = design.meta || {};
  const root = (meta.input && rails.includes(meta.input)) ? meta.input : rails[0] || null;
  const conv = railConverters(design);
  const known = new Set(root ? [root] : []);
  const links = [];
  const used = new Set();
  const queue = root ? [root] : [];
  while (queue.length) {
    const from = queue.shift();
    for (const c of conv) {
      if (used.has(c.id) || !c.rails.includes(from)) continue;
      const to = c.rails.find((x) => x !== from && rails.includes(x));
      if (!to) continue;
      used.add(c.id);
      links.push({ from, to, label: c.label });
      if (!known.has(to)) { known.add(to); queue.push(to); }
    }
  }
  return { rails, root, links, orphans: rails.filter((n) => !known.has(n)) };
}

/** Power tree: rails chain vertically through their converters, each block
 *  hangs off the rail(s) that feed it. Ground is stated once in the text —
 *  drawing GND→every block would bury the tree. */
function mermaidPower(design, railBlocksMap, links) {
  const up = [...railBlocksMap.entries()].filter(([, r]) => r.dir === 'up').sort((a, b) => a[0].localeCompare(b[0]));
  if (!up.length) return null;
  const blocks = design.blocks || [];
  const idOf = new Map(up.map(([n], i) => [n, `R${i}`]));
  const lines = ['```mermaid', 'flowchart TD'];
  for (const [net] of up) {
    const tag = net === links.root ? ' · 输入' : '';
    lines.push(`  ${idOf.get(net)}(["${esc(net)}${tag}"])`);
  }
  for (const [i, l] of links.links.entries()) {
    if (!idOf.has(l.from) || !idOf.has(l.to)) continue;
    lines.push(`  C${i}["${esc(l.label)}"]`);
    lines.push(`  ${idOf.get(l.from)} --> C${i}`);
    lines.push(`  C${i} --> ${idOf.get(l.to)}`);
  }
  for (const [net, r] of up) {
    for (const bi of [...r.blocks].sort((a, b) => a - b)) {
      lines.push(`  ${idOf.get(net)} --> B${bi}["${esc(blocks[bi].title)}"]`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

function fmtFix(f) {
  if (!f) return '';
  const code = f.code || f.id || '';
  const msg = (f.msg || '').trim();
  const fix = f.fix ? ` — fix: ${f.fix}` : '';
  return `- \`${code}\` ${msg}${fix}`;
}

function suggestionFor(code) {
  const map = {
    W001: '把该电源网在 design.json 的 `powers` 里声明（`"up"` 供电 / `"down"` 地），让生成器画电源旗标而非普通导线。',
    W002: '在该电源网与地之间补一颗去耦电容（`autofix.js --diff` 可自动加）。',
    W003: '该网络只在同一器件的两个引脚之间——多半是 `parts[].pins` 把两个脚都写到了同一网络，请检查位号。'
  };
  return map[code] || null;
}

/**
 * Build the markdown report.
 * @param {object} design      normalized design (design.readSource)
 * @param {object} all         lib/netlist projectNetlist(dir)
 * @param {object} netcheck    lib/netcheck compare(all)
 * @param {object|null} build  build.json report (may be null → gates unknown)
 */
function buildProjectReport(design, all, netcheck, build) {
  const nets = mergedNets(all);
  const edges = signalEdges(design);
  const rails = railBlocks(design);
  const parts = design.parts;
  const pinCount = nets.reduce((n, g) => n + g.pins.size, 0) + all.perSheet.reduce((n, s) => n + s.netlist.unconnected.length, 0);
  const blocks = design.blocks || [];

  // 需求元数据（intake 写入；没有它时退化为纯结构描述，不臆造功能）
  const meta = design.meta || {};
  const power = powerLinks(design);
  const upRails = [...design.powerNets].filter(([, d]) => d === 'up').map(([n]) => n);
  const inNet = meta.input || upRails[0] || null;
  // 输入轨排在最前：电源轨按"输入 → 派生"读，而不是按声明顺序
  const railOrder = inNet && upRails.includes(inNet) ? [inNet, ...upRails.filter((n) => n !== inNet)] : upRails;
  const downRails = [...design.powerNets].filter(([, d]) => d === 'down').map(([n]) => n);
  const hasBuild = !!build;

  const lines = [];
  lines.push(`# ${design.name} 工程报告`);
  lines.push('');
  lines.push('> 由 `scripts/report.js` 从 design.json 与已构建工程自动生成；"建议"一节可人工补充。');
  lines.push('');
  lines.push('## 工程概述');
  lines.push('');
  const sz = (build && build.pcb && build.pcb.board) || design.board;
  const board = `${sz.width} × ${sz.height} mil（自动：封装 bbox 面积 ×1.25${design.boardDeclared ? '，设计里声明的尺寸已忽略' : ''}）`;
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 工程名 | ${design.name} |`);
  lines.push(`| 生成时间 | ${new Date().toISOString()} |`);
  lines.push(`| 源 | ${design.file ? `\`${path.basename(design.file)}\`` : '（生成器）'} |`);
  lines.push(`| 板框 | ${board} |`);
  const pcbLayout = build && build.pcb && build.pcb.layout;
  if (pcbLayout) lines.push(`| PCB 布局 | ${pcbLayout === 'client-auto' ? '客户端自动布局（pcb_Document.autoLayout）' : 'skill 规划摆放'} |`);
  if (meta.input) lines.push(`| 输入电源 | ${meta.input}${meta.current_mA ? ` · ${meta.current_mA} mA` : ''} |`);
  if (upRails.length) lines.push(`| 电源轨 | ${railOrder.join(' / ')}${downRails.length ? ` · 地 ${downRails.join(' / ')}` : ''} |`);
  if (meta.interfaces && meta.interfaces.length) lines.push(`| 对外接口 | ${meta.interfaces.join('、')} |`);
  lines.push(`| 原理图页 | ${design.sheets} |`);
  lines.push(`| 器件 / 网络 / 引脚 | ${parts.length} / ${nets.length} / ${pinCount} |`);
  lines.push('');

  // 功能描述：定位 / 电源 / 模块 / 信号流
  lines.push('## 功能描述');
  lines.push('');
  if (meta.function) {
    lines.push(`**功能定位**：${meta.function}。`);
  } else {
    lines.push(`**功能定位**：${design.name} 由 ${blocks.length} 个功能模块、${parts.length} 个器件组成。`);
  }
  lines.push('');
  const inWidth = inNet && design.netWidths ? design.netWidths[inNet] : null;
  const powerSent = [
    `输入电源为 **${inNet || '未声明'}**${meta.current_mA ? `（约 ${meta.current_mA} mA）` : ''}`,
    ...(power.links.length ? [`经 ${power.links.map((l) => `${l.label} 把 ${l.from} 变为 ${l.to}`).join('、')}`] : []),
    ...(railOrder.length > 1 ? [`可用电源轨：${railOrder.join(' / ')}`] : []),
    ...(downRails.length ? [`${downRails.join(' / ')} 为公共地`] : [])
  ];
  lines.push(`**电源**：${powerSent.join('；')}。`
    + `${inWidth ? `电源线宽按 ${inWidth} mil 注记（交接给客户端铺铜；本 skill 不布线）。` : '本 skill 只做布局，铜皮在客户端完成。'}`);
  lines.push('');
  if (blocks.length) {
    lines.push('**功能模块**：');
    lines.push('');
    for (const b of blocks) {
      const members = b.parts.map((id) => {
        const p = parts.find((x) => x.id === id);
        return p ? `${id}（${deviceName(p)}${p.value ? ' ' + p.value : ''}）` : id;
      });
      lines.push(`- **${b.title}**${b.desc ? `：${b.desc}` : ''}${members.length ? ` — ${members.join('、')}` : ''}`);
    }
    lines.push('');
  }
  const pairMap = new Map();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    if (!pairMap.has(key)) pairMap.set(key, { from: e.from, to: e.to, nets: new Set() });
    pairMap.get(key).nets.add(e.net);
  }
  if (pairMap.size) {
    lines.push('**信号流**：' + [...pairMap.values()]
      .map((p) => `${blocks[p.from].title} → ${blocks[p.to].title}（${[...p.nets].sort().join('/')}）`)
      .join('；') + '。');
  } else {
    lines.push('**信号流**：各模块之间没有跨模块网络，全部连接都在模块内部或经电源轨完成。');
  }
  lines.push('');

  // 功能特性：从需求元数据与器件/拓扑推导的可核对条目
  lines.push('## 功能特性');
  lines.push('');
  const feats = [];
  if (meta.function) feats.push(`- **主要功能**：${meta.function}`);
  if (upRails.length) {
    const derived = railOrder.filter((n) => n !== inNet);
    feats.push(`- **供电**：输入 ${inNet || upRails[0]}${meta.current_mA ? `（约 ${meta.current_mA} mA）` : ''}`
      + `；内部电源轨 ${derived.length ? derived.join(' / ') : '无（单轨）'}`
      + `${downRails.length ? `；地 ${downRails.join(' / ')}` : ''}。`);
  }
  if (meta.interfaces && meta.interfaces.length) feats.push(`- **对外接口**：${meta.interfaces.join('、')}`);
  const named = (re) => parts.filter((p) => re.test(`${deviceName(p)} ${p.value || ''} ${symbolName(p)}`));
  const prot = named(/TVS|ESD|FUSE|PTC|SMBJ|SMAJ|PESD|SRV05/i);
  if (prot.length) feats.push(`- **保护器件**：${prot.map((p) => `${p.id}（${deviceName(p)}）`).join('、')}`);
  const leds = parts.filter((p) => /^D\d/i.test(p.id) && /LED/i.test(`${symbolName(p)} ${deviceName(p)}`));
  if (leds.length) feats.push(`- **状态指示**：${leds.map((p) => `${p.id}（${deviceName(p)}${p.value ? ' ' + p.value : ''}）`).join('、')}`);
  const keys = named(/^(SW|KEY|BTN)|BUTTON|TACT/i);
  if (keys.length) feats.push(`- **按键输入**：${keys.map((p) => p.id).join('、')}`);
  const mcu = meta.mcu || (parts.find((p) => /STM32|ESP32|CH340|NRF|RP2040|ATSAMD|GD32|ATmega/i.test(deviceName(p))) || {}).ic;
  if (mcu) feats.push(`- **主控**：${mcu}`);
  feats.push(`- **板级**：${meta.layers || 2} 层；封装 ${meta.package || '按器件库'}；板框 ${board}；${parts.length} 个器件 / ${nets.length} 个网络。`);
  if (hasBuild) {
    const gateErrs = ((build.validate && build.validate.errors) || []).length
      + ((build.erc && build.erc.errors) || []).length
      + ((build.intent && build.intent.errors) || []).length
      + ((build.lint && build.lint.errors) || 0) + ((build.drc && build.drc.errors) || 0);
    feats.push(`- **验证**：${gateErrs === 0 ? '五道门禁全部通过' : `${gateErrs} 项门禁错误（见“验证结果”）`}。`);
  }
  lines.push(feats.join('\n'));
  lines.push('');

  // 物料清单：按 器件+值+封装 归并，位号并列（build.bom 提供官方封装名）
  lines.push('## 物料清单（BOM）');
  lines.push('');
  const groups = bomGroups(design, build);
  lines.push('| # | 位号 | 器件 / 型号 | 值 | 封装 | 数量 | 立创编号 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  groups.forEach((g, i) => {
    lines.push(`| ${i + 1} | ${g.refs.join(', ')} | ${g.device || '—'} | ${g.value || '—'} | ${g.fp} | ${g.refs.length} | ${g.lcsc || '—'} |`);
  });
  lines.push('');
  lines.push(`共 ${groups.length} 类、${parts.length} 个器件。`);
  lines.push('');

  // 信号框架图：只保留跨模块的关键信息（模块对 + 合并后的网络标签）
  lines.push('## 信号框架图');
  lines.push('');
  const sig = mermaidSignal(design, edges);
  if (sig) {
    lines.push('（方框 = 功能模块；箭头 = 跨模块信号，超过 3 个网络时只标注前 3 个与总数）');
    lines.push('');
    lines.push(sig);
  } else {
    lines.push('（没有跨模块信号：全部网络都在各自的模块内部。）');
  }
  lines.push('');

  // 电源框架图：电源轨按变换链纵向排列，模块挂在给它供电的轨下面
  lines.push('## 电路框架图（电源）');
  lines.push('');
  const pw = mermaidPower(design, rails, power);
  if (pw) {
    lines.push('（圆角 = 电源轨，方框 = 变换器件，向下箭头 = 该轨供电的模块；GND 为公共地，不逐块连线）');
    lines.push('');
    lines.push(pw);
    if (power.orphans.length) {
      lines.push('');
      lines.push(`未在引脚上找到上游的电源轨：${power.orphans.join(' / ')}（该轨由外部接入，或设计未声明 \`meta.input\`）。`);
    }
  } else {
    lines.push('（本设计没有声明电源轨。）');
  }
  lines.push('');

  // 网络概览
  lines.push('## 网络概览');
  lines.push('');
  lines.push('| 网络 | 类型 | 引脚数 | 电源旗标 | 页 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const g of nets) {
    const kind = design.powerNets.has(g.name) ? (design.powerNets.get(g.name) === 'down' ? '地' : '供电') : (NC.test(g.name) ? 'NC' : '信号');
    lines.push(`| \`${g.name}\` | ${kind} | ${g.pins.size} | ${g.flags} | ${[...g.sheets].join(', ')} |`);
  }
  lines.push('');

  // 验证结果
  lines.push('## 验证结果');
  lines.push('');
  if (hasBuild) {
    const v = build.validate || {};
    const erc = build.erc || {};
    const intent = build.intent || {};
    const lint = build.lint || {};
    const drc = build.drc || {};
    lines.push('| 门禁 | 结果 |');
    lines.push('| --- | --- |');
    lines.push(`| format | ${(v.errors || []).length === 0 ? '通过' : `${v.errors.length} 错误`} |`);
    lines.push(`| ERC | ${(erc.errors || []).length === 0 ? '通过' : `${erc.errors.length} 错误`}（${(erc.warnings || []).length} 警告） |`);
    lines.push(`| intent | ${(intent.errors || []).length === 0 ? '通过' : `${intent.errors.length} 错误`} |`);
    lines.push(`| lint | ${lint.score ?? '—'}/100 |`);
    lines.push(`| DRC | ${drc.score ?? '—'}/100（${drc.mode === 'placed-only' ? '仅布局' : '含铜'}） |`);
    const nc = build.netcheck || netcheck;
    lines.push(`| netcheck | ${nc ? (nc.match ? '通过' : '失配') : '未运行'} |`);
    if (build && build.schDrc && build.schDrc.counts) {
      const c = build.schDrc.counts;
      lines.push(`| 原理图 DRC（客户端） | ${c.fatalError || 0} fatal / ${c.error || 0} error / ${c.warn || 0} warn |`);
    }
    lines.push('');

    const issues = [
      ...(v.errors || []).map((f) => ({ code: 'FMT', msg: String(f.msg || f), fix: null })),
      ...(erc.errors || []).map((f) => ({ code: f.id, msg: f.msg, fix: f.fix })),
      ...(erc.warnings || []).map((f) => ({ code: f.id, msg: f.msg, fix: f.fix })),
      ...(intent.errors || []).map((f) => ({ code: f.id, msg: f.msg, fix: f.fix })),
      ...((lint.findings || []).filter((f) => f.level === 'error').map((f) => ({ code: f.code, msg: f.msg, fix: f.fix }))),
      ...((drc.findings || []).filter((f) => f.level === 'error').map((f) => ({ code: f.code, msg: f.msg, fix: f.fix }))),
      ...(nc && !nc.match ? (nc.issues || []).map((f) => ({ code: f.code, msg: f.msg, fix: f.fix })) : [])
    ];
    if (issues.length) {
      lines.push('### 待处理问题');
      lines.push('');
      for (const f of issues) lines.push(fmtFix(f));
      lines.push('');
    }
  } else {
    lines.push('（未提供 `build.json`，门禁结果未知——运行 `build.js --report build.json` 后重跑本报告。）');
    lines.push('');
  }

  // 遗留问题
  lines.push('## 遗留问题');
  lines.push('');
  const warns = hasBuild ? ((build.erc && build.erc.warnings) || []) : [];
  const known = [
    '交付物只含原理图 + 布局好的 PCB；自动布线、铺铜、制造文件导出（坐标 / Gerber / 客户端 BOM 格式）都不归本 skill 管，在 EasyEDA Pro 客户端完成（本报告的 BOM 一节是设计侧清单，可直接核对）。',
    '跨模块/跨页信号用网络端口（按名全局合并）而非长导线；短距离同模块网络才画可见导线。',
    'PCB 是 placement-only（`rats:` 交接清单列出还需手工连的网络）；铜皮由人在客户端完成。'
  ];
  for (const k of known) lines.push(`- ${k}`);
  for (const w of warns) if (w && (w.id || w.code)) lines.push(`- \`${w.id || w.code}\` ${w.msg || ''}`);
  lines.push('');

  // 建议
  lines.push('## 建议');
  lines.push('');
  const hints = new Set();
  for (const w of warns) {
    const s = suggestionFor(w && w.id);
    if (s) hints.add(s);
  }
  if (!hasBuild) hints.add('建议用 `build.js --report build.json` 重建并回填"验证结果"一节。');
  if (hints.size) {
    for (const h of hints) lines.push(`- ${h}`);
  } else {
    lines.push('- （无自动建议；可结合具体应用场景在此补充，例如器件选型、防护、接口电平等。）');
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = { buildProjectReport, signalEdges, railBlocks, mergedNets, bomGroups, powerLinks };
