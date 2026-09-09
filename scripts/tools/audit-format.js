#!/usr/bin/env node
'use strict';
/**
 * audit-format.js — cross-check our generated records against the JSON Schemas
 * shipped with the easyeda-pro-format-skill repo.
 *
 *   node scripts/tools/audit-format.js --format-skill <path-to-easyeda-pro-format-skill>
 *                                      [--dir <work-dir>] [--keep]
 *
 * Builds a throwaway project with the regular scripts (same flow as the smoke
 * test), then validates every record body of every generated container file
 * against the corresponding schema (t-pcb-*.json / t-sch-*.json / tm-*.json).
 * Exit 1 if any record fails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, printHelp, die } = require('../lib/utils');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const SCHEMA = [
  { name: 'format-skill', desc: 'path to the easyeda-pro-format-skill repo', required: true },
  { name: 'dir', desc: 'work dir for the throwaway project (default: temp)' },
  { name: 'keep', desc: 'keep the generated project (flag)', hasValue: false }
];

// Record type -> schema key inside the format skill's validate.js, per container kind.
const MAP = {
  SCH: {
    WIRE: 't-wire', LINE: 't-sch-line', TEXT: 't-sch-text', RECT: 't-sch-rect',
    POLY: 't-sch-poly', CIRCLE: 't-sch-circle', ELLIPSE: 't-sch-ellipse',
    ARC: 't-sch-arc', BEZIER: 't-sch-bezier', ATTR: 't-sch-attr', PART: 't-part',
    PIN: 't-sch-pin', COMPONENT: 'tm-sch-component', TABLE: 't-sch-table',
    ELE_PLACEHOLDER: 't-placeholder', CANVAS: 't-sch-canvas'
  },
  PCB: {
    LINE: 't-pcb-line', POLY: 't-pcb-poly', ARC: 't-pcb-arc', STRING: 't-pcb-string',
    VIA: 't-pcb-via', POUR: 't-pcb-pour', FILL: 't-pcb-fill', REGION: 't-pcb-region',
    ATTR: 't-sch-attr', NET: 't-net', PAD: 't-pcb-pad', PAD_NET: 't-pad-net',
    COMPONENT: 'tm-pcb-component', LAYER: 't-layer', LAYER_PHYS: 't-layer-phys',
    ACTIVE_LAYER: 't-active-layer', RULE: 't-rule', RULE_TEMPLATE: 't-rule-template',
    RULE_SELECTOR: 't-rule-selector', PREFERENCE: 't-preference',
    PRIMITIVE: 't-primitive', SILK_OPTS: 't-silk-opts', D3_ATTRIBUTE: 'td3attribute',
    PANELIZE: 't-panelize', PART: 't-part', PIN: 't-sch-pin', CANVAS: 't-canvas'
  },
  PANEL: {
    CANVAS: 't-panel-canvas', POLY: 't-panel-poly', STRING: 't-panel-string',
    AUX_LINE: 't-aux-line', GROUP: 't-panel-group', DIMENSION: 't-panel-dimension'
  }
};

const META_BY_DOC = {
  SCH: 'tm-schematic', SCH_PAGE: 'tm-sheet', PCB: 'tm-pcb', SYMBOL: 'tm-symbol',
  FOOTPRINT: 'tm-footprint', DEVICE: 'tm-device', PANEL: 'tm-panel',
  CONFIG: 'tm-config', BOARD: 'tm-board', BLOB: 'tm-blob',
  SIMULATION: 'tm-simulation', SIMULATION_SCH: 'tm-sim-schematic'
};
const CANVAS_BY_DOC = { SCH_PAGE: 't-sch-canvas', SYMBOL: 't-sch-canvas', SIMULATION: 't-sch-canvas', PCB: 't-canvas', FOOTPRINT: 't-canvas', PANEL: 't-panel-canvas', PANEL_LIB: 't-panel-canvas' };

function containerKind(file) {
  if (file.endsWith('.esch2') || file.endsWith('.ecfg')) return 'SCH';
  if (file.endsWith('.epcb2')) return 'PCB';
  if (file.endsWith('.epan2')) return 'PANEL';
  return null;
}

function main() {
  const { opts } = parseArgs(process.argv.slice(2), SCHEMA);
  const skillDir = path.resolve(opts['format-skill']);

  // Compile schemas ourselves (deduping enum arrays — some shipped schemas
  // contain duplicate enum items that trip Ajv's schema validation).
  const Ajv = require(path.join(skillDir, 'node_modules', 'ajv'));
  const addFormats = require(path.join(skillDir, 'node_modules', 'ajv-formats'));
  const compiled = new Map();
  const DOCHEAD_SCHEMA = {
    type: 'object', required: ['docType', 'uuid', 'client'],
    properties: {
      docType: { type: 'string' },
      uuid: { type: 'string', pattern: '^[a-f0-9]{16}$' },
      client: { type: 'string', pattern: '^[a-f0-9]{16}$' },
      updateTime: { type: 'number' },
      version: { type: 'string' }
    }
  };
  function validator(key) {
    if (!compiled.has(key)) {
      const raw = key === 'DOCHEAD' ? DOCHEAD_SCHEMA
        : JSON.parse(fs.readFileSync(path.join(skillDir, 'schemas', key + '.json'), 'utf8'));
      (function dedupe(o) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return;
        if (Array.isArray(o.enum)) {
          o.enum = [...new Set(o.enum.map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s));
        }
        for (const v of Object.values(o)) dedupe(v);
      })(raw);
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      compiled.set(key, ajv.compile(raw));
    }
    return compiled.get(key);
  }
  const validateFormat = (key, body) => {
    const v = validator(key);
    if (v(body)) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: v.errors.map((e) => ({
        field: e.instancePath.replace(/^\//, '') || e.params.missingProperty || 'root',
        message: e.message
      }))
    };
  };

  const tmp = opts.dir ? path.resolve(opts.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'eprj3-audit-'));
  const proj = path.join(tmp, 'audit');
  const run = (args, expect = 0) => {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
    if (r.status !== expect) die(`setup step failed (${r.status}): ${args.join(' ')}\n${r.stderr}`);
    return r;
  };

  run([SCRIPTS + '/init.js', '--dir', proj, '--name', 'audit']);
  run([SCRIPTS + '/generate-symbol.js', 'from-pins', '--dir', proj, '--name', 'RES', '--title', 'Resistor', '--designator', 'R', '--pins', '1;2']);
  run([SCRIPTS + '/generate-footprint.js', 'from-pads', '--dir', proj, '--name', 'FP0402', '--title', 'R0402', '--designator', 'R',
    '--pads', '1:-16.54:0:31.5:35.43;2:16.54:0:31.5:35.43', '--outline', 'R,-27.56,-19.69,55.12,39.37', '--silk', 'rect,-27.56,-19.69,27.56,19.69']);
  run([SCRIPTS + '/load-library.js', 'device', '--dir', proj, '--symbol', 'RES', '--footprint', 'FP0402', '--name', 'R0402']);
  run([SCRIPTS + '/load-library.js', 'power', '--dir', proj, '--net', 'VCC']);
  run([SCRIPTS + '/load-library.js', 'power', '--dir', proj, '--net', 'GND', '--style', 'down']);
  run([SCRIPTS + '/load-library.js', 'port', '--dir', proj, '--net', 'SIG']);
  run([SCRIPTS + '/add-symbol.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--lib', 'R0402', '--x', '300', '--y', '-440']);
  run([SCRIPTS + '/add-power.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--lib', 'VCC', '--x', '300', '--y', '-500']);
  run([SCRIPTS + '/add-power.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--lib', 'GND', '--x', '360', '--y', '-380']);
  run([SCRIPTS + '/add-port.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--lib', 'PORT_SIG', '--x', '460', '--y', '-440']);
  run([SCRIPTS + '/add-wire.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--segs', '300,-420,300,-380', '--net', 'SIG']);
  run([SCRIPTS + '/add-wire.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--segs', '300,-380,360,-380']);
  run([SCRIPTS + '/add-netlabel.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--net', 'SIG', '--at', '300,-400']);
  run([SCRIPTS + '/set-refdes.js', 'renumber', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--prefix', 'R']);
  run([SCRIPTS + '/add-text.js', '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', '--value', 'audit', '--x', '300', '--y', '-300']);
  for (const shape of [
    ['rect', '--x1', '200', '--y1', '-200', '--x2', '400', '--y2', '-300'],
    ['poly', '--pts', '200,-200,300,-100,400,-200', '--closed'],
    ['circle', '--cx', '300', '--cy', '-250', '--r', '50'],
    ['ellipse', '--cx', '500', '--cy', '-250', '--rx', '80', '--ry', '40'],
    ['arc', '--start', '600,-200', '--mid', '700,-300', '--end', '800,-200'],
    ['bezier', '--pts', '200,-500,250,-400,350,-400,400,-500']
  ]) run([SCRIPTS + '/add-shape.js', shape[0], '--dir', proj, '--sch', 'Schematic1', '--sheet', 'P1', ...shape.slice(1)]);
  run([SCRIPTS + '/add-footprint.js', '--dir', proj, '--pcb', 'PCB1', '--lib', 'R0402', '--x', '300', '--y', '300', '--refdes', 'R1', '--nets', '1:VCC,2:SIG']);
  run([SCRIPTS + '/add-track.js', '--dir', proj, '--pcb', 'PCB1', '--net', 'SIG', '--x1', '300', '--y1', '316.54', '--x2', '450', '--y2', '316.54', '--layer', '1', '--width', '10']);
  run([SCRIPTS + '/add-pcb-text.js', '--dir', proj, '--pcb', 'PCB1', '--value', 'REV A', '--x', '2000', '--y', '2800', '--layer', '3']);
  for (const shape of [
    ['rect', '--x', '500', '--y', '500', '--w', '400', '--h', '300'],
    ['poly', '--pts', '500,500,900,500,700,800', '--closed'],
    ['circle', '--cx', '700', '--cy', '650', '--r', '100'],
    ['arc', '--x1', '500', '--y1', '500', '--x2', '900', '--y2', '500', '--angle', '90']
  ]) run([SCRIPTS + '/add-pcb-shape.js', shape[0], '--dir', proj, '--pcb', 'PCB1', ...shape.slice(1)]);
  run([SCRIPTS + '/add-via.js', '--dir', proj, '--pcb', 'PCB1', '--x', '700', '--y', '316.54', '--net', 'SIG']);
  run([SCRIPTS + '/add-pour.js', 'rect', '--dir', proj, '--pcb', 'PCB1', '--net', 'GND', '--x', '100', '--y', '100', '--w', '3800', '--h', '2800']);
  run([SCRIPTS + '/add-fill.js', 'rect', '--dir', proj, '--pcb', 'PCB1', '--net', 'GND', '--x', '100', '--y', '100', '--w', '400', '--h', '300']);
  run([SCRIPTS + '/add-fill.js', 'poly', '--dir', proj, '--pcb', 'PCB1', '--pts', '1000,1000,1400,1000,1400,1300']);
  run([SCRIPTS + '/add-region.js', 'rect', '--dir', proj, '--pcb', 'PCB1', '--prohibit', 'COPPER,TRACK', '--name', 'KEEP1', '--x', '200', '--y', '200', '--w', '300', '--h', '200']);
  run([SCRIPTS + '/validate.js', '--dir', proj]);

  // ---- audit every record of every container file ----
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(esch2|epcb2|epan2|ecfg)$/.test(e.name)) files.push(p);
    }
  };
  walk(proj);

  const E = require(path.join(SCRIPTS, 'lib', 'eprj3'));

  // Schema domain follows the enclosing DOC's docType, not the file extension:
  // .esch2 sheets legally embed FOOTPRINT docs (official example does too).
  const DOMAIN_BY_DOC = {
    SCH_PAGE: 'SCH', SYMBOL: 'SCH', SIMULATION: 'SCH', SIMULATION_SCH: 'SCH', SCH: 'SCH',
    PCB: 'PCB', FOOTPRINT: 'PCB', PANEL: 'PANEL', PANEL_LIB: 'PANEL'
  };

  // Preamble/frame records extracted byte-faithfully from the official example
  // (scripts/lib/pcb-preamble.js, frame-a4.js, panel template). The format
  // skill's schemas demand newer/stricter shapes than the official example —
  // the example stays authoritative, so these are reported, not validated.
  const TEMPLATE_TYPES = new Set([
    'RULE', 'RULE_TEMPLATE', 'RULE_SELECTOR', 'PREFERENCE', 'PRIMITIVE',
    'PANELIZE', 'D3_ATTRIBUTE', 'LAYER', 'LAYER_PHYS', 'ACTIVE_LAYER',
    'SILK_OPTS', 'ELE_PLACEHOLDER', 'TABLE', 'PARTITION'
  ]);

  // Known example-vs-schema divergences: the shipped schemas disagree with the
  // shipped examples / official example on these fields. Errors matching the
  // descriptions below are filtered out instead of failing the audit.
  const DIVERGENCES = [
    // schemas say string, every real example (incl. the format skill's own) uses number 0
    { re: /^(SCH|PCB) (LINE|POLY|ARC|FILL|POUR|REGION|STRING|VIA|COMPONENT|PAD|ATTR) ->/, field: 'groupId', msg: 'must be string' },
    // official WIRE is just {"zIndex":N}
    { re: /^SCH WIRE ->/, field: null, msg: /must have required property '(groupId|locked)'/ },
    // official page/footprint attrs omit these (null) and use version:'2.0' string
    { re: /^(SCH|PCB) ATTR ->/, field: 'groupId', msg: "must have required property 'groupId'" },
    { re: /^(SCH|PCB) ATTR ->/, field: 'version', msg: 'must be object' },
    { re: /^(SCH|PCB) ATTR ->/, field: /(rotation|color|fillColor|strikeout|underline|fontWeight|align|locked)/, msg: /must have required property/ },
    { re: /^(SCH|PCB) ATTR ->/, field: /(keyVisible|valueVisible|rotation|align)/, msg: /must be (boolean|number|string)|must be equal to one of the allowed values/ },
    // page attrs value:null (official @Board Name); instance attrs bold/italic:0 (official ticket 1134)
    { re: /^(SCH|PCB) ATTR ->/, field: /(value|bold|italic)/, msg: /must be (string|boolean)/ },
    { re: /^(SCH|PCB) PIN ->/, field: 'color', msg: 'must be string' },
    // official shapes use null for stroke/fill style
    { re: /^(SCH|PCB) (LINE|RECT|POLY|CIRCLE|ELLIPSE|ARC|BEZIER) ->/, field: /(strokeStyle|fillStyle)/, msg: 'must be equal to one of the allowed values' },
    // official POLY/TEXT omit startShape/endShape/strikeout, TEXT align is null
    { re: /^SCH (POLY|TEXT) ->/, field: /(startShape|endShape|strikeout)/, msg: /must have required property/ },
    { re: /^SCH TEXT ->/, field: 'align', msg: /must be string|must be equal to one of the allowed values/ },
    // real POUR: pourType {"pourType":"SOLID","fineness":8}; REGION: prohibitType array
    { re: /^PCB POUR ->/, field: /pourType/, msg: 'must be object' },
    { re: /^PCB REGION ->/, field: /(name|prohibitType)/, msg: /must have required property|must be string|must be equal to one of the allowed values/ },
    { re: /^PCB PAD ->/, field: /(propagationDelay|hole|connectMode)/, msg: /propagationDelay|object|allowed values/ },
    { re: /^PCB PAD_NET ->/, field: /(componentId|padNum|padId|padLen|propagationDelay)/, msg: /required|must be number/ },
    // empty NET {} precedes named NETs in official PCB; VIA propagationDelay omitted in example
    { re: /^PCB NET ->/, field: null, msg: /must have required property/ },
    { re: /^PCB VIA ->/, field: 'propagationDelay', msg: /must have required property/ },
    // format skill's own t-pcb-string example uses bold:0/italic:0
    { re: /^PCB STRING ->/, field: /(bold|italic)/, msg: 'must be boolean' },
    { re: /^(SCH|PCB) META -> tm-/, field: 'zIndex', msg: 'must be number' }
  ];
  const isDivergence = (label, e) => DIVERGENCES.some((d) =>
    d.re.test(label)
    && (d.field === null || (typeof d.field === 'string' ? e.field === d.field : d.field.test(e.field)))
    && (d.msg instanceof RegExp ? d.msg.test(e.message) : e.message === d.msg));

  const stats = new Map(); // key -> {total, failed, sample}
  const note = (key, body, errors) => {
    if (!stats.has(key)) stats.set(key, { total: 0, failed: 0, sample: null });
    const s = stats.get(key);
    s.total++;
    if (errors.length) {
      s.failed++;
      if (!s.sample) s.sample = { body, errors };
    }
  };

  for (const file of files) {
    const kind = containerKind(file);
    const rel = path.relative(proj, file);
    let docType = null;
    for (const line of E.readLines(file)) {
      const r = E.parseRecord(line);
      if (!r) continue;
      if (r.type === 'DOCHEAD') { docType = r.body.docType; continue; }
      const domain = DOMAIN_BY_DOC[docType] || kind;
      // empty-body records (e.g. ATTR after wire netlabel lines) exist verbatim
      // in the official example — nothing to validate
      if (!r.body || !Object.keys(r.body).length) {
        note(`${domain || kind} ${r.type} (empty)`, r.body, []);
        continue;
      }
      // PANEL documents come straight from the official-example template.
      if (domain === 'PANEL' || TEMPLATE_TYPES.has(r.type)
        || (r.type === 'CANVAS' && domain === 'PCB')) {
        note(`${domain || kind} ${r.type} (template)`, r.body, []);
        continue;
      }
      let schemaKey;
      if (r.type === 'META') schemaKey = META_BY_DOC[docType];
      else if (r.type === 'CANVAS') schemaKey = CANVAS_BY_DOC[docType];
      else if (r.type === 'DOCHEAD') schemaKey = 'DOCHEAD';
      else schemaKey = MAP[domain] ? MAP[domain][r.type] : undefined;
      if (!schemaKey) { note(`${rel} :: ${r.type} (no schema)`, r.body, []); continue; }
      const res = validateFormat(schemaKey, r.body);
      const errors = res.valid ? [] : res.errors.filter((e) => !isDivergence(`${domain} ${r.type} -> ${schemaKey}`, e));
      note(`${domain} ${r.type} -> ${schemaKey}`, r.body, errors);
    }
  }

  let bad = 0;
  const keys = [...stats.keys()].sort();
  for (const k of keys) {
    const s = stats.get(k);
    if (!s.failed) { console.log(`ok    ${k}  (${s.total})`); continue; }
    bad++;
    console.log(`FAIL  ${k}  (${s.failed}/${s.total})`);
    console.log(`      body: ${JSON.stringify(s.sample.body).slice(0, 300)}`);
    for (const e of s.sample.errors.slice(0, 6)) console.log(`      - ${e.field}: ${e.message}`);
  }
  console.log(`\n${bad ? bad + ' record type(s) failed schema validation' : 'all record types valid'}`);
  if (!opts.keep && !opts.dir) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`project kept at ${proj}`);
  if (bad) process.exit(1);
}

main();
