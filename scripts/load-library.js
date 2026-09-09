#!/usr/bin/env node
'use strict';
/**
 * load-library.js — manage the project's staged library (<project>/library/*.json).
 *
 * Staging entries are produced by generate-symbol.js / generate-footprint.js.
 * This tool lists them and combines them into placeable entries:
 *
 *   list    [--dir <project>]
 *   show    --dir <project> --name <entry>
 *   device  --dir <project> --symbol <sym-entry> [--footprint <fp-entry>]
 *           [--name <entry>] [--title T]
 *   power   --dir <project> --net VCC [--style up|down] [--name <entry>] [--title T]
 *   port    --dir <project> --net SIG [--name <entry>] [--title T]
 *   remove  --dir <project> --name <entry>
 *
 * "device" entries (kind "device"/"power"/"port") are what add-symbol.js /
 * add-footprint.js / add-power.js / add-port.js place into the documents.
 */
const fs = require('fs');
const path = require('path');
const E = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory' },
  { name: 'name', desc: 'entry name' },
  { name: 'symbol', desc: 'staged symbol entry (device)' },
  { name: 'footprint', desc: 'staged footprint entry (device)' },
  { name: 'net', desc: 'net name (power)' },
  { name: 'style', desc: 'up (default) or down (power)', default: 'up' },
  { name: 'title', desc: 'device title (default: derived)' }
];

function loadEntry(project, name) {
  if (!name) die('missing --name');
  const file = project.libraryFile(name);
  if (!fs.existsSync(file)) {
    const known = project.listLibrary().join(', ') || 'none';
    die(`library entry not found: ${name} (staged: ${known})`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkFree(project, name, kind) {
  const file = project.libraryFile(name);
  if (fs.existsSync(file)) {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.kind !== kind) {
      die(`library entry "${name}" already exists as kind "${old.kind}"; remove it first`);
    }
  }
}

function cmdList(project) {
  const names = project.listLibrary();
  if (!names.length) { console.log('(no staged library entries)'); return; }
  for (const n of names) {
    const e = loadEntry(project, n);
    let extra = '';
    if (e.kind === 'symbol') extra = e.symbolTitle;
    else if (e.kind === 'footprint') extra = `${e.footprintTitle}, ${e.footprintElems.pads.length} pads`;
    else if (e.kind === 'device') extra = e.footprintUuid ? `${e.deviceTitle} +fp` : e.deviceTitle;
    else if (e.kind === 'power') extra = `${e.net} (${e.style})`;
    else if (e.kind === 'port') extra = e.net;
    console.log(`${n.padEnd(24)} ${e.kind.padEnd(10)} ${extra}`);
  }
}

function cmdShow(project, name) {
  const e = loadEntry(project, name);
  const { symbolDoc, footprintDoc, deviceDoc, powerSymbolDoc, powerDeviceDoc, portSymbolDoc, portDeviceDoc, ...rest } = e;
  const summary = Object.assign({}, rest);
  for (const k of ['symbolDoc', 'footprintDoc', 'deviceDoc', 'powerSymbolDoc', 'powerDeviceDoc', 'portSymbolDoc', 'portDeviceDoc']) {
    const v = e[k];
    if (v) summary[k] = `<${v.length} lines>`;
  }
  console.log(JSON.stringify(summary, null, 2));
}

function cmdDevice(project, opts) {
  if (!opts.symbol) die('device needs --symbol <staged symbol entry>');
  const sym = loadEntry(project, opts.symbol);
  if (sym.kind !== 'symbol') die(`entry "${opts.symbol}" is kind "${sym.kind}", want "symbol"`);
  let fp = null;
  if (opts.footprint) {
    fp = loadEntry(project, opts.footprint);
    if (fp.kind !== 'footprint') die(`entry "${opts.footprint}" is kind "${fp.kind}", want "footprint"`);
  }
  const name = opts.name || opts.symbol;
  checkFree(project, name, 'device');
  const title = opts.title || sym.symbolTitle;
  const deviceUuid = E.uuid16();
  const deviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title,
    designator: sym.designator,
    symbolUuid: sym.symbolUuid,
    footprintUuid: fp ? fp.footprintUuid : undefined,
    footprintName: fp ? fp.footprintTitle : undefined,
    tags: [],
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    client: project.client,
    ms: project.ms()
  });
  project.saveLibrary(name, {
    name,
    kind: 'device',
    deviceUuid,
    deviceTitle: title,
    symbolUuid: sym.symbolUuid,
    footprintUuid: fp ? fp.footprintUuid : null,
    designator: sym.designator,
    description: sym.description || '',
    symbolDoc: sym.symbolDoc,
    deviceDoc,
    placement: sym.placement,
    ...(fp ? {
      footprintDoc: fp.footprintDoc,
      footprintElems: fp.footprintElems,
      attrZ: fp.attrZ
    } : {})
  });
  console.log(`staged device "${name}" (${fp ? 'symbol + footprint' : 'symbol only'}) -> library/${name}.json`);
}

