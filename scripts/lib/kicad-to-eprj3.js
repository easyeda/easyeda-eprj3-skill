'use strict';

// Convert KiCad library symbols / footprints into eprj3 records.

const { uuid, randId } = require('./eprj3');

const MM_TO_MIL = 39.3700787; // eprj3 stores positions in mil (1 mm = 39.37 mil)

function kicadToEprj3(val) {
  // KiCad positions are in mm; eprj3 uses mil.
  return val * MM_TO_MIL;
}

function buildSymbolRecords(kicadSym) {
  const partId = 'pid' + randId();
  const records = [];
  let ticket = 1;
  records.push({
    head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' },
    body: { originX: 0, originY: 0 }
  });
  records.push({
    head: { type: 'PART', ticket: ++ticket, id: partId },
    body: { BBOX: [-50, -25, 50, 25], title: kicadSym.name }
  });

  for (const sh of kicadSym.shapes) {
    ticket++;
    if (sh.type === 'RECT') {
      records.push({
        head: { type: 'RECT', ticket, id: 'e' + randId() },
        body: {
          partId, groupId: '', locked: false, zIndex: ticket,
          dotX1: kicadToEprj3(sh.x1), dotY1: kicadToEprj3(sh.y1),
          dotX2: kicadToEprj3(sh.x2), dotY2: kicadToEprj3(sh.y2),
          radiusX: 0, radiusY: 0, rotation: 0,
          strokeColor: '#000000', strokeStyle: 'SOLID', fillColor: null,
          strokeWidth: 1, fillStyle: 'NONE'
        }
      });
    } else if (sh.type === 'POLY' && sh.pts) {
      records.push({
        head: { type: 'POLY', ticket, id: 'e' + randId() },
        body: {
          partId, groupId: '', locked: false, zIndex: ticket,
          points: sh.pts.map(p => ({ x: kicadToEprj3(p.x), y: kicadToEprj3(p.y) })),
          closed: false,
          strokeColor: '#000000', strokeStyle: 'SOLID', fillColor: null,
          strokeWidth: 1, fillStyle: 'NONE'
        }
      });
    }
  }

  let pinZ = ticket + 1;
  for (const pin of kicadSym.pins) {
    const pinId = 'e' + randId();
    records.push({
      head: { type: 'PIN', ticket: ++pinZ, id: pinId },
      body: {
        partId, groupId: '', locked: false, zIndex: pinZ,
        display: true,
        x: kicadToEprj3(pin.x), y: kicadToEprj3(pin.y),
        length: kicadToEprj3(pin.length || 5),
        rotation: pin.rotation || 0,
        color: null, pinShape: 'NONE'
      }
    });
    records.push({
      head: { type: 'ATTR', ticket: ++pinZ, id: 'e' + randId() },
      body: {
        partId, parentId: pinId,
        key: 'Pin Name', value: pin.name || pin.number,
        keyVisible: false, valueVisible: false,
        align: 'LEFT_BOTTOM', fontSize: 9.72,
        zIndex: pinZ, locked: false
      }
    });
    records.push({
      head: { type: 'ATTR', ticket: ++pinZ, id: 'e' + randId() },
      body: {
        partId, parentId: pinId,
        key: 'Pin Number', value: pin.number || '',
        keyVisible: false, valueVisible: false,
        align: 'RIGHT_BOTTOM', fontSize: 9.72,
        zIndex: pinZ, locked: false
      }
    });
  }

  return { records, partId };
}

function buildFootprintRecords(kicadFp) {
  const partId = 'pid' + randId();
  const records = [];
  let ticket = 1;
  records.push({
    head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' },
    body: { originX: 0, originY: 0 }
  });
  records.push({
    head: { type: 'PART', ticket: ++ticket, id: partId },
    body: { BBOX: [-100, -100, 100, 100], title: kicadFp.name }
  });

  for (const sh of kicadFp.shapes) {
    ticket++;
    if (sh.kind === 'fp_rect') {
      records.push({
        head: { type: 'RECT', ticket, id: 'e' + randId() },
        body: {
          partId, groupId: '', locked: false, zIndex: ticket,
          dotX1: kicadToEprj3(sh.x1), dotY1: kicadToEprj3(sh.y1),
          dotX2: kicadToEprj3(sh.x2), dotY2: kicadToEprj3(sh.y2),
          radiusX: 0, radiusY: 0, rotation: 0,
          strokeColor: '#FFFFFF', strokeStyle: 'SOLID', fillColor: null,
          strokeWidth: 1, fillStyle: 'NONE'
        }
      });
    }
  }

  let padZ = ticket + 1;
  for (const pad of kicadFp.pads) {
    padZ++;
    const [x, y] = pad.at || [0, 0];
    const [w, h] = pad.size || [1, 1];
    const shape = pad.shape === 'circle' ? 'CIRCLE' : 'RECT';
    records.push({
      head: { type: 'PAD', ticket: padZ, id: 'e' + randId() },
      body: {
        groupId: 0, netName: '', layerId: 1, num: pad.number,
        centerX: kicadToEprj3(parseFloat(x)), centerY: kicadToEprj3(parseFloat(y)),
        padAngle: 0, hole: null,
        defaultPad: { padType: shape, width: kicadToEprj3(parseFloat(w)), height: kicadToEprj3(parseFloat(h)), radius: 0 },
        specialPad: [],
        padOffsetX: 0, padOffsetY: 0,
        relativeAngle: 90, plated: pad.type !== 'np_thru_hole',
        padType: 'NORMAL',
        topSolderExpansion: 2, bottomSolderExpansion: 2,
        topPasteExpansion: 0, bottomPasteExpansion: 0,
        locked: false, zIndex: padZ
      }
    });
  }

  return { records, partId };
}

module.exports = { buildSymbolRecords, buildFootprintRecords, kicadToEprj3 };