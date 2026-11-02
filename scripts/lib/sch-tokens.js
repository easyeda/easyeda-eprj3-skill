'use strict';
/**
 * sch-tokens.js — the schematic's design tokens.
 *
 * Every spacing the placer/router uses comes from here, the way a slide deck
 * takes every color from base.css: one source of truth, so the drawing has a
 * single rhythm and a tweak lands everywhere at once. Values are mil; sheet
 * geometry works in 10-mil units unless noted.
 */
module.exports = {
  GRID: 10,            // sheet snap grid
  PIN_PITCH: 100,      // inline IC pin pitch (mil)
  PIN_LEN: 200,        // inline IC pin stub (mil)

  // ---- module-internal spacing (sheet units unless noted)
  PIN_GAP: 80,         // wire between two chain members (room for a side port)
  COL_GAP: 120,        // between independent chains/banks in one block
  BANK_GAP: 120,       // between members of a parallel / pull bank row
  HUB_GAP: 120,        // anchor ↔ satellite spacing (hub pattern)
  HUB_STACK_GAP: 40,   // between two satellites stacked on one anchor side

  // ---- module frame
  FRAME_PAD: 110,      // padding around a module's parts (holds labels)
  TITLE_H: 60,         // caption strip on the top edge

  // ---- routing
  STUB: 40,            // default pin stub
  TRUNK_OFFSET: 60,    // sheet-edge trunk distance from the outermost part
  PORT_NAME_OFFSET: 45,// official Netport name offset (body ends at 40)
  COMB_GAP: 200,       // max pin spacing a bank rail may bridge

  // ---- sheet composition
  BLOCK_GAP_X: 160,    // between module frames on a shelf row
  BLOCK_GAP_Y: 140,    // between shelf rows

  // ---- PCB (mil)
  PCB_PART_GAP_MIN: 60,
  PCB_PART_GAP_MAX: 260,
  PCB_MODULE_GAP: 300
};
