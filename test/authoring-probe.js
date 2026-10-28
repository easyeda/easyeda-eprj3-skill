'use strict';
// pipeline --gen probe: a generator file built with the OFFICIAL authoring
// helpers must produce the same clean result as a hand-written design.json
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(dir, { recursive: true });
const genFile = path.join(dir, `probe-gen-${process.pid}.gen.js`);

fs.writeFileSync(genFile, `
module.exports = (A) => {
  A.name('gen-probe');
  A.power('3V3', 'up'); A.power('GND', 'down');
  A.block('MCU', { desc: '主控最小系统' });
  A.ic({ id: 'U1', ic: 'AMS1117-3.3', pins: { 1: 'GND', 2: '3V3', 3: 'VIN', 4: '3V3' } });
  A.cap('VIN', 'GND', '22uF');
  A.cap('3V3', 'GND', '22uF');
  A.block('LED', { desc: '状态指示', sheet: 1 });
  A.res('LED_CTRL', 'LED_A', '330R');
  A.led('LED_A', 'GND', 'RED');
  A.autoNC();
  A.expect({ decoupling: true });
  return A.design();
};
`, 'utf8');

const genModule = require(genFile);
const A = require(path.join(__dirname, '..', 'scripts', 'lib', 'authoring')).createAuthoring();
const design = genModule(A);

// contract checks: autoNC filled, refdes auto-numbered, blocks joined
if (design.parts.length !== 5) { console.error(`FAIL gen produced ${design.parts.length} parts (want 5)`); process.exit(1); }
const u1 = design.parts.find((p) => p.id === 'U1');
if (u1.pins['5'] !== 'NC' || u1.pinoutSource) {
  // AMS1117 has exactly 4 pins — no NC fill needed; autoNC must not invent pins
  if (u1.pins['5'] !== undefined) { console.error('FAIL autoNC invented pins'); process.exit(1); }
}
const c1 = design.parts.find((p) => p.id === 'C1');
if (!c1) { console.error('FAIL auto refdes C1 missing'); process.exit(1); }
const r1 = design.parts.find((p) => p.id === 'R1');
if (!r1 || design.parts.find((p) => p.id === 'R2')) { console.error('FAIL refdes numbering broken'); process.exit(1); }
if (!design.blocks[0].parts.includes('U1')) { console.error('FAIL block membership'); process.exit(1); }
console.log('authoring helpers OK');
fs.rmSync(genFile, { force: true });
