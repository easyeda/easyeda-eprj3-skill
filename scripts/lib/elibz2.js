'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { uuid, randId, writeRecords, appendRecord } = require('./eprj3');

// .elibz2 layout (typical):
//   manifest.json
//   symbols/<uuid>.json     <- schematic symbol primitives
//   footprints/<uuid>.json  <- PCB primitives
//   shapes/<uuid>.json      <- shared primitives
//   3dmodels/<uuid>.json
//
// The archive may be:
//   (a) a plain zip file, or
//   (b) zlib-compressed bytes whose uncompressed body is a zip file, or
//   (c) a directory of these JSON files
//
// We accept all three.

function openArchive(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Library not found: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return { kind: 'dir', root: filePath };

  const buf = fs.readFileSync(filePath);
  // try plain zip first
  if (buf[0] === 0x50 && buf[1] === 0x4b) return openZipBuffer(buf);
  // try zlib
  try {
    const inflated = zlib.inflateRawSync(buf);
    return openZipBuffer(inflated);
  } catch {}
  try {
    const inflated = zlib.inflateSync(buf);
    return openZipBuffer(inflated);
  } catch {}
  try {
    const inflated = zlib.gunzipSync(buf);
    return openZipBuffer(inflated);
  } catch {}
  throw new Error('elibz2: unrecognized format (not a zip, dir, or zlib stream)');
}

function openZipBuffer(buf) {
  // Avoid native deps: ship a small pure-JS fallback by writing to tmp + using yauzl if available.
  let yauzl;
  try { yauzl = require('yauzl'); } catch {}
  if (yauzl) {
    // synchronously read entries we want
    const entries = {};
    return {
      kind: 'zip',
      async read(name) {
        if (entries[name] !== undefined) return entries[name];
        return new Promise((resolve, reject) => {
          yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
            if (err) return reject(err);
            zf.readEntry();
            zf.on('entry', (entry) => {
              if (entry.fileName === name) {
                zf.openReadStream(entry, (err2, stream) => {
                  if (err2) return reject(err2);
                  const chunks = [];
                  stream.on('data', c => chunks.push(c));
                  stream.on('end', () => {
                    entries[name] = Buffer.concat(chunks).toString('utf8');
                    resolve(entries[name]);
                    zf.readEntry();
                  });
                });
              } else {
                zf.readEntry();
              }
            });
            zf.on('end', () => resolve(entries[name]));
            zf.on('error', reject);
          });
        });
      },
      async list() {
        const names = [];
        return new Promise((resolve, reject) => {
          yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
            if (err) return reject(err);
            zf.readEntry();
            zf.on('entry', (entry) => {
              if (!/\/$/.test(entry.fileName)) names.push(entry.fileName);
              zf.readEntry();
            });
            zf.on('end', () => resolve(names));
            zf.on('error', reject);
          });
        });
      }
    };
  }
  throw new Error('elibz2: zip support requires `npm install yauzl` first');
}

async function readIfExists(arch, name) {
  if (arch.kind === 'dir') {
    const p = path.join(arch.root, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return arch.read(name);
}

async function listEntries(arch, prefix) {
  if (arch.kind === 'dir') {
    const dir = path.join(arch.root, prefix);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(f => prefix + '/' + f);
  }
  const all = await arch.list();
  return all.filter(n => n.startsWith(prefix + '/'));
}

async function readManifest(arch) {
  const txt = await readIfExists(arch, 'manifest.json');
  if (!txt) return { components: [] };
  return JSON.parse(txt);
}

// ---- convert symbol -> esch2 records ----
async function loadSymbol(arch, symId) {
  const txt = await readIfExists(arch, `symbols/${symId}.json`);
  if (!txt) return null;
  return JSON.parse(txt);
}

async function loadFootprint(arch, fpId) {
  const txt = await readIfExists(arch, `footprints/${fpId}.json`);
  if (!txt) return null;
  return JSON.parse(txt);
}

// Write a symbol definition into a SYMBOL document appended to the project.
// Returns the new symbol uuid.
async function writeSymbolRecords(project, symbolName, symbolDoc) {
  const sch = project.ensureSchematic('__symbols__');
  // We store each symbol in its own dedicated SYMBOL .esch2 file alongside the schematic
  // (EasyEDA Pro: symbols are embedded in component placeholders). For maximum portability,
  // we just place a marker doc under sch/_symbols/<name>.esch2
  const dir = path.join(project.rootDir, 'sch', '__symbols__');
  require('fs').mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${symbolName}.esch2`);
  // Build records
  const headDoc = {
    type: 'DOCHEAD',
    ticket: 1,
    id: uuid(8),
    body: {
      docType: 'SYMBOL',
      client: 'easyeda-pro-skill',
      uuid: uuid(16),
      updateTime: Date.now(),
      version: String(Date.now()),
      editVersion: '2.3.0',
      user: {}
    }
  };
  const records = [headDoc];
  // Convert primitives from symbolDoc (shapes/pins/...) into eprj3 records.
  const shapes = symbolDoc.shapes || [];
  let ticket = 1;
  for (const s of shapes) {
    ticket++;
    const body = { ...s, partId: 'pid' + randId() };
    records.push({ head: { type: (s._type || 'OBJ').toUpperCase(), ticket, id: 'e' + randId() }, body });
  }
  writeRecords(file, records);
  return { file, uuid: headDoc.body.body.uuid };
}

module.exports = {
  openArchive,
  readManifest,
  loadSymbol,
  loadFootprint,
  writeSymbolRecords,
  readIfExists,
  listEntries
};