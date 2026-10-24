'use strict';
/**
 * entries.js — compose library entries at build time.
 *
 * Power flags and net ports are per-net documents: the net name is baked into
 * the symbol, so a project needs one entry per net (VCC, GND, 3V3, ...).
 * Used by build.js and load-library.js.
 */

const E = require('./eprj3');

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

/** Net port entry (cross-sheet / off-page connection point) for `net`. */
function buildPortEntry(project, net, name) {
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

module.exports = { buildPowerEntry, buildPortEntry, NET_ATTRS };