function cmdPower(project, opts) {
  if (!opts.net) die('power needs --net <name>');
  if (!['up', 'down'].includes(opts.style)) die('--style must be up or down');
  const name = opts.name || opts.net;
  checkFree(project, name, 'power');
  const title = opts.title || (opts.style === 'down' ? `Ground-${opts.net}` : `Power-${opts.net}`);
  const symbolUuid = E.uuid16();
  const deviceUuid = E.uuid16();
  const ms = project.ms();
  const powerSymbolDoc = E.buildPowerSymbolDoc({
    uuid: symbolUuid,
    title,
    net: opts.net,
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    ms,
    style: opts.style
  });
  const powerDeviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title,
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
  project.saveLibrary(name, {
    name,
    kind: 'power',
    net: opts.net,
    style: opts.style,
    symbolUuid,
    deviceUuid,
    powerSymbolDoc,
    powerDeviceDoc
  });
  console.log(`staged power symbol "${name}" (${opts.net}, ${opts.style}) -> library/${name}.json`);
}

function cmdPort(project, opts) {
  if (!opts.net) die('port needs --net <name>');
  const name = opts.name || `PORT_${opts.net}`;
  checkFree(project, name, 'port');
  const title = opts.title || `Port-${opts.net}`;
  const symbolUuid = E.uuid16();
  const deviceUuid = E.uuid16();
  const portSymbolDoc = E.buildPortSymbolDoc({
    uuid: symbolUuid,
    title,
    net: opts.net,
    source: E.makeSource(E.uuid32(), project.index.owner_uuid),
    ms: project.ms()
  });
  const portDeviceDoc = E.buildDeviceDoc({
    uuid: deviceUuid,
    title,
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
  project.saveLibrary(name, {
    name,
    kind: 'port',
    net: opts.net,
    symbolUuid,
    deviceUuid,
    portSymbolDoc,
    portDeviceDoc
  });
  console.log(`staged port "${name}" (${opts.net}) -> library/${name}.json`);
}

function cmdRemove(project, name) {
  const file = project.libraryFile(name);
  if (!fs.existsSync(file)) die(`library entry not found: ${name}`);
  fs.unlinkSync(file);
  console.log(`removed library/${name}.json`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp('load-library.js <command> [options]', SCHEMA,
      'Commands: list | show | device | power | port | remove');
    return;
  }
  const { opts } = parseArgs(argv.slice(1), SCHEMA);
  if (!opts.dir) die('missing --dir <project>');
  const project = E.Project.load(path.resolve(opts.dir));

  if (cmd === 'list') cmdList(project);
  else if (cmd === 'show') cmdShow(project, opts.name);
  else if (cmd === 'device') cmdDevice(project, opts);
  else if (cmd === 'power') cmdPower(project, opts);
  else if (cmd === 'port') cmdPort(project, opts);
  else if (cmd === 'remove') cmdRemove(project, opts.name);
  else die(`unknown command "${cmd}" (want: list | show | device | power | port | remove)`);
}

main();
