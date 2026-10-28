#!/usr/bin/env node
'use strict';
/**
 * corpus.js — the formal legal / illegal eprj3 test corpus.
 *
 * Two halves, both declared in test/corpus/*.json (see docs/corpus.md):
 *
 *   legal    projects every gate must ACCEPT — 0 validate errors and (for
 *            generated ones) 0 ERC errors. These are the witnesses that the
 *            checkers do not cry wolf. A committed project this skill did not
 *            author is marked "formatOnly": the format gate must still accept it.
 *   illegal  copies of a legal baseline with ONE minimal tampering, each with an
 *            `expect` naming the checker + code/message fragment that must fire.
 *
 * Baselines come from the real build chain
 * (`scripts/build.js --design examples/designs/blink.json --dir <tmp>`), so the
 * corpus never depends on committed artifacts drifting from the generator, and
 * committed samples are copied into the temp dir before being corrupted — the
 * repository is never written to.
 *
 *   node test/corpus.js                 run the corpus (exit 1 on any FAIL)
 *   node test/corpus.js --probe         mutate, print what each gate ACTUALLY
 *                                       reports, assert nothing (manifest authoring)
 *   node test/corpus.js --only <name>   subset, by variant name fragment
 *
 * Expectation keys (values come from a real --probe run, never guessed):
 *   expect.validate / validateWarnings  substrings of the format gate's messages
 *   expect.erc / ercWarnings            ERC finding ids (E00x / W00x)
 *   expect.lint / expect.drc            finding codes (L0xx / D0xx)
 *   expect.leak = true                  recorded BLIND SPOT: nothing is expected
 *                                       to report it. Prints, never fails.
 *   expect.crash = ["validate", ...]    recorded ROBUSTNESS gap: those gates
 *                                       throw instead of reporting. Prints only.
 *   item.blindTo = ["validate", ...]    documentation: another gate caught this
 *                                       one, but these did not.
 *
 * Every expectation is also checked against the pristine baseline: a code the
 * untouched project already reports makes the assertion vacuous and FAILS.
 *
 * Output style follows test/smoke.js: `ok` / `FAIL` lines, then
 * `N/M checks passed`, exit 1 on failure. All work happens in a throwaway
 * directory under os.tmpdir(), removed on exit (`--probe` keeps it and prints
 * the path).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnCaptured } = require('./capture');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CORPUS_DIR = path.join(__dirname, 'corpus');

const E = require(path.join(SCRIPTS, 'lib', 'eprj3'));
const D = require(path.join(SCRIPTS, 'lib', 'design'));
const { runValidate } = require(path.join(SCRIPTS, 'lib', 'checks'));
const { runErc } = require(path.join(SCRIPTS, 'lib', 'erc'));
const { lintProject } = require(path.join(SCRIPTS, 'lib', 'lint'));
const { runDrc, pcbGeometry } = require(path.join(SCRIPTS, 'lib', 'drc'));

const PROBE = process.argv.includes('--probe');
const ONLY = argValue('--only');

let failures = 0;
let checks = 0;
let blindSpots = 0;
const gapLog = [];
const catchLog = [];

function assert(cond, name, detail = '') {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function note(name, detail) {
  console.log(`  ..  ${name}${detail ? `\n      ${detail}` : ''}`);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// -------------------------------------------------------------------- gates
// Each gate is called in-process (no child stdio to capture) and never allowed
// to abort the corpus: a checker that throws on corruption is reported as a
// crash, which is information, not a pass.
function runGates(dir, designFile) {
  const out = {};
  try {
    const { errors, warnings } = runValidate(dir);
    out.validate = { errors, warnings };
  } catch (e) {
    out.validate = { crashed: e.message, errors: [], warnings: [] };
  }
  let design;
  try {
    design = designFile ? D.readDesign(designFile) : undefined;
  } catch (e) {
    out.designError = e.message;
  }
  try {
    const r = runErc(dir, { design, pcb: true });
    out.erc = {
      errors: r.errors.map((x) => ({ id: x.id, msg: x.msg })),
      warnings: r.warnings.map((x) => ({ id: x.id, msg: x.msg }))
    };
  } catch (e) {
    out.erc = { crashed: e.message, errors: [], warnings: [] };
  }
  try {
    const l = lintProject(dir);
    out.lint = { findings: l.findings.map((f) => ({ code: f.code, level: f.level, msg: f.msg })) };
  } catch (e) {
    out.lint = { crashed: e.message, findings: [] };
  }
  try {
    const project = E.Project.load(dir);
    const pcbs = Object.values(project.profile.pcbs || {});
    if (!pcbs.length) {
      out.drc = { skipped: 'no pcb in project', findings: [] };
    } else {
      const file = project.pcbFile(pcbs[0]);
      const spec = (design && design.pcbSpec) || {};
      const rules = (spec.rules) || {};
      const r = runDrc(file, {
        rules,
        netWidths: (design && design.netWidths) || {},
        pourNet: (spec.pour && spec.pour.net) || 'GND'
      });
      out.drc = { findings: r.findings.map((f) => ({ code: f.code, level: f.level, msg: f.msg })) };
    }
  } catch (e) {
    out.drc = { crashed: e.message, findings: [] };
  }
  return out;
}

// ---------------------------------------------------------------- manifests
// Windows editors and PowerShell both like to prepend a BOM to a UTF-8 file;
// JSON.parse chokes on it, so every manifest read strips one if present.
// The loader drops a leading BOM by code point, so no invisible character is stored.
function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // drop a UTF-8 BOM
  return JSON.parse(text);
}

function readManifests() {
  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).sort();
  const legal = [];
  const illegal = [];
  for (const f of files) {
    const data = readJson(path.join(CORPUS_DIR, f));
    for (const item of data.legal || []) legal.push(Object.assign({ file: f }, item));
    for (const item of data.illegal || []) illegal.push(Object.assign({ file: f }, item));
  }
  if (!legal.length) throw new Error('corpus manifests contain no legal projects');
  if (!illegal.length) throw new Error('corpus manifests contain no illegal variants');
  return { legal, illegal };
}

// Baselines: every legal project is a possible clone source. Built designs come
// from the real build chain; committed projects are COPIED into the temp dir
// first, so a variant can never touch the repository. Each baseline snapshots
// the file layout (variants corrupt the index, so paths must be known upfront)
// and its own gate output, which the vacuity guard compares expectations against.
function snapshotBaseline(key, dir, designFile, gates) {
  const project = E.Project.load(dir);
  const sheets = Object.values(project.profile.sheets);
  const schs = Object.values(project.profile.schematics);
  const pcbs = Object.values(project.profile.pcbs || {});
  const panels = Object.values(project.profile.panels || {});
  return {
    key,
    dir,
    design: designFile,
    gates,
    layout: {
      root: dir,
      index: project.indexFile,
      ecfg: schs.length ? project.ecfgFile(schs[0]) : null,
      schDir: schs.length ? project.schematicDir(schs[0]) : null,
      sheet: sheets.length ? project.sheetFile(sheets[0]) : null,
      pcb: pcbs.length ? project.pcbFile(pcbs[0]) : null,
      panel: panels.length ? path.join(dir, 'panel', `${panels[0].title}.epan2`) : null,
      panelDir: path.join(dir, 'panel'),
      schematic: schs.length ? schs[0].name : null,
      sheetTitle: sheets.length ? sheets[0].title : null,
      pcbTitle: pcbs.length ? pcbs[0].title : null
    }
  };
}

function prepareBaselines(tmp, entries) {
  const baselines = new Map();
  for (const d of entries) {
    let dir;
    let designFile = null;
    if (d.build) {
      dir = path.join(tmp, `base-${d.key}`);
      designFile = path.join(ROOT, d.build);
      const r = spawnCaptured(process.execPath, [
        path.join(SCRIPTS, 'build.js'),
        '--design', designFile,
        '--dir', dir,
        '--quiet'
      ], { cwd: ROOT });
      assert(r.status === 0, `baseline builds: ${d.key}`,
        `exit ${r.status}\n${(r.stdout || '') + (r.stderr || '')}`.trim());
    } else {
      // committed sample: work on a copy inside the temp root
      dir = path.join(tmp, `base-${d.key}`);
      fs.cpSync(path.join(ROOT, d.dir), dir, { recursive: true });
      if (d.design) designFile = path.join(ROOT, d.design);
    }
    const gates = runGates(dir, designFile);
    if (d.build) {
      // Only generated baselines must be pristine: they are the witness that the
      // corpus tampering is what makes a gate light up.
      assert(!gates.validate.crashed && gates.validate.errors.length === 0,
        `baseline is format-clean: ${d.key}`,
        `${(gates.validate.crashed ? `validate crashed: ${gates.validate.crashed}` : '')
        + gates.validate.errors.map((m) => `\n  - ${m}`).join('')}`);
      assert(!gates.erc.crashed && gates.erc.errors.length === 0,
        `baseline is electric-clean: ${d.key}`,
        `${(gates.erc.crashed ? `erc crashed: ${gates.erc.crashed}` : '')
        + gates.erc.errors.map((x) => `\n  - ${x.id} ${x.msg}`).join('')}`);
    }
    baselines.set(d.key, snapshotBaseline(d.key, dir, designFile, gates));
  }
  return baselines;
}

// ------------------------------------------------------------ dotted paths
function getAt(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAt(obj, dotted, value) {
  const ks = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i += 1) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = value;
}
function delAt(obj, dotted) {
  const ks = dotted.split('.');
  const last = ks.pop();
  const cur = ks.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (cur && typeof cur === 'object') delete cur[last];
}

// ------------------------------------------------------------- file plumbing
function resolveTarget(layout, target) {
  const f = layout[target];
  if (!f) throw new Error(`unknown target "${target}" (want index|ecfg|sheet|pcb|panel|schDir|panelDir|root)`);
  return f;
}

// Split a container file into docs: {start, end, docType, uuid}.
function docRanges(lines) {
  const starts = [];
  lines.forEach((l, i) => { if (E.isDocHeadLine(l)) starts.push(i); });
  return starts.map((start, k) => ({
    start,
    end: k + 1 < starts.length ? starts[k + 1] : lines.length,
    head: (() => { const r = E.parseRecord(lines[start]); return r && r.body ? r.body : {}; })()
  }));
}

// A selector picks records out of one container file.
//   doc:  "main" | "any" | a docType string   (default "main")
//   type: record head type
//   key:  ATTR body.key
//   where: dotted body paths that must compare equal
//   idStartsWith: head.id prefix (["PAD_NET", ...])
//   byDesignator: only records whose head.id is the component that owns this
//                 Designator attr (the ids are random per build, the refdes is not)
//   nth / all: which of the matches to take (default the first)
function selectRecords(file, sel) {
  const lines = E.readLines(file);
  const ranges = docRanges(lines);
  const scope = (sel.doc === 'any' || sel.doc === undefined && sel.type === 'DOCHEAD')
    ? ranges
    : sel.doc === 'main' || !sel.doc
      ? ranges.slice(-1)
      : ranges.filter((r) => r.head.docType === sel.doc);
  let owner = null;
  if (sel.byDesignator) {
    for (const range of scope) {
      for (let i = range.start; i < range.end; i += 1) {
        const r = E.parseRecord(lines[i]);
        if (r && r.type === 'ATTR' && r.body && r.body.key === 'Designator'
          && r.body.value === sel.byDesignator) { owner = r.body.parentId; break; }
      }
      if (owner) break;
    }
    if (!owner) return [];
  }
  const hits = [];
  for (const range of scope) {
    for (let i = range.start; i < range.end; i += 1) {
      const r = E.parseRecord(lines[i]);
      if (!r) continue;
      if (owner !== null && r.id !== owner) continue;
      if (sel.type && r.type !== sel.type) continue;
      if (sel.key && !(r.body && r.body.key === sel.key)) continue;
      if (sel.idStartsWith && !(typeof r.id === 'string' && r.id.startsWith(sel.idStartsWith))) continue;
      if (sel.where) {
        let ok = true;
        for (const [k, v] of Object.entries(sel.where)) {
          if (getAt(r, k) !== v) { ok = false; break; }
        }
        if (!ok) continue;
      }
      hits.push({ index: i, rec: r, range });
    }
  }
  return sel.all ? hits : hits.slice(0, sel.nth === undefined ? 1 : sel.nth + 1).slice(-1);
}

function mapRecords(file, sel, fn) {
  const hits = selectRecords(file, sel);
  if (!hits.length) return 0;
  const lines = E.readLines(file);
  for (const h of hits) {
    fn(h.rec);
    lines[h.index] = E.formatRecord(h.rec.head, h.rec.body);
  }
  E.writeLines(file, lines);
  return hits.length;
}

function removeLinesAt(file, indexes) {
  const lines = E.readLines(file);
  const kill = new Set(indexes);
  E.writeLines(file, lines.filter((_, i) => !kill.has(i)));
  return kill.size;
}

// ------------------------------------------------------------------- mutators
const OPS = {
  json_delete({ layout, step }) {
    const file = resolveTarget(layout, step.target || 'index');
    const data = readJson(file);
    delAt(data, step.path);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return 1;
  },
  json_set({ layout, step }) {
    const file = resolveTarget(layout, step.target || 'index');
    const data = readJson(file);
    setAt(data, step.path, step.value);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return 1;
  },
  json_raw({ layout, step }) {
    const file = resolveTarget(layout, step.target || 'index');
    fs.writeFileSync(file, step.content, 'utf8');
    return 1;
  },
  raw_append({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    fs.appendFileSync(file, step.lines.join('\n') + '\n', 'utf8');
    return step.lines.length;
  },
  record_set({ layout, step }) {
    return mapRecords(resolveTarget(layout, step.target), step.sel, (r) => {
      for (const [k, v] of Object.entries(step.set)) setAt(r, k, v);
    });
  },
  record_unset({ layout, step }) {
    return mapRecords(resolveTarget(layout, step.target), step.sel, (r) => {
      for (const k of step.keys) delAt(r, k);
    });
  },
  record_remove({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const hits = selectRecords(file, step.sel);
    if (!hits.length) return 0;
    return removeLinesAt(file, hits.map((h) => h.index));
  },
  // Duplicate a record verbatim and drop it at end of file (same ticket).
  record_dup({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const hits = selectRecords(file, step.sel);
    if (!hits.length) return 0;
    fs.appendFileSync(file, hits.map((h) => E.formatRecord(h.rec.head, h.rec.body)).join('\n') + '\n', 'utf8');
    return hits.length;
  },
  // Swap the tickets of the last two records of the main doc: still unique, but
  // now the sequence runs backwards at the tail.
  ticket_swap_tail({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const lines = E.readLines(file);
    const range = docRanges(lines).slice(-1)[0];
    const picked = [];
    for (let i = range.end - 1; i >= range.start && picked.length < 2; i -= 1) {
      const r = E.parseRecord(lines[i]);
      if (r && typeof r.ticket === 'number') picked.push({ i, r });
    }
    if (picked.length < 2) return 0;
    const [a, b] = picked; // a = last, b = second to last
    const t = a.r.head.ticket;
    a.r.head.ticket = b.r.head.ticket;
    b.r.head.ticket = t;
    lines[a.i] = E.formatRecord(a.r.head, a.r.body);
    lines[b.i] = E.formatRecord(b.r.head, b.r.body);
    E.writeLines(file, lines);
    return 1;
  },
  // Copy the DOCHEAD uuid of one doc onto another doc: the source doc then
  // duplicates an uuid and disappears from the reference set.
  doc_uuid_duplicate({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const src = selectRecords(file, Object.assign({ type: 'DOCHEAD' }, step.source));
    if (!src.length) return 0;
    return mapRecords(file, Object.assign({ type: 'DOCHEAD' }, step.into), (r) => {
      r.body.uuid = src[0].rec.body.uuid;
    });
  },
  // Remove a WIRE together with every LINE that hangs off it (and its NET attr),
  // exactly the shape of "a wire got lost" corruption.
  wire_remove({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const attrs = selectRecords(file, step.sel);
    if (!attrs.length) return 0;
    const wireId = attrs[0].rec.body.parentId;
    const all = selectRecords(file, { doc: 'main', all: true });
    const doomed = all.filter((h) => (
      h.rec.type === 'WIRE' && h.rec.id === wireId
      || (h.rec.type === 'LINE' && h.rec.body && h.rec.body.lineGroup === wireId)
      || (h.rec.type === 'ATTR' && h.rec.body && h.rec.body.parentId === wireId)
    ));
    return removeLinesAt(file, doomed.map((h) => h.index));
  },
  // Delete ONE segment of the wire that carries a net: the pin behind it falls
  // off the net, which is the smallest honest way to make a dangling pin.
  line_remove_of_net({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const attr = selectRecords(file, {
      doc: 'main', type: 'ATTR', key: 'NET', where: { 'body.value': step.net }
    });
    if (!attr.length) return 0;
    const wireId = attr[0].rec.body.parentId;
    const segs = selectRecords(file, {
      doc: 'main', all: true, type: 'LINE', where: { 'body.lineGroup': wireId }
    });
    if (!segs.length) return 0;
    const pick = step.nth === undefined ? segs[segs.length - 1] : segs[step.nth];
    return removeLinesAt(file, [pick.index]);
  },
  // Drop a placed component with everything that points at it.
  component_remove({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const attr = selectRecords(file, {
      doc: 'main', type: 'ATTR', key: 'Designator', where: { 'body.value': step.designator }
    });
    if (!attr.length) return 0;
    const compId = attr[0].rec.body.parentId;
    const all = selectRecords(file, { doc: 'main', all: true });
    const doomed = all.filter((h) => (
      h.rec.type === 'COMPONENT' && h.rec.id === compId
      || (h.rec.body && h.rec.body.parentId === compId)
      || (h.rec.type === 'PAD_NET' && typeof h.rec.id === 'string'
        && h.rec.id.startsWith('["PAD_NET",') && JSON.parse(h.rec.id)[1] === compId)
    ));
    return removeLinesAt(file, doomed.map((h) => h.index));
  },
  // Since 1.13 the skill builds no copper at all, so copper-tampering variants
  // inject their own witness copper first: straight tracks chaining the pads
  // of one net (net === '*' chains every multi-pad net), or, with a `pour`
  // key, one POUR record carrying that net. Coordinates come from the CURRENT
  // placement (nothing is hardcoded — if the placer moves, the witness moves
  // with it), and the copper only ever exists inside the variant's copy. A
  // board with tracks flips the DRC into full-copper mode, so D001/D004 and
  // the POUR shape rules stay meaningful witnesses.
  copper_prep({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    let ticket = 0;
    for (const l of lines) {
      const r = E.parseRecord(l);
      if (r && r.head && typeof r.head.ticket === 'number') ticket = Math.max(ticket, r.head.ticket);
    }
    const added = [];
    if (step.pour) {
      ticket += 1;
      added.push(E.pcbPourLine({
        netName: step.pour,
        layerId: 1,
        name: 'POUR_PREP',
        path: step.flat
          ? [100, 100, 3000, 100, 3000, 2000, 100, 2000]
          : [[100, 100, 3000, 100, 3000, 2000, 100, 2000]],
        ticketBase: ticket
      }));
      E.writeLines(file, lines.concat(added));
      return added.length;
    }
    const geo = pcbGeometry(file);
    const groups = new Map();
    for (const p of geo.pads) {
      if (!p.net || (step.net !== '*' && p.net !== step.net)) continue;
      if (!groups.has(p.net)) groups.set(p.net, []);
      groups.get(p.net).push(p);
    }
    for (const pads of groups.values()) {
      for (let i = 0; i + 1 < pads.length; i++) {
        ticket += 1;
        added.push(E.pcbTrackLine({
          netName: pads[i].net,
          layerId: 1,
          startX: pads[i].x, startY: pads[i].y,
          endX: pads[i + 1].x, endY: pads[i + 1].y,
          width: step.width || 10,
          ticketBase: ticket
        }));
      }
    }
    if (!added.length) return 0;
    E.writeLines(file, lines.concat(added));
    return added.length;
  },
  // Delete every copper of one net (tracks + vias) — the classic unrouted net.
  remove_net_copper({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    const all = selectRecords(file, { doc: 'main', all: true, where: { 'body.netName': step.net } });
    const doomed = all.filter((h) => h.rec.type === 'LINE' || h.rec.type === 'VIA');
    if (!doomed.length) return 0;
    return removeLinesAt(file, doomed.map((h) => h.index));
  },
  // Nudge a placed component off its coordinates: the smallest honest way to
  // take pins off their wires / off the layout grid.
  component_move({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    return mapRecords(file, {
      doc: 'main', type: 'COMPONENT', byDesignator: step.designator
    }, (r) => {
      r.body.x = (r.body.x || 0) + (step.dx || 0);
      r.body.y = (r.body.y || 0) + (step.dy || 0);
    });
  },
  // Bend one wire segment so it is no longer orthogonal.
  line_skew({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    return mapRecords(file, step.sel, (r) => {
      if (step.dy) r.body.endY = (r.body.endY || 0) + step.dy;
      if (step.dx) r.body.endX = (r.body.endX || 0) + step.dx;
    });
  },
  stray_file({ layout, step }) {
    const file = path.join(resolveTarget(layout, step.target), step.name);
    fs.writeFileSync(file, step.content || 'stray\n', 'utf8');
    return 1;
  },
  file_delete({ layout, step }) {
    const file = resolveTarget(layout, step.target);
    if (!fs.existsSync(file)) return 0;
    fs.rmSync(file, { force: true });
    return 1;
  }
};

function applyMutation(base, item) {
  const target = item.clone;
  fs.cpSync(base.dir, target, { recursive: true });
  const layout = remapLayout(base.layout, target);
  const applied = [];
  for (const step of item.mutation) {
    const fn = OPS[step.op];
    if (!fn) throw new Error(`unknown mutation op "${step.op}" in ${item.name}`);
    const n = fn({ layout, step });
    if (!Number.isFinite(n)) throw new Error(`mutation op ${step.op} in ${item.name} returned no count`);
    applied.push(`${step.op}=${n}`);
  }
  return { dir: target, layout, applied };
}

function remapLayout(layout, dir) {
  const out = {};
  for (const [k, v] of Object.entries(layout)) {
    out[k] = typeof v === 'string' && v.startsWith(layout.root)
      ? path.join(dir, path.relative(layout.root, v))
      : v;
  }
  out.root = dir;
  return out;
}

// ------------------------------------------------------------------- matching
const GATE_NAMES = ['validate', 'erc', 'lint', 'drc'];

function reportedErrorIds(gates) {
  const ids = [];
  for (const m of gates.validate.errors || []) ids.push(`validate:${shorten(m)}`);
  for (const e of gates.erc.errors || []) ids.push(`erc:${e.id}`);
  for (const f of gates.lint.findings || []) if (f.level === 'error') ids.push(`lint:${f.code}`);
  for (const f of gates.drc.findings || []) if (f.level === 'error') ids.push(`drc:${f.code}`);
  return ids;
}

function expectOfSummary(expect) {
  const parts = [];
  if (expect.validate) parts.push(`validate ${expect.validate.length} msg`);
  if (expect.validateWarnings) parts.push(`validate warn ${expect.validateWarnings.length} msg`);
  if (expect.erc) parts.push(`erc ${expect.erc.join('/')}`);
  if (expect.ercWarnings) parts.push(`erc warn ${expect.ercWarnings.join('/')}`);
  if (expect.lint) parts.push(`lint ${expect.lint.join('/')}`);
  if (expect.drc) parts.push(`drc ${expect.drc.join('/')}`);
  return parts.join(', ') || 'some gate';
}

// `baseGates` is the untouched baseline's own report: an expectation it already
// satisfies would prove nothing about the tampering, so it is rejected as vacuous.
function matchExpected(gates, expect, baseGates) {
  const problems = [];
  const seen = [];
  // validate reports plain strings; erc reports {id, msg} — an expectation may
  // name either the finding id or a fragment of its message.
  const hay = (m) => (typeof m === 'string' ? m : `${m.id || ''} ${m.msg}`);
  const msgPool = (g, bucket, warnings) => {
    if (!g || !g[bucket] || g[bucket].crashed) return [];
    return ((warnings ? g[bucket].warnings : g[bucket].errors) || []).map(hay);
  };
  const needSubstring = (list, bucket, label, warnings) => {
    const pool = msgPool(gates, bucket, warnings);
    const before = msgPool(baseGates, bucket, warnings);
    for (const needle of list) {
      if (!pool.some((m) => m.includes(needle))) {
        problems.push(`${label}: missing "${needle}"`);
        continue;
      }
      if (before.some((m) => m.includes(needle))) {
        problems.push(`${label}: "${needle}" already fires on the untouched baseline (vacuous)`);
        continue;
      }
      seen.push(`${label} "${needle}"`);
    }
  };
  const needCode = (list, bucket) => {
    const codePool = (g) => (g && g[bucket] && !g[bucket].crashed
      ? (g[bucket].findings || []).map((f) => f.code) : []);
    const pool = codePool(gates);
    const before = codePool(baseGates);
    for (const code of list) {
      if (!pool.includes(code)) {
        problems.push(`${bucket}: missing ${code}`);
        continue;
      }
      if (before.includes(code)) {
        problems.push(`${bucket}: ${code} already fires on the untouched baseline (vacuous)`);
        continue;
      }
      const hit = (gates[bucket].findings || []).find((f) => f.code === code);
      seen.push(`${bucket} ${code} (${hit.level})`);
    }
  };
  if (expect.validate) needSubstring(expect.validate, 'validate', 'validate error', false);
  if (expect.validateWarnings) needSubstring(expect.validateWarnings, 'validate', 'validate warning', true);
  if (expect.erc) needSubstring(expect.erc, 'erc', 'erc error', false);
  if (expect.ercWarnings) needSubstring(expect.ercWarnings, 'erc', 'erc warning', true);
  if (expect.lint) needCode(expect.lint, 'lint');
  if (expect.drc) needCode(expect.drc, 'drc');
  return { problems, seen };
}

function observed(gates) {
  const bits = [];
  if (gates.validate.crashed) bits.push(`validate CRASHED (${gates.validate.crashed})`);
  else {
    if (gates.validate.errors.length) bits.push(`validate: ${gates.validate.errors.map(shorten).join(' | ')}`);
    if (gates.validate.warnings.length) bits.push(`validate warn: ${gates.validate.warnings.map(shorten).join(' | ')}`);
  }
  if (gates.erc.crashed) bits.push(`erc CRASHED (${gates.erc.crashed})`);
  else {
    if (gates.erc.errors.length) bits.push(`erc: ${[...new Set(gates.erc.errors.map((x) => x.id))].join(',')}`);
    if (gates.erc.warnings.length) bits.push(`erc warn: ${[...new Set(gates.erc.warnings.map((x) => x.id))].join(',')}`);
  }
  const fmt = (bucket) => {
    const g = gates[bucket];
    if (g.crashed) return `${bucket} CRASHED (${g.crashed})`;
    if (g.skipped) return `${bucket} skipped (${g.skipped})`;
    if (!g.findings.length) return null;
    return `${bucket}: ${[...new Set(g.findings.map((f) => f.code))].join(',')}`;
  };
  const l = fmt('lint'); const d = fmt('drc');
  if (l) bits.push(l);
  if (d) bits.push(d);
  return bits.join('  ·  ') || 'nothing reported';
}

function shorten(m) {
  const s = typeof m === 'string' ? m : m.msg;
  const i = s.lastIndexOf(': ');
  return i > 0 && s.length - i < 60 ? s.slice(i + 2) : s.slice(0, 70);
}

// ----------------------------------------------------------------------- main
function main() {
  const { legal, illegal } = readManifests();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), PROBE ? 'eprj3-corpusp-' : 'eprj3-corpus-'));
  // A legal entry becomes a working baseline when it is generated (its build is
  // the clean witness) or when some variant clones it.
  const variantBases = new Set(illegal.map((i) => i.base));
  const entries = legal.filter((l) => l.build || variantBases.has(l.key));
  const missingBase = [...variantBases].filter((k) => !entries.some((e) => e.key === k));

  try {
    console.log(`corpus: ${legal.length} legal, ${illegal.length} illegal variants (${PROBE ? 'PROBE' : 'assert'})`);
    const baselines = prepareBaselines(tmp, entries);
    if (missingBase.length) {
      assert(false, 'every variant names a legal baseline',
        `no legal entry has key: ${missingBase.join(', ')}`);
    }

    // ------------------------------------------------------------ legal half
    console.log('\nlegal corpus — every gate must accept these');
    for (const item of legal) {
      if (ONLY && !item.name.includes(ONLY)) continue;
      let dir = null;
      let design = null;
      if (item.build) {
        const base = baselines.get(item.key);
        dir = base && base.dir;
        design = base && base.design;
      } else {
        dir = path.join(ROOT, item.dir);
        design = item.design ? path.join(ROOT, item.design) : null;
      }
      if (!dir || !fs.existsSync(dir)) {
        assert(false, `legal ${item.name}`, `missing project ${dir}`);
        continue;
      }
      const gates = runGates(dir, design);
      const detail = observed(gates);
      if (PROBE) {
        console.log(`  --  ${item.name}: ${detail}`);
        continue;
      }
      const formatClean = !gates.validate.crashed && gates.validate.errors.length === 0;
      const electricClean = !gates.erc.crashed && gates.erc.errors.length === 0;
      // formatOnly: a project this skill did not author. The format gate must
      // still accept it; its circuit is out of scope for this corpus. But the
      // client-authored sample doubles as the PIN-ATTACHMENT anchor: its
      // human-drawn wires land exactly on the pin record points, so our
      // netlist must see EVERY pin connected — before 1.16.0 the wrong tip
      // formula misread 12 of its 16 pins as unconnected.
      const clean = item.formatOnly ? formatClean : (formatClean && electricClean);
      assert(clean, `legal ${item.name} accepted by ${item.formatOnly ? 'validate' : 'validate+erc'}`,
        `${item.note ? `${item.note}\n      ` : ''}${detail}`);
      if (item.formatOnly) {
        const unconnected = (gates.erc.stats && gates.erc.stats.sheets || [])
          .reduce((n, s) => n + s.unconnected, 0);
        assert(unconnected === 0, `legal ${item.name}: every client-drawn wire reads as attached`,
          `${unconnected} pin(s) misread as unconnected — pin hotspot semantics drifted`);
      }
      if (item.mustPassDrc) {
        const dOk = !gates.drc.crashed && !gates.drc.findings.some((f) => f.level === 'error');
        assert(dOk, `legal ${item.name} accepted by drc`, detail);
      }
    }

    // ---------------------------------------------------------- illegal half
    const bases = [...new Set(illegal.map((i) => i.base))];
    for (const key of bases) {
      console.log(`\nillegal corpus — variants of ${key}`);
      for (const item of illegal.filter((i) => i.base === key)) {
        if (ONLY && !item.name.includes(ONLY)) continue;
        const base = baselines.get(key);
        if (!base) { assert(false, `variant ${item.name}`, `no baseline ${key}`); continue; }
        item.clone = path.join(tmp, `v-${item.name}`);
        let mutated;
        try {
          mutated = applyMutation(base, item);
        } catch (e) {
          assert(false, `variant ${item.name} mutation applies`, e.message);
          continue;
        }
        // A mutation that changed nothing would silently "pass" its own item.
        const appliedCount = mutated.applied.map((a) => Number(a.split('=')[1]) || 0);
        const noOp = appliedCount.some((n) => n === 0);
        if (PROBE) {
          const gates = runGates(mutated.dir, base.design);
          console.log(`  --  ${item.name}${noOp ? ' [NO-OP!]' : ''}: ${observed(gates)}`);
          console.log(`      ${tmp} :: ${mutated.dir}`);
          continue;
        }
        assert(!noOp, `variant ${item.name}: mutation actually applied`, mutated.applied.join(' '));
        const gates = runGates(mutated.dir, base.design);
        const expect = item.expect || {};
        if (expect.leak || expect.crash) {
          const reporting = reportedErrorIds(gates);
          const crashed = GATE_NAMES.filter((g) => gates[g].crashed);
          blindSpots++;
          const stillBlind = expect.crash
            ? expect.crash.every((g) => crashed.includes(g)) && !reporting.length
            : !reporting.length;
          if (stillBlind) {
            gapLog.push(`LEAK   ${item.name} — ${item.title}\n         ${expect.crash
              ? `${expect.crash.join('/')} throw instead of reporting a finding`
              : 'no gate reports anything'}\n         suggested: ${item.suggest || '—'}`);
            note(`blind spot (recorded, not a failure): ${item.name} — ${item.title}`,
              expect.crash ? `${crashed.join(', ')} crashed` : 'nothing reported');
          } else {
            gapLog.push(`CLOSED ${item.name} — now reported as ${reporting.join(',') || 'a clean finding'} (crashed: ${crashed.join(',') || 'none'})`);
            note(`recorded gap looks closed: ${item.name} — ${item.title}`,
              `update the manifest — observed ${observed(gates)}`);
          }
          if (item.blindTo) {
            gapLog.push(`BLIND  ${item.name} — ${expectOfSummary(expect)} catches it, but ${item.blindTo.join('/')} does not`);
          }
          continue;
        }
        const { problems, seen } = matchExpected(gates, expect, base.gates);
        assert(problems.length === 0, `illegal ${item.name} — ${item.title}`,
          problems.length ? `missing: ${problems.join('; ')}\n      observed: ${observed(gates)}` : '');
        if (item.blindTo) {
          gapLog.push(`BLIND  ${item.name} — ${expectOfSummary(expect)} catches it, but ${item.blindTo.join('/')} does not`);
        }
        if (!problems.length) catchLog.push(`caught  ${item.name}: ${seen.join(', ')}`);
      }
    }
  } finally {
    if (PROBE) console.log(`\nprobe workspace kept at ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (PROBE) return;
  console.log('\ncoverage summary');
  for (const line of catchLog) console.log(`  ${line}`);
  console.log('\nrecorded gaps (printed, never failing)');
  for (const line of gapLog) console.log(`  ${line}`);
  console.log(`\n${checks - failures}/${checks} checks passed · ${catchLog.length} variant(s) caught · ${blindSpots} recorded gap item(s)`);
  if (failures) process.exit(1);
}

main();
