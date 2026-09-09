'use strict';

// Lightweight KiCad .kicad_sym and .kicad_pcb parser.
// We do not implement the full S-expression parser; only the subset needed for
// symbol/footprint extraction. For robust parsing the script can shell out to
// KiCad's kicad-cli when available.

const fs = require('fs');

function tokenize(text) {
  // S-expression tokenizer
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { tokens.push({ t: '(', v: '(' }); i++; continue; }
    if (c === ')') { tokens.push({ t: ')', v: ')' }); i++; continue; }
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { s += text[j + 1]; j += 2; continue; }
        s += text[j]; j++;
      }
      tokens.push({ t: 'str', v: s });
      i = j + 1; continue;
    }
    let j = i;
    while (j < text.length && !' \t\n\r()'.includes(text[j])) j++;
    const v = text.slice(i, j);
    tokens.push({ t: /^-?\d+(\.\d+)?$/.test(v) ? 'num' : 'sym', v });
    i = j;
  }
  return tokens;
}

function parse(text) {
  const tokens = tokenize(text);
  let pos = 0;
  function parseNode() {
    if (tokens[pos].t !== '(') throw new Error(`Expected ( at ${pos}`);
    pos++;
    const items = [];
    while (tokens[pos].t !== ')') {
      if (tokens[pos].t === '(') items.push(parseNode());
      else items.push(tokens[pos++]);
    }
    pos++;
    return items;
  }
  return parseNode();
}

function nodeSymbol(node) {
  const out = { name: '', properties: {}, pins: [], shapes: [] };
  if (!Array.isArray(node) || !node.length || node[0].v !== 'symbol') return out;
  out.name = node[1]?.v || '';
  for (let i = 2; i < node.length; i++) {
    const it = node[i];
    if (!Array.isArray(it) || !it.length || typeof it[0]?.v !== 'string') continue;
    const head = it[0].v;
    if (head === 'symbol') {
      // KiCad 6+ nests per-unit graphics in (symbol "NAME_0_1") / (symbol "NAME_1_1")
      const sub = nodeSymbol(it);
      out.pins.push(...sub.pins);
      out.shapes.push(...sub.shapes);
      if (!out.name && sub.name) out.name = sub.name;
    } else if (head === 'property') {
      out.properties[it[1]?.v] = it[2]?.v;
    } else if (head === 'pin') {
      const pin = { name: '', number: '', x: 0, y: 0, length: 0, rotation: 0 };
      for (let j = 1; j < it.length; j++) {
        const sub = it[j];
        if (!Array.isArray(sub) || !sub.length) continue;
        if (sub[0].v === 'name') pin.name = sub[1]?.v;
        else if (sub[0].v === 'number') pin.number = sub[1]?.v;
        else if (sub[0].v === 'at') {
          pin.x = parseFloat(sub[1]?.v || 0);
          pin.y = parseFloat(sub[2]?.v || 0);
          pin.rotation = parseFloat(sub[3]?.v || 0);
        } else if (sub[0].v === 'length') pin.length = parseFloat(sub[1]?.v || 0);
      }
      out.pins.push(pin);
    } else if (head === 'rectangle' || head === 'rect') {
      out.shapes.push({ type: 'RECT', ...extractXY(it) });
    } else if (head === 'circle') {
      out.shapes.push({ type: 'CIRCLE', ...extractXY(it) });
    } else if (head === 'polyline' || head === 'line') {
      out.shapes.push({ type: 'POLY', pts: extractPts(it) });
    } else if (head === 'arc') {
      out.shapes.push({ type: 'ARC', ...extractXY(it) });
    }
  }
  return out;
}

function extractXY(node) {
  const out = {};
  for (let i = 1; i < node.length; i++) {
    const sub = node[i];
    if (!Array.isArray(sub)) continue;
    const h = sub[0].v;
    if (h === 'start') out.x1 = parseFloat(sub[1].v), out.y1 = parseFloat(sub[2].v);
    if (h === 'end') out.x2 = parseFloat(sub[1].v), out.y2 = parseFloat(sub[2].v);
    if (h === 'center') out.cx = parseFloat(sub[1].v), out.cy = parseFloat(sub[2].v);
    if (h === 'radius') out.r = parseFloat(sub[1].v);
  }
  return out;
}

function extractPts(node) {
  const pts = [];
  for (let i = 1; i < node.length; i++) {
    const sub = node[i];
    if (Array.isArray(sub) && sub[0].v === 'pts') {
      for (let j = 1; j < sub.length; j++) {
        const xy = sub[j];
        if (Array.isArray(xy) && xy[0].v === 'xy') {
          pts.push({ x: parseFloat(xy[1].v), y: parseFloat(xy[2].v) });
        }
      }
    }
  }
  return pts;
}

function parseSymbolFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const root = parse(text);
  // root = (kicad_symbol_lib (version ...) (generator ...) (symbol "x" ...) (symbol "y" ...))
  const symbols = [];
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'symbol') {
      symbols.push(nodeSymbol(node));
    }
  }
  return symbols;
}

function parseFootprintFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const root = parse(text);
  // root = (kicad_pcb ... (footprint "x" ...))
  const fp = { name: '', pads: [], shapes: [], courtyard: null };
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'footprint') {
      fp.name = node[1].v;
      for (let i = 2; i < node.length; i++) {
        const it = node[i];
        if (!Array.isArray(it)) continue;
        const h = it[0].v;
        if (h === 'pad') {
          const pad = { number: it[1].v, shape: it[2].v, type: it[3]?.v, at: [], size: [], layers: [] };
          for (let j = 1; j < it.length; j++) {
            const sub = it[j];
            if (!Array.isArray(sub)) continue;
            const sh = sub[0].v;
            if (sh === 'at') pad.at = sub.slice(1).map(x => x.v);
            else if (sh === 'size') pad.size = sub.slice(1).map(x => x.v);
            else if (sh === 'layers') pad.layers = sub.slice(1).map(x => x.v);
            else if (sh === 'drill') pad.drill = sub[1].v;
          }
          fp.pads.push(pad);
        } else if (h === 'fp_line' || h === 'fp_rect' || h === 'fp_circle' || h === 'fp_arc') {
          fp.shapes.push({ kind: h, ...extractXY(it) });
        }
      }
      break;
    }
  }
  return fp;
}

module.exports = { parse, parseSymbolFile, parseFootprintFile, tokenize };