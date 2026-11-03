#!/usr/bin/env node
'use strict';
/**
 * pack.js — build the release asset (a zip of one git ref).
 *
 *   node scripts/pack.js                 # package HEAD  -> dist/easyeda-eprj3-skill-<ver>.zip
 *   node scripts/pack.js --ref v1.36.0   # package an older release (the 1.x line)
 *
 * Uses `git archive`, so the asset contains exactly the tracked files at that
 * ref (no tmp/, no node_modules) under one top-level folder, which is what a
 * user unzips into .claude/skills/. Zero npm dependencies.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ref = opt('ref') || 'HEAD';
const root = path.resolve(__dirname, '..');

function git(argv, opts) {
  const res = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(opts || {}) });
  if (res.status !== 0) {
    throw new Error(`git ${argv.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout;
}

function main() {
  const pkg = JSON.parse(git(['show', `${ref}:package.json`]));
  const version = pkg.version || '0.0.0';
  const outDir = path.join(root, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `easyeda-eprj3-skill-${version}.zip`);
  git(['archive', '--format=zip', '--prefix=easyeda-eprj3-skill/', '-o', out, ref]);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  const size = fs.statSync(out).size;
  process.stdout.write(`${JSON.stringify({ ok: true, ref, version, file: out, size, sha256: sha }, null, 2)}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}
