'use strict';
/**
 * entries.js — compose library entries at build time.
 *
 * Power flags and net ports are per-net documents: the net name is baked into
 * the symbol, so a project needs one entry per net (VCC, GND, 3V3, ...).
 * Used by build.js and load-library.js.
 */

const fs = require('fs');
const path = require('path');
const E = require('./eprj3');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates', 'library', 'symbol');

/**
 * Load a preset symbol entry committed with the skill (`templates/library/
 * symbol/<name>.json`). Presets are client-extracted documents: using them
 * verbatim is the difference between the official net-port symbol and a
 * hand-drawn rectangle, and it keeps the original symbol/device names.
 */
function loadTemplateEntry(name) {
  const file = path.join(TEMPLATE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const NET_ATTRS = (net) => ({
  'Global Net Name': net,
  Name: net,
  Description: '',
  '3D Model': '',
  '3D Model Title': '',
  '3D Model Transform': ''
});

/** Power flag entry for `net`, drawn upward ('up', VCC-like) or downward ('down', GND-like). */
function buildPowerEntry(project, net, style) {
  const name = net;
  const symbolUuid = E.uuid16();
  const deviceUuid = E.uuid16();
  const ms = project.ms();
  const src = () => E.makeSource(E.uuid32(), project.index.owner_uuid);
  return {
    name,
    kind: 'power',
    title: name,
    net,
    style,
    symbolUuid,
    deviceUuid,
    powerSymbolDoc: E.buildPowerSymbolDoc({
      uuid: symbolUuid,
      client: project.client,
      title: name,
      net,
      source: src(),
      ms,
      style
    }),
    powerDeviceDoc: E.buildDeviceDoc({
      uuid: deviceUuid,
      title: name,
      designator: null,
      symbolUuid,
      tags: ['特殊器件', '网络标识'],
      source: src(),
      client: project.client,
      ms,
      attributes: NET_ATTRS(net)
    })
  };
}

/**
 * Net port entry (cross-block / off-page connection point).
 *
 * The client ships a generic Netport symbol whose net lives in the COMPONENT
 * attributes (Name / Global Net Name), not in the symbol document. Reuse the
 * committed client-extracted preset VERBATIM (same geometry, same size, same
 * PORT_BI name) instead of synthesising a per-net rectangle. The rotation of
 * the placed component still follows the wire direction. Falls back to the
 * generated document only when the preset is missing.
 */
function buildPortEntry(project, net, portKind, name) {
  // portKind: 'IN' | 'OUT' | 'BI' — chosen by the router from the pin
  // directions on this block's side of the net (unknown/mixed → BI)
  const k = ['IN', 'OUT', 'BI'].includes(portKind) ? portKind : 'BI';
  const tpl = loadTemplateEntry(`PORT_${k}`) || loadTemplateEntry('PORT_BI');
  if (tpl && tpl.portSymbolDoc && tpl.portDeviceDoc) {
    return {
      name: tpl.name,
      kind: 'port',
      portKind: k,
      title: tpl.title || tpl.name,
      net,
      symbolUuid: tpl.symbolUuid,
      deviceUuid: tpl.deviceUuid,
      portSymbolDoc: tpl.portSymbolDoc,
      portDeviceDoc: tpl.portDeviceDoc,
      preset: true
    };
  }
  const entryName = name || `PORT_${net}`;
  const symbolUuid = E.uuid16();
  const deviceUuid = E.uuid16();
  const ms = project.ms();
  const src = () => E.makeSource(E.uuid32(), project.index.owner_uuid);
  return {
    name: entryName,
    kind: 'port',
    title: entryName,
    net,
    symbolUuid,
    deviceUuid,
    portSymbolDoc: E.buildPortSymbolDoc({
      uuid: symbolUuid,
      client: project.client,
      title: entryName,
      net,
      source: src(),
      ms
    }),
    portDeviceDoc: E.buildDeviceDoc({
      uuid: deviceUuid,
      title: entryName,
      designator: null,
      symbolUuid,
      tags: ['特殊器件', '网络标识'],
      source: src(),
      client: project.client,
      ms,
      attributes: NET_ATTRS(net)
    })
  };
}

module.exports = { buildPowerEntry, buildPortEntry, loadTemplateEntry, NET_ATTRS };
