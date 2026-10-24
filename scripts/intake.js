#!/usr/bin/env node
'use strict';
/**
 * intake.js — requirement capture, clarification and recipe selection.
 *
 *   node scripts/intake.js template [--out req.json]     # the fixed form
 *   node scripts/intake.js fields                        # tier/key/default table
 *   node scripts/intake.js check --req req.json [--json]  # what is missing / asked / defaulted
 *   node scripts/intake.js resolve --req req.json [--out design.json] \
 *        [--set cout=22uF] [--recipe ldo-3v3,mcu-min] [--no-cache] [--json]
 *
 * `check` is the clarification protocol: required fields come back as exact
 * questions (exit 1 — the agent must ask), ask-tier fields come back as one
 * question with the default it would fall back to, default-tier fields are
 * applied silently and merely *reported*. The agent asks everything at once.
 *
 * `resolve` turns a complete requirement into a design.json plus a plan summary
 * (the confirmation gate). Recipe selection is a keyword table; selections are
 * cached in .cache/intake.json so a repeated request costs one file read.
 *
 * Exit codes: 0 ok · 1 requirement incomplete · 2 bad input.
 */
const fs = require('fs');
const path = require('path');
const I = require('./lib/intake');
const D = require('./lib/design');
const M = require('./lib/merge');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'req', desc: 'requirement json (check/resolve)' },
  { name: 'out', desc: 'write the resolved design.json here' },
  { name: 'set', desc: 'recipe param overrides: k=v,k=v' },
  { name: 'recipe', desc: 'force recipes (comma separated), bypassing keyword matching' },
  { name: 'no-cache', desc: 'ignore/refresh the selection cache', hasValue: false },
  { name: 'json', desc: 'machine-readable output', hasValue: false }
];

function readReq(file) {
  if (!file) die('missing --req <file.json>');
  const p = path.resolve(file);
  if (!fs.existsSync(p)) die(`requirement file not found: ${p}`);
  try {
    return { file: p, req: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    die(`requirement file is not valid JSON: ${e.message}`);
    return null;
  }
}

function cmdTemplate(opts) {
  const text = JSON.stringify(I.template(), null, 2) + '\n';
  if (opts.out) {
    const p = path.resolve(opts.out);
    fs.writeFileSync(p, text, 'utf8');
    console.log(`requirement form → ${p}`);
    console.log('fill it, then: node scripts/intake.js check --req ' + path.relative(process.cwd(), p));
    return;
  }
  process.stdout.write(text);
}

function cmdFields(opts) {
  if (opts.json) {
    console.log(JSON.stringify({ fields: I.FIELDS, confirm: I.CONFIRM, recipes: M.recipeNames() }, null, 2));
    return;
  }
  console.log(I.fieldsTable());
  console.log(`\n确认点: ${I.CONFIRM.join(' / ')}`);
  console.log(`可用 recipe (${M.recipeNames().length}): ${M.recipeNames().join(' ')}`);
  console.log('详见 docs/intake.md');
}

function cmdCheck(opts) {
  const { req } = readReq(opts.req);
  const chk = I.check(req);
  if (opts.json) {
    console.log(JSON.stringify(Object.assign({ ok: chk.ready }, chk), null, 2));
  } else {
    console.log(I.renderQuestions(chk));
    console.log(`\n${chk.ready ? '必填齐了，可以 resolve' : `还缺 ${chk.missing.length} 项必填——先问用户`}`);
  }
  process.exit(chk.ready ? 0 : 1);
}

function cmdResolve(opts) {
  const { file, req } = readReq(opts.req);
  const overrides = M.parsePairs(opts.set, 'set');
  const forced = opts.recipe ? String(opts.recipe).split(',').map((s) => s.trim()).filter(Boolean) : [];
  for (const name of forced) {
    if (!M.recipeNames().includes(name)) die(`unknown recipe "${name}" (see scripts/recipe.js list)`);
  }
  let out;
  try {
    out = I.resolve(req, { params: overrides, recipes: forced, noCache: !!opts['no-cache'] });
  } catch (e) {
    if (e.intake) {
      console.error(I.renderQuestions(e.intake));
      console.error('\nrequirement incomplete — ask these, then re-run resolve');
      process.exit(1);
    }
    die(e.message);
    return;
  }

  // Shape-check before handing it over: a design.json that cannot normalize is
  // not a starting point, it is a bug in the selection table.
  try {
    D.normalize(JSON.parse(JSON.stringify(out.design)), 'intake-design.json');
  } catch (e) {
    console.error(`resolved design failed to normalize: ${e.message}`);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: e.message, plan: out.plan }, null, 2));
    process.exit(2);
  }

  const text = JSON.stringify(out.design, null, 2) + '\n';
  let outPath = null;
  if (opts.out) {
    outPath = path.resolve(opts.out);
    fs.writeFileSync(outPath, text, 'utf8');
  }
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      requirement: file,
      written: outPath,
      plan: out.plan,
      recipes: out.used.map((u) => ({ recipe: u.recipe, fromCache: u.fromCache, parts: u.parts })),
      design: out.design
    }, null, 2));
    return;
  }
  console.log(I.renderPlan(out.plan));
  if (outPath) console.log(`\ndesign → ${outPath}`);
  else console.log('\n(未写文件：加 --out design.json 输出)\n' + text.trimEnd());
  const target = outPath ? path.relative(process.cwd(), outPath) : 'design.json';
  console.log(`\n下一步（先看方案，不要直接写盘）：`);
  console.log(`  node scripts/build.js --design ${target} --dir <project dir> --plan`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('intake.js <template|fields|check|resolve> [options]', SCHEMA,
      'Requirement intake: fixed input spec, one-pass clarification, recipe selection → design.json.');
    return;
  }
  const { opts, positional } = parseArgs(argv.slice(1), SCHEMA);
  if (!opts.req && positional.length && (cmd === 'check' || cmd === 'resolve')) opts.req = positional[0];
  if (cmd === 'template') { cmdTemplate(opts); return; }
  if (cmd === 'fields') { cmdFields(opts); return; }
  if (cmd === 'check') { cmdCheck(opts); return; }
  if (cmd === 'resolve') { cmdResolve(opts); return; }
  die(`unknown command "${cmd}" (want: template | fields | check | resolve)`);
}

main();
