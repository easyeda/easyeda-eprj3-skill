'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- id generation ----
function uuid(len = 16) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}
function randId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---- record parser/writer ----
// A record is:
//   {"type":"...",...}||{body}|
// Some files use three segments: head||{ticket-id}||{body}|. Both are normalized.
// The body is always valid JSON as a whole, so an '||' inside a JSON string can
// only produce fragments that fail JSON.parse — rejoin those instead of
// treating the middle segment as a ticket block (which would silently empty
// the body).
function parseRecord(line) {
  const parts = line.split('||');
  if (parts.length < 2) return null;
  let head, body;
  try { head = JSON.parse(parts[0]); } catch { return null; }
  if (!head || typeof head !== 'object' || !head.type) return null;
  let bodySrc;
  if (parts.length === 2) {
    bodySrc = parts[1];
  } else {
    let mid = null;
    try { mid = JSON.parse(parts[1]); } catch {}
    if (mid && typeof mid === 'object' && (mid.ticket !== undefined || mid.id !== undefined)) {
      // type|ticket-id|body — merge ticket/id into head, rest is the body
      if (mid.ticket !== undefined && head.ticket === undefined) head.ticket = mid.ticket;
      if (mid.id !== undefined && head.id === undefined) head.id = mid.id;
      bodySrc = parts.slice(2).join('||');
    } else {
      bodySrc = parts.slice(1).join('||');
    }
  }
  // JSON bodies never end with a literal '|', so this only strips the delimiter
  bodySrc = bodySrc.replace(/\|+\s*$/, '');
  if (!bodySrc.trim()) {
    body = {};
  } else {
    try { body = JSON.parse(bodySrc); }
    catch { body = {}; }
  }
  return { head, body, ticket: head.ticket, id: head.id, type: head.type };
}

function readRecords(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = parseRecord(line);
    if (r) records.push(r);
  }
  return records;
}

function formatRecord(head, body) {
  return JSON.stringify(head) + '||' + JSON.stringify(body) + '|';
}

function writeRecords(filePath, records) {
  const text = records.map(r => formatRecord(r.head, r.body)).join('\n') + '\n';
  fs.writeFileSync(filePath, text, 'utf8');
}

