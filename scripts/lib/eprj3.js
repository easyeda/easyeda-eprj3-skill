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

// monotonically increasing ticket, persisted per file
class TicketCounter {
  constructor(start = 1) { this.value = start; }
  next() { return ++this.value; }
}

// ---- record parser/writer ----
// A record is:
//   {"type":"...",...}||{body}|
// Some files use three segments: type|ticket-id|body. Both formats are normalized.
function parseRecord(line) {
  const parts = line.split('||');
  if (parts.length < 2) return null;
  let head, body;
  try { head = JSON.parse(parts[0]); } catch { return null; }
  if (!head || typeof head !== 'object' || !head.type) return null;
  let bodySrc;
  if (parts.length === 2) {
    bodySrc = parts[1];
  } else if (parts.length === 3) {
    // type|ticket-id|body — merge ticket/id into head, take last segment as body
    try {
      const ticketBlock = JSON.parse(parts[1]);
      if (ticketBlock && typeof ticketBlock === 'object') {
        if (ticketBlock.ticket !== undefined && head.ticket === undefined) head.ticket = ticketBlock.ticket;
        if (ticketBlock.id !== undefined && head.id === undefined) head.id = ticketBlock.id;
      }
    } catch {}
    bodySrc = parts[2];
  } else {
    bodySrc = parts.slice(1).join('||');
  }
  // Strip trailing pipe delimiter and any whitespace
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
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    const finalName = name || path.basename(rootDir);
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
}

// ---- record insert helpers ----
function appendRecord(filePath, type, body, ticket) {
  const records = fs.existsSync(filePath) ? readRecords(filePath) : [];
  const maxTicket = records.reduce((m, r) => Math.max(m, r.ticket || 0), 0);
  const t = ticket || (maxTicket + 1);
  const id = body.id || randId();
  const head = { type, ticket: t, id };
  records.push({ head, body, ticket: t, id, type });
  writeRecords(filePath, records);
  return { head, body, ticket: t, id, type };
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
  TicketCounter,
  parseRecord,
  readRecords,
  formatRecord,
  writeRecords,
  appendRecord,
  updateRecord,
  removeRecord,
  Project,
  formatDate
};