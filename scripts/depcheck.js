#!/usr/bin/env node
'use strict';
/**
 * depcheck.js — self-authored / zero-dependency compliance scan.
 *
 * The skill's contract is "全部代码自研，禁止使用第三方代码和包". Wording is not
 * enforcement: one `require('lodash')` in one script silently breaks it, and the
 * package would no longer run on a machine with no registry access. This gate
 * proves the claim by reading the code.
 *
 * What counts as allowed:
 *   · Node builtins (module, fs, path, crypto, os, child_process, …) — the
 *     platform, not a third-party package;
 *   · relative/self specifiers (`./lib/eprj3`, `../scripts/...`) — this skill;
 *   · corepack/npm *docs* — only actual code imports are scanned.
 * What counts as a violation:
 *   · any bare `require('x')` / `import x from 'y'` that is not a Node builtin;
 *   · a non-empty `dependencies` / `devDependencies` / `peerDependencies` /
 *     `optionalDependencies` / `bundledDependencies` field in package.json;
 *   · a committed `node_modules/` directory;
 *   · `require` of a path outside this repo (absolute path or `..` escaping the
 *     skill root) — self-authored only means *this* codebase.
 *
 * Usage:
 *   node scripts/depcheck.js            # human report
 *   node scripts/depcheck.js --json     # machine-readable
 *   node scripts/depcheck.js --strict   # also flag dynamic requires (default: warn)
 *
 * Exit 0 clean · 1 violations found.
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { parseArgs, printHelp } = require('./lib/utils');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['scripts', 'test'];
const BUILTINS = new Set(builtinModules.concat(builtinModules.map((m) => `node:${m}`)));

const SCHEMA = [
  { name: 'json', desc: 'machine-readable report', hasValue: false },
  { name: 'strict', desc: 'flag dynamic require() calls as violations too', hasValue: false },
  { name: 'dir', desc: 'extra directory to scan (repeatable via comma list)' }
];

function walk(dir, acc) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (it.name === 'node_modules' || it.name.startsWith('.')) continue;
      walk(p, acc);
    } else if (it.isFile() && (p.endsWith('.js') || p.endsWith('.cjs') || p.endsWith('.mjs'))) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Remove comments without touching line numbers: every comment character is
 * replaced by a space, newlines stay. String literals are tracked so a '//'
 * inside a URL (or a require('https://…' — never valid, but harmless to keep)
 * is not mistaken for a comment start. Block comments matter most here: the
 * header docs of this very file quote example imports.
 */
function stripComments(text) {
  const src = text.split('');
  let state = 'code'; // code | sq | dq | tpl | line | block
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    switch (state) {
      case 'code':
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        else if (c === '/' && next === '/') { state = 'line'; src[i] = ' '; src[i + 1] = ' '; i += 1; }
        else if (c === '/' && next === '*') { state = 'block'; src[i] = ' '; src[i + 1] = ' '; i += 1; }
        break;
      case 'sq': case 'dq': case 'tpl':
        if (c === '\\') { i += 1; }
        else if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
        break;
      case 'line':
        if (c === '\n') { state = 'code'; } else if (c !== '\r') src[i] = ' ';
        break;
      case 'block':
        if (c === '*' && next === '/') { src[i] = ' '; src[i + 1] = ' '; i += 1; state = 'code'; }
        else if (c !== '\n' && c !== '\r') src[i] = ' ';
        break;
      default:
        break;
    }
  }
  return src.join('');
}

