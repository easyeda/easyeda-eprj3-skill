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

function mermaidSignal(design, edges) {
  const lines = ['```mermaid', 'graph LR'];
  const blocks = design.blocks || [];
  blocks.forEach((b, i) => lines.push(`  B${i}["${esc(b.title)}"]`));
  for (const e of edges) {
    lines.push(`  B${e.from} -->|"${esc(e.net)}"| B${e.to}`);
  }
  if (!edges.length) lines.push('  note["（同模块内信号，无跨模块连线）"]');
  lines.push('```');
  return lines.join('\n');
}

function mermaidPower(design, railBlocksMap) {
  const lines = ['```mermaid', 'graph TD'];
  const blocks = design.blocks || [];
  blocks.forEach((b, i) => lines.push(`  B${i}["${esc(b.title)}"]`));
  const ups = [...railBlocksMap.entries()].filter(([, r]) => r.dir === 'up').sort((a, b) => a[0].localeCompare(b[0]));
  const downs = [...railBlocksMap.entries()].filter(([, r]) => r.dir === 'down').sort((a, b) => a[0].localeCompare(b[0]));
  for (const [net, r] of ups) {
    lines.push(`  ${net}(("${esc(net)}"))`);
    for (const bi of [...r.blocks].sort((a, b) => a - b)) lines.push(`  ${net} --> B${bi}`);
  }
  for (const [net, r] of downs) {
    lines.push(`  ${net}(("${esc(net)}"))`);
    for (const bi of [...r.blocks].sort((a, b) => a - b)) lines.push(`  ${net} -.-> B${bi}`);
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

  const lines = [];
  lines.push(`# ${design.name} 工程报告`);
  lines.push('');
  lines.push('> 由 `scripts/report.js` 从 design.json 与已构建工程自动生成；"建议"一节可人工补充。');
  lines.push('');
  lines.push('## 工程概述');
  lines.push('');
  const board = design.boardDeclared
    ? `${design.board.width} × ${design.board.height} mil`
    : `${design.board.width} × ${design.board.height} mil（未显式声明，自动适配器件）`;
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 工程名 | ${design.name} |`);
  lines.push(`| 生成时间 | ${new Date().toISOString()} |`);
  lines.push(`| 源 | ${design.file ? `\`${path.basename(design.file)}\`` : '（生成器）'} |`);
  lines.push(`| 板框 | ${board} |`);
  lines.push(`| 原理图页 | ${design.sheets} |`);
  lines.push(`| 器件 / 网络 / 引脚 | ${parts.length} / ${nets.length} / ${pinCount} |`);
  lines.push('');

  // 工程描述
  lines.push('## 功能特性');
  lines.push('');
  lines.push('| 模块 | 说明 | 器件 |');
  lines.push('| --- | --- | --- |');
  for (const b of blocks) {
    const detail = b.parts.map((id) => {
      const p = parts.find((x) => x.id === id);
      return p ? `${id}(${symbolName(p)}${p.value ? ' ' + p.value : ''})` : id;
    }).join('、');
    lines.push(`| ${b.title}${b.sheet ? `（P${b.sheet}）` : ''} | ${b.desc || '—'} | ${detail || '—'} |`);
  }
  lines.push('');

  // 信号框架图
  lines.push('## 信号框架图');
  lines.push('');
  lines.push('（模块间信号流，方框 = 功能模块，箭头标注 = 跨模块网络）');
  lines.push('');
  lines.push(mermaidSignal(design, edges));
  lines.push('');

  // 电路/电源框架图
  lines.push('## 电路框架图（电源）');
  lines.push('');
  lines.push('（实线 = 供电轨，点线 = 地）');
  lines.push('');
  lines.push(mermaidPower(design, rails));
  lines.push('');

  // 网络概览
  lines.push('## 网络概览');
  lines.push('');
  lines.push('| 网络 | 引脚数 | 电源旗标 | 页 |');
  lines.push('| --- | --- | --- | --- |');
  for (const g of nets) {
    const power = design.powerNets.has(g.name) ? (design.powerNets.get(g.name) === 'down' ? '地' : '供电') : (NC.test(g.name) ? 'NC' : '信号');
    lines.push(`| \`${g.name}\` | ${g.pins.size} | ${g.flags} | ${[...g.sheets].join(', ')} |`);
  }
  lines.push('');

  // 验证结果
  lines.push('## 验证结果');
  lines.push('');
  const hasBuild = !!build;
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
    lines.push(`| netcheck | ${nc && nc.match ? '通过' : '失配'} |`);
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
    '交付物只含原理图 + 布局好的 PCB；自动布线、铺铜、制造文件导出（BOM / 坐标 / Gerber）都不归本 skill 管，在 EasyEDA Pro 客户端完成。',
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

module.exports = { buildProjectReport, signalEdges, railBlocks, mergedNets };
