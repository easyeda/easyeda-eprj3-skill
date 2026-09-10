#!/usr/bin/env node
'use strict';
/**
 * split-elibu.js — split an EasyEDA Pro .elibu library export into staged
 * preset entries under templates/library/{symbol,footprint}/<NAME>.json.
 *
 *   split-elibu --file <path.elibu> [--out <dir>] [--dry-run]
 *
 * An .elibu file is a line-oriented container (same record grammar as
 * .esch2/.epcb2): back-to-back docs, each opened by a DOCHEAD line. Each
 * library item appears as two DOCHEAD+META stub docs followed by the body doc
 * (DOCHEAD + records, no META). Items are deduped by uuid; the stub META
 * carries title/tags/docType/source, the body doc carries the records.
 *
 * Normalization per entry (filename = name = title):
 * - doc = clean DOCHEAD (body kept verbatim, incl. editVersion) + stub META
 *   (ticket = maxBodyTicket+1, title renamed) + body records verbatim.
 *   Original per-doc tickets are kept — they are unique but not ordered;
 * - power/port entries pair the extracted SYMBOL doc with a generated DEVICE
 *   doc (same shape as load-library.js power|port);
 * - the DOCHEAD `client` id still belongs to the exporting account; add-*
 *   rewrite it to the target project's client before embedding.
 *
 * Titles are mapped to template names via NAME_MAP; unmapped titles fall back
 * to a sanitized form and are reported so the mapping can be made explicit.
 */
const fs = require('fs');
const path = require('path');
const E = require('../lib/eprj3');
const { parseArgs, printHelp, die } = require('../lib/utils');

const SCHEMA = [
  { name: 'file', desc: '.elibu file to split', required: true },
  { name: 'out', desc: 'output library dir (default: templates/library)' },
  { name: 'dry-run', desc: 'print entries without writing', hasValue: false }
];

// source META title -> template entry name
const NAME_MAP = {
  '电阻': 'RES',
  'Capacitance': 'CAP',
  'SDFL1608S100KTF': 'IND',
  '1N4007_C9900004759': 'DIODE',
  'Test-Point': 'TEST_POINT',
  'Ground-AGND': 'AGND',
  'Ground-PGND': 'PGND',
  'Ground-GND': 'GND',
  'Power-5V': '5V',
  'Power-VCC': 'VCC',
  'Netport-IN': 'PORT_IN',
  'Netport-OUT': 'PORT_OUT',
  'Netport-BI': 'PORT_BI',
  'Off-Page-Connector-In': 'OFFPAGE_IN',
  'Off-Page-Connector-Out': 'OFFPAGE_OUT',
  'Off-Page-Connector-BI': 'OFFPAGE_BI',
  'Differential-Pairs-Flag': 'DIFF_PAIR',
  'Short-Symbol': 'SHORT',
  'Drawing-Symbol_A4': 'A4',
  'Drawing-Symbol_A3': 'A3',
  'R0603': 'R0603',
  'C0603': 'C0603',
  'L0603': 'L0603',
  'SMA_L4.3-W2.6-LS5.1-RD': 'SMA',
  'Test-Point-0.5mm': 'TP0.5'
};
const DESIGNATORS = { RES: 'R?', CAP: 'C?', IND: 'L?', DIODE: 'D?', TEST_POINT: 'TP?' };
const POWER_STYLE = { AGND: 'down', PGND: 'down', GND: 'down', '5V': 'up', VCC: 'up' };
const PORT_NETS = {
  PORT_IN: 'IN', PORT_OUT: 'OUT', PORT_BI: 'BI',
  OFFPAGE_IN: 'IN', OFFPAGE_OUT: 'OUT', OFFPAGE_BI: 'BI'
};

function kindOf(docType) {
  if (docType === 2 || docType === 20) return 'symbol';
  if (docType === 18) return 'power';
  if (docType === 19 || docType === 25) return 'port';
  if (docType === 22 || docType === 31) return 'special';
  return null;
}