/** Static require/import specifiers + dynamic require() call sites. */
function scanFile(file) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const lines = text.split(/\r?\n/);
  const found = [];
  const dynamic = [];
  const patterns = [
    { re: /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, kind: 'require' },
    { re: /\bimport\s*(?:[\w*\s{},]*\sfrom\s*)?(['"`])([^'"`]+)\1/g, kind: 'import' },
    { re: /\bexport\s*(?:[\w*\s{},]*\sfrom\s*)?(['"`])([^'"`]+)\1/g, kind: 'export-from' },
    { re: /\bawait\s+import\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, kind: 'dynamic-import' }
  ];
  lines.forEach((line, idx) => {
    const code = line; // comments already blanked by stripComments
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(code)) !== null) {
        const spec = m[2];
        if (spec.includes('${') || spec.includes('%')) dynamic.push({ line: idx + 1, spec, kind: p.kind });
        else found.push({ line: idx + 1, spec, kind: p.kind });
      }
    }
  });
  return { found, dynamic };
}

function classify(spec, file) {
  if (BUILTINS.has(spec)) return 'builtin';
  if (/^[./]/.test(spec)) {
    const target = path.resolve(path.dirname(file), spec);
    const rel = path.relative(ROOT, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside';
    return 'self';
  }
  if (/^node:/.test(spec)) return 'builtin';
  return 'external';
}

function pkgFields() {
  const p = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bad = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const v = pkg[key];
    if (v && Object.keys(v).length) bad.push({ key, entries: Object.keys(v) });
  }
  if (Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.length) bad.push({ key: 'bundledDependencies', entries: pkg.bundledDependencies });
  if (Array.isArray(pkg.bundleDependencies) && pkg.bundleDependencies.length) bad.push({ key: 'bundleDependencies', entries: pkg.bundleDependencies });
  return bad;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '-h' || argv[0] === '--help') {
    printHelp('depcheck.js [options]', SCHEMA,
      'Scan every script for third-party imports and prove the zero-dependency contract.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const dirs = SCAN_DIRS.concat(opts.dir ? String(opts.dir).split(',').map((s) => s.trim()).filter(Boolean) : []);
  const files = [];
  for (const d of dirs) walk(path.join(ROOT, d), files);
  files.sort();

  const violations = [];
  const warnings = [];
  const stats = { builtin: 0, self: 0, external: 0, outside: 0 };
  for (const f of files) {
    const { found, dynamic } = scanFile(f);
    for (const item of found) {
      const kind = classify(item.spec, f);
      stats[kind] += 1;
      if (kind === 'external') violations.push({ file: path.relative(ROOT, f), line: item.line, spec: item.spec, why: 'third-party package' });
      if (kind === 'outside') violations.push({ file: path.relative(ROOT, f), line: item.line, spec: item.spec, why: 'imports outside the skill root' });
    }
    for (const item of dynamic) {
      const msg = { file: path.relative(ROOT, f), line: item.line, spec: item.spec, why: 'dynamic specifier — cannot be proven self-authored' };
      if (opts.strict) violations.push(msg); else warnings.push(msg);
    }
  }
  for (const b of pkgFields()) {
    violations.push({ file: 'package.json', line: 0, spec: b.key, why: `declares ${b.entries.join(', ')}` });
  }
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    violations.push({ file: 'node_modules', line: 0, spec: 'node_modules/', why: 'vendored dependencies directory present' });
  }

  const report = {
    ok: !violations.length,
    files: files.length,
    imports: stats,
    violations,
    warnings
  };
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`自研合规扫描：${files.length} 个代码文件`);
    console.log(`  引用分类  Node 内置 ${stats.builtin} · 自研 ${stats.self} · 第三方 ${stats.external} · 越界 ${stats.outside}`);
    for (const v of violations) console.log(`  ✗ ${v.file}:${v.line}  ${v.spec} — ${v.why}`);
    for (const w of warnings) console.log(`  · ${w.file}:${w.line}  ${w.spec} — ${w.why}`);
    console.log(violations.length
      ? `\nFAIL: ${violations.length} 处违反「零第三方依赖」`
      : `\nOK: 零第三方依赖（${warnings.length} 处动态引用${opts.strict ? '' : '，--strict 可升级为违规'}）`);
  }
  process.exit(violations.length ? 1 : 0);
}

main();
