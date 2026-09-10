#!/usr/bin/env node
'use strict';
/**
 * load-library.js — inspect the preset template library and manage a
 * project's temp staging area.
 *
 * Two tiers: preset templates ship with the skill under
 * templates/library/{symbol,footprint}/ (resolved FIRST when placing); temp
 * entries generated during authoring live under
 * <project>/.tmp/library/{symbol,footprint}/ and are removed by cleanup.js.
 *
 *   list    [--dir <project>]                 presets, plus temp if --dir
 *   show    --name <entry> [--dir <project>]
 *   power   --dir <project> --net VCC [--style up|down] [--name <entry>]
 *   port    --dir <project> --net SIG [--name <entry>]
 *   remove  --name <entry> --dir <project>          (temp entries only)
 *
 * Preset symbols/footprints are placed directly: add-symbol.js --symbol
 * RES [--footprint R0603], add-footprint.js --symbol RES --footprint R0603.
 * Use power/port here only for nets that no preset covers; names shadowing a
 * preset are rejected.
 */
const fs = require('fs');
const path = require('path');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory (required for power/port/remove)' },
  { name: 'name', desc: 'entry name' },
  { name: 'net', desc: 'net name (power/port)' },
  { name: 'style', desc: 'up (default) or down (power)', default: 'up' }
];

function loadEntryAt(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function resolveEntry(opts, name) {
  if (!name) die('missing --name');
  const preset = E.libraryFileIn(E.LIBRARY_DIR, name);
  if (preset) return { file: preset, src: 'preset' };
  if (opts.dir) {
    const tmp = E.libraryFileIn(path.join(E.Project.load(path.resolve(opts.dir)).tmpLibraryDir()), name);
    if (tmp) return { file: tmp, src: 'tmp' };
  }
  const where = opts.dir ? 'presets or project staging' : 'presets (pass --dir to include project staging)';
  die(`library entry not found: ${name} (${where}; see load-library.js list)`);
}

function summarize(src, name, e) {
  let extra = '';
  if (e.kind === 'symbol') extra = e.title || '';
  else if (e.kind === 'footprint') extra = `${e.title}, ${e.footprintElems.pads.length} pads`;
  else if (e.kind === 'power') extra = `${e.net} (${e.style})`;
  else if (e.kind === 'port') extra = e.net;
  console.log(`${src.padEnd(7)} ${name.padEnd(24)} ${e.kind.padEnd(10)} ${extra}`);
}

function cmdList(opts) {
  const projects = E.listLibraryDir(E.LIBRARY_DIR);
  if (!projects.length) console.log('(no preset templates)');
  for (const name of projects) {
    const file = E.libraryFileIn(E.LIBRARY_DIR, name);
    summarize('preset', name, loadEntryAt(file));
  }
  if (opts.dir) {
    const tmpDir = E.Project.load(path.resolve(opts.dir)).tmpLibraryDir();
    for (const name of E.listLibraryDir(tmpDir)) {
      summarize('tmp', name, loadEntryAt(E.libraryFileIn(tmpDir, name)));
    }
  }
}

function cmdShow(opts) {
  const { file } = resolveEntry(opts, opts.name);
  const e = loadEntryAt(file);
  const { symbolDoc, footprintDoc, deviceDoc, powerSymbolDoc, powerDeviceDoc, portSymbolDoc, portDeviceDoc, ...rest } = e;
  const summary = Object.assign({}, rest);
  for (const k of ['symbolDoc', 'footprintDoc', 'deviceDoc', 'powerSymbolDoc', 'powerDeviceDoc', 'portSymbolDoc', 'portDeviceDoc']) {
    if (e[k]) summary[k] = `<${e[k].length} lines>`;
  }
  console.log(JSON.stringify(summary, null, 2));
}

// checkFree for the temp tier: same-name entries may not switch kind, and no
// temp entry may shadow a preset (placement resolves presets first).
function checkFree(project, name, kind) {
  if (project.presetHas(name)) {
    die(`entry name "${name}" shadows a preset template; pick another name`);
  }
  const file = E.libraryFileIn(project.tmpLibraryDir(), name);
  if (file) {
    const old = loadEntryAt(file);
    if (old.kind !== kind) {
      die(`library entry "${name}" already exists as kind "${old.kind}"; remove it first`);
    }
  }
}

function cmdPower(opts) {
  if (!opts.dir) die('power needs --dir <project>');
  if (!opts.net) die('power needs --net <name>');
  if (!['up', 'down'].includes(opts.style)) die('--style must be up or down');
  const project = E.Project.load(path.resolve(opts.dir));
  const name = opts.name || opts.net;
  checkFree(project, name, 'power');
  const symbolUuid = E.uuid16();
  const deviceUuid = E.uuid16();
  const ms = project.ms();
  const powerSymbolDoc = E.buildPowerSymbolDoc({
    uuid: symbolUuid,
    client: project.client,
    title: name,
    net: opts.net,
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    ms,
    style: opts.style
  });
  const powerDeviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: name,
    designator: null,
    symbolUuid,
    tags: ['特殊器件', '网络标识'],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    client: project.client,
    ms,
    attributes: {
      'Global Net Name': opts.net,
      Name: opts.net,
      Description: '',
      '3D Model': '',
      '3D Model Title': '',
      '3D Model Transform': ''
    }
  });
  project.saveLibrary({
    name,
    kind: 'power',
    title: name,
    net: opts.net,
    style: opts.style,
    symbolUuid,
    deviceUuid,
    powerSymbolDoc,
    powerDeviceDoc
  });
  console.log(`staged power symbol "${name}" (${opts.net}, ${opts.style}) -> .tmp/library/symbol/${name}.json`);
  console.log(`next: node scripts/add-symbol.js --dir ${opts.dir} --sch <sch> --sheet <sheet> --symbol ${name} --x <x> --y <y>`);
}