function parseDocs(text) {
  const docs = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf('||');
    if (i < 0) die(`malformed record line: ${line.slice(0, 60)}`);
    const head = JSON.parse(line.slice(0, i));
    if (head.type === 'DOCHEAD') {
      // store the DOCHEAD body; the rebuilt record head is always {"type":"DOCHEAD"}
      cur = { head: JSON.parse(line.slice(i + 2).replace(/\|$/, '')), lines: [] };
      docs.push(cur);
    } else {
      cur.lines.push(line);
    }
  }
  return docs;
}

function recordHead(line) { return JSON.parse(line.slice(0, line.indexOf('||'))); }
function recordBody(line) {
  const rest = line.slice(line.indexOf('||') + 2).replace(/\|$/, '');
  return rest ? JSON.parse(rest) : null;
}
function docUuid(doc) {
  return JSON.parse(doc[0].slice(doc[0].indexOf('||') + 2, doc[0].length - 1)).uuid;
}

// Merge the stub META with the body doc into one normalized doc.
function normalizeDoc(doc, meta, title) {
  const bodyTickets = doc.lines.map((l) => recordHead(l).ticket || 0);
  const metaTicket = Math.max(0, ...bodyTickets) + 1;
  const metaLine = JSON.stringify({ type: 'META', ticket: metaTicket, id: 'META' })
    + '||' + JSON.stringify(Object.assign({}, meta, { title })) + '|';
  return ['{"type":"DOCHEAD"}||' + JSON.stringify(doc.head) + '|', metaLine, ...doc.lines];
}

function maxZOf(docLines) {
  let max = 0;
  for (const l of docLines) {
    const body = recordBody(l);
    if (body && typeof body.zIndex === 'number') max = Math.max(max, body.zIndex);
  }
  return max;
}

function buildSymbolEntry(name, meta, doc, uuid) {
  let designator = null, nameZ = null, designatorZ = null;
  for (const l of doc.lines) {
    const head = recordHead(l);
    if (head.type !== 'ATTR') continue;
    const body = recordBody(l);
    if (!body) continue;
    if (body.key === 'Designator') { designator = body.value; designatorZ = body.zIndex; }
    if (body.key === 'Name') nameZ = body.zIndex;
  }
  const placement = designatorZ !== null
    ? { nameZ: nameZ !== null ? nameZ : designatorZ - 1, designatorZ, symbolZ: maxZOf(doc.lines) + 1 }
    : null;
  return {
    name,
    kind: 'symbol',
    title: name,
    designator: designator || DESIGNATORS[name] || 'U?',
    description: meta.title === name ? '' : meta.title,
    symbolUuid: uuid,
    symbolDoc: normalizeDoc(doc, meta, name),
    placement
  };
}

function buildFootprintEntry(name, meta, doc, uuid) {
  const pads = [];
  let attrFootprint = null, attrDesignator = null, fpZ = null, desZ = null, desValue = null;
  for (const l of doc.lines) {
    const head = recordHead(l);
    const body = recordBody(l);
    if (head.type === 'PAD' && body) pads.push({ num: body.num, elemId: head.id });
    if (head.type === 'ATTR' && body) {
      if (body.key === 'Footprint') { attrFootprint = head.id; fpZ = body.zIndex; }
      if (body.key === 'Designator') { attrDesignator = head.id; desZ = body.zIndex; desValue = body.value; }
    }
  }
  if (!pads.length) die(`footprint "${name}" has no PAD records`);
  return {
    name,
    kind: 'footprint',
    title: name,
    designator: desValue || 'U?',
    description: meta.title === name ? '' : meta.title,
    footprintUuid: uuid,
    footprintDoc: normalizeDoc(doc, meta, name),
    footprintElems: { pads, attrFootprint, attrDesignator },
    attrZ: { footprint: fpZ, designator: desZ }
  };
}

// Power/port/special entries pair the real SYMBOL doc with a generated DEVICE
// doc (buildDeviceDoc shape mirrors load-library.js power|port).
function deviceDocFor(kind, name, net, symbolUuid) {
  return E.buildDeviceDoc({
    uuid: E.uuid16(),
    title: name,
    designator: null,
    symbolUuid,
    tags: kind === 'special' ? ['特殊器件'] : ['特殊器件', '网络标识'],
    source: E.makeSource(E.uuid32(), E.uuid32()),
    client: '0000000000000000', // rewritten to the project client on embedding
    ms: Date.now(),
    attributes: kind === 'special'
      ? { Name: name, Description: '' }
      : {
          'Global Net Name': net,
          Name: net,
          Description: '',
          '3D Model': '',
          '3D Model Title': '',
          '3D Model Transform': ''
        }
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('split-elibu.js [options]', SCHEMA,
      'Split an EasyEDA Pro .elibu library export into templates/library entries.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const outDir = path.resolve(opts.out || E.LIBRARY_DIR);
  const text = fs.readFileSync(opts.file, 'utf8');

  // Dedupe: two META stubs + one body doc per uuid.
  const stubMeta = new Map();
  const bodyDocs = new Map();
  for (const doc of parseDocs(text)) {
    const allMeta = doc.lines.length > 0 && doc.lines.every((l) => recordHead(l).type === 'META');
    if (allMeta) {
      if (!stubMeta.has(doc.head.uuid)) stubMeta.set(doc.head.uuid, recordBody(doc.lines[0]));
    } else {
      if (bodyDocs.has(doc.head.uuid)) die(`duplicate body doc for uuid ${doc.head.uuid}`);
      bodyDocs.set(doc.head.uuid, doc);
    }
  }

  const written = [];
  for (const [uuid, doc] of bodyDocs) {
    const meta = stubMeta.get(uuid) || {};
    const rawTitle = meta.title || uuid;
    let name = NAME_MAP[rawTitle];
    if (!name) {
      name = rawTitle.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
      if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) {
        die(`unmapped title "${rawTitle}" normalizes to unusable name "${name}" — extend NAME_MAP`);
      }
      console.warn(`warning: unmapped title "${rawTitle}" -> "${name}"`);
    }

    const kind = doc.head.docType === 'FOOTPRINT' ? 'footprint' : kindOf(meta.docType);
    if (!kind) die(`uuid ${uuid} ("${rawTitle}"): unsupported docType ${meta.docType}`);

    let entry;
    if (kind === 'footprint') {
      entry = buildFootprintEntry(name, meta, doc, uuid);
    } else if (kind === 'symbol') {
      entry = buildSymbolEntry(name, meta, doc, uuid);
    } else if (kind === 'power') {
      const powerSymbolDoc = normalizeDoc(doc, meta, name);
      const deviceDoc = deviceDocFor('power', name, name, uuid);
      entry = {
        name, kind: 'power', title: name, net: name,
        style: POWER_STYLE[name] || 'up',
        symbolUuid: uuid,
        deviceUuid: docUuid(deviceDoc),
        powerSymbolDoc,
        powerDeviceDoc: deviceDoc
      };
    } else if (kind === 'port') {
      const net = PORT_NETS[name] || name;
      const portSymbolDoc = normalizeDoc(doc, meta, name);
      const deviceDoc = deviceDocFor('port', name, net, uuid);
      entry = {
        name, kind: 'port', title: name, net,
        symbolUuid: uuid,
        deviceUuid: docUuid(deviceDoc),
        portSymbolDoc,
        portDeviceDoc: deviceDoc
      };
    } else {
      const symbolDoc = normalizeDoc(doc, meta, name);
      const deviceDoc = deviceDocFor('special', name, null, uuid);
      entry = {
        name, kind: 'special', title: name,
        symbolUuid: uuid,
        deviceUuid: docUuid(deviceDoc),
        symbolDoc,
        deviceDoc
      };
    }

    const sub = kind === 'footprint' ? 'footprint' : 'symbol';
    const file = path.join(outDir, sub, `${name}.json`);
    written.push({ name, kind, file });
    if (opts['dry-run']) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');
  }

  for (const w of written) {
    console.log(`${w.kind.padEnd(10)} ${w.name}  ->  ${path.relative(process.cwd(), w.file) || w.file}`);
  }
  console.log(`\n${written.length} entries${opts['dry-run'] ? ' (dry-run, nothing written)' : ' written'}`);
}

main();