// ---- project model ----
class Project {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.name = path.basename(rootDir);
    this.indexFile = path.join(rootDir, `${this.name}.eprj3`);
    this.profile = null;
    this.tickets = new Map();
  }

  static async load(rootDir) {
    const p = new Project(rootDir);
    if (!fs.existsSync(p.indexFile)) throw new Error(`Project index not found: ${p.indexFile}`);
    p.profile = JSON.parse(fs.readFileSync(p.indexFile, 'utf8'));
    return p;
  }

  static async create(rootDir, name) {
    const finalName = name || path.basename(rootDir);
    const existingIndex = path.join(rootDir, `${finalName}.eprj3`);
    if (fs.existsSync(existingIndex)) {
      throw new Error(`Project index already exists: ${existingIndex}. Pick another --dir/--name or remove it first.`);
    }
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    const p = new Project(rootDir);
    p.name = finalName;
    p.indexFile = path.join(rootDir, `${finalName}.eprj3`);
    const now = Date.now();
    const owner = uuid(16);
    const board = uuid(8);
    p.profile = {
      name: finalName,
      owner_uuid: owner,
      creator_uuid: owner,
      created_at: formatDate(now),
      updated_at: formatDate(now),
      modifier_uuid: owner,
      content: '',
      archive: false,
      cbb_project: 0,
      thumb: '',
      ticket: 1,
      g_ticket: 1,
      boards: [],
      block_symbol_attrs_groups: {},
      default_sheet: '',
      branch_uuid: '',
      pcb_count: 0,
      format: 'folder',
      profile: {
        boards: {},
        schematics: {},
        sheets: {},
        pcbs: {},
        panels: {},
        blockSymbols: {},
        owner: { uuid: owner },
        simSchematics: {},
        simulations: {}
      },
      config: { defaultSheet: '', settings: {} }
    };
    fs.writeFileSync(p.indexFile, JSON.stringify(p.profile, null, 2));
    fs.mkdirSync(path.join(rootDir, 'sch'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'pcb'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'panel'), { recursive: true });
    return p;
  }

  save() {
    this.profile.updated_at = formatDate(Date.now());
    fs.writeFileSync(this.indexFile, JSON.stringify(this.profile, null, 2));
  }

  ensureSchematic(name) {
    let sch = Object.values(this.profile.profile.schematics).find(s => s.name === name);
    if (sch) return sch;
    sch = {
      uuid: uuid(8),
      name,
      board: Object.keys(this.profile.profile.boards)[0] || '',
      source: '',
      version: String(Date.now()),
      updateTime: Date.now()
    };
    this.profile.profile.schematics[sch.uuid] = sch;
    if (!Object.keys(this.profile.profile.boards).length) {
      const boardUuid = uuid(8);
      this.profile.profile.boards[boardUuid] = { uuid: boardUuid, title: 'Board1', zIndex: 1 };
      sch.board = boardUuid;
    }
    const dir = path.join(this.rootDir, 'sch', name);
    fs.mkdirSync(dir, { recursive: true });
    this.save();
    return sch;
  }

  ensureSheet(sch, title) {
    let sheet = Object.values(this.profile.profile.sheets).find(s => s.schematic_uuid === sch.uuid && s.title === title);
    if (sheet) return sheet;
    sheet = {
      uuid: uuid(8),
      title,
      schematic_uuid: sch.uuid,
      zIndex: Object.values(this.profile.profile.sheets).filter(s => s.schematic_uuid === sch.uuid).length + 1,
      source: '',
      version: String(Date.now()),
      updateTime: Date.now()
    };
    this.profile.profile.sheets[sheet.uuid] = sheet;
    this.save();
    return sheet;
  }

  sheetFile(sheet) {
    const sch = this.profile.profile.schematics[sheet.schematic_uuid];
    return path.join(this.rootDir, 'sch', sch.name, `${sheet.title}.esch2`);
  }

  ensurePcb(name) {
    let pcb = Object.values(this.profile.profile.pcbs).find(p => p.title === name);
    if (pcb) return pcb;
    pcb = {
      uuid: uuid(8),
      title: name,
      board: Object.keys(this.profile.profile.boards)[0] || '',
      parent_uuid: '',
      source: '',
      version: String(Date.now()),
      updateTime: Date.now()
    };
    this.profile.profile.pcbs[pcb.uuid] = pcb;
    this.profile.pcb_count = Object.keys(this.profile.profile.pcbs).length;
    this.save();
    return pcb;
  }

  pcbFile(pcb) { return path.join(this.rootDir, 'pcb', `${pcb.title}.epcb2`); }

  // ---- get-or-die (read/modify paths: a typo must not silently create things) ----
  requireSchematic(name) {
    const sch = Object.values(this.profile.profile.schematics).find(s => s.name === name);
    if (!sch) {
      const known = Object.values(this.profile.profile.schematics).map(s => s.name).join(', ') || 'none';
      throw new Error(`Schematic not found: "${name}" (existing: ${known})`);
    }
    return sch;
  }

  requireSheet(schematicName, sheetTitle) {
    const sch = this.requireSchematic(schematicName);
    const sheet = Object.values(this.profile.profile.sheets).find(s => s.schematic_uuid === sch.uuid && s.title === sheetTitle);
    if (!sheet) throw new Error(`Sheet not found: "${sheetTitle}" in schematic "${schematicName}"`);
    return { sch, sheet };
  }

  requirePcb(name) {
    const pcb = Object.values(this.profile.profile.pcbs).find(p => p.title === name);
    if (!pcb) throw new Error(`PCB not found: "${name}"`);
    return pcb;
  }

  // ---- ensure document exists on disk (write paths) ----
  // Creates schematic/sheet in the index if missing AND guarantees the .esch2
  // file exists with the DOCHEAD/META/CANVAS preamble — an appendRecord into a
  // bare file would produce a malformed document.
  ensureSheetDocument(schematicName, sheetTitle) {
    const sch = this.ensureSchematic(schematicName);
    const sheet = this.ensureSheet(sch, sheetTitle);
    const file = this.sheetFile(sheet);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim() === '') {
      writeRecords(file, sheetDocRecords(sch, sheet));
    }
    return file;
  }

  ensurePcbDocument(name) {
    const pcb = this.ensurePcb(name);
    const file = this.pcbFile(pcb);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim() === '') {
      writeRecords(file, pcbDocRecords(pcb));
    }
    return file;
  }
}