function cmdPort(opts) {
  if (!opts.dir) die('port needs --dir <project>');
  if (!opts.net) die('port needs --net <name>');
  const project = E.Project.load(path.resolve(opts.dir));
  const name = opts.name || `PORT_${opts.net}`;
  checkFree(project, name, 'port');
  const symbolUuid = E.uuid16();
  const deviceUuid = E.uuid16();
  const portSymbolDoc = E.buildPortSymbolDoc({
    uuid: symbolUuid,
    client: project.client,
    title: name,
    net: opts.net,
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    ms: project.ms()
  });
  const portDeviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title: name,
    designator: null,
    symbolUuid,
    tags: ['特殊器件', '网络标识'],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    client: project.client,
    ms: project.ms(),
    attributes: {
      'Global Net Name': opts.net,
      Name: opts.net,
      Description: '',
      '3D Model': '',
      '3D Model Title': '',
      '3D Model Transform': ''
    }
  });
  project.saveLibrary({
    name,
    kind: 'port',
    title: name,
    net: opts.net,
    symbolUuid,
    deviceUuid,
    portSymbolDoc,
    portDeviceDoc
  });
  console.log(`staged port "${name}" (${opts.net}) -> .tmp/library/symbol/${name}.json`);
  console.log(`next: node scripts/add-symbol.js --dir ${opts.dir} --sch <sch> --sheet <sheet> --symbol ${name} --x <x> --y <y>`);
}

function cmdRemove(opts) {
  if (!opts.dir) die('remove needs --dir <project>');
  const { file, src } = resolveEntry(opts, opts.name);
  if (src === 'preset') die(`"${opts.name}" is a preset template (committed with the skill) — not removable`);
  fs.unlinkSync(file);
  console.log(`removed .tmp/library entry "${opts.name}"`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('load-library.js <command> [options]', SCHEMA,
      'Commands: list | show | power | port | remove');
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  if (cmd === 'list') cmdList(opts);
  else if (cmd === 'show') cmdShow(opts);
  else if (cmd === 'power') cmdPower(opts);
  else if (cmd === 'port') cmdPort(opts);
  else if (cmd === 'remove') cmdRemove(opts);
  else die(`unknown command "${cmd}" (want: list | show | power | port | remove)`);
}

main();