// Shared document preambles (kept byte-identical to what init.js used to emit)
function sheetDocRecords(sch, sheet) {
  return [
    { head: { type: 'DOCHEAD' }, body: { docType: 'SCH', client: 'easyeda-pro-skill', uuid: sch.uuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } },
    { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: sheet.title, source: '', board: sch.board, zIndex: null } },
    { head: { type: 'CANVAS', ticket: 2, id: 'CANVAS' }, body: { originX: 0, originY: 0 } }
  ];
}

function pcbDocRecords(pcb) {
  return [
    { head: { type: 'DOCHEAD' }, body: { docType: 'PCB', client: 'easyeda-pro-skill', uuid: pcb.uuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } },
    { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: pcb.title, board: pcb.board, source: '' } },
    { head: { type: 'CANVAS', ticket: 2, id: 'CANVAS' }, body: { originX: 0, originY: 0 } },
    { head: { type: 'LAYER', ticket: 3, id: '["LAYER",1]' }, body: { layerType: 'TOP', layerName: 'Top Layer', use: true, show: true, locked: false, activeColor: '#FF0000', activateTransparency: 1, inactiveColor: '#7F0000', inactiveTransparency: 1 } },
    { head: { type: 'LAYER', ticket: 4, id: '["LAYER",2]' }, body: { layerType: 'BOTTOM', layerName: 'Bottom Layer', use: true, show: true, locked: false, activeColor: '#0000FF', activateTransparency: 1, inactiveColor: '#00007F', inactiveTransparency: 1 } }
  ];
}

// Read the DOCHEAD uuid of a document file (symbol/footprint docs), or null.
function readDocHeadUuid(filePath) {
  try {
    const rec = readRecords(filePath).find(r => r.type === 'DOCHEAD');
    return (rec && rec.body && rec.body.uuid) || null;
  } catch { return null; }
}

// ---- record insert helpers ----
function appendRecord(filePath, type, body, ticket, id) {
  const records = fs.existsSync(filePath) ? readRecords(filePath) : [];
  const maxTicket = records.reduce((m, r) => Math.max(m, r.ticket || 0), 0);
  const t = ticket || (maxTicket + 1);
  const recId = id || body.id || randId();
  const head = { type, ticket: t, id: recId };
  records.push({ head, body, ticket: t, id: recId, type });
  writeRecords(filePath, records);
  return { head, body, ticket: t, id: recId, type };
}

function updateRecord(filePath, predicate, mutator) {
  const records = readRecords(filePath);
  let updated = 0;
  for (const r of records) {
    if (predicate(r)) { mutator(r); updated++; }
  }
  writeRecords(filePath, records);
  return updated;
}

function removeRecord(filePath, predicate) {
  const records = readRecords(filePath);
  const kept = records.filter(r => !predicate(r));
  writeRecords(filePath, kept);
  return records.length - kept.length;
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  uuid,
  randId,
  parseRecord,
  readRecords,
  formatRecord,
  writeRecords,
  appendRecord,
  updateRecord,
  removeRecord,
  Project,
  formatDate,
  readDocHeadUuid
};