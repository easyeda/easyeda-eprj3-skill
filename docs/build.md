# Declarative build (`design.json`)

`scripts/build.js` turns one design file into a complete, checked `.eprj3`
project. This document is the reference for everything the file can express;
[`SKILL.md`](../SKILL.md) has the short version.

```bash
node scripts/build.js --design design.json --dir <absolute project dir> [options]
```

Options: `--force` (rebuild; removes index, `sch/`, `pcb/`, `panel/`, `.tmp/`),
`--dry-run` (rehearse into a throwaway dir, then delete it), `--schematic-only`,
`--no-route`, `--no-pour`, `--report <file>`, `--quiet`, `--keep-tmp`,
`--allow-erc`, `--allow-lint`, `--allow-drc`.

Exit 0 means **every gate passed**. Non-zero means the described error count;
the printed codes point at the rule that failed.

## Top-level fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | design file stem | project + index name; need not match the directory |
| `board` | `{width,height}` | `1600×1000` | mil; the board outline is generated |
| `sheet` | `{schematic,name}` | `Schematic1` / `P1` | `name` is the sheet title (file name) |
| `powers` | object | `{}` | net → `"up"`/`"down"`; those nets become power flags |
| `nets` | object | `{}` | `{ "VCC": { "power": "up" } }` is the long form of `powers` |
| `blocks` | array | one implicit block | `[{ title, parts:[id,…] }]` in signal-flow order |
| `parts` | array | **required** | see below |
| `layout` | object | see table | grid/tuning knobs |
| `pcb` | object or `false` | `{}` | `false` skips the PCB entirely |

`layout` knobs: `cols` (max columns per block, default 3), `cellW` (260),
`cellH` (200), `blockGapX` (280), `blockGapY` (240), `margin` (120). Increase the
cells for large inline symbols so blocks keep their gutters.

## Parts

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | reference designator and part key; unique |
| `symbol` | yes | preset entry name, or `{ name, designator, pins:[…] }` |
| `footprint` | yes unless `pcb:false` | preset name, or `{ name, designator, pads, outline }` |
| `pins` | yes | `{ "1": "NET", … }` or `["1:NET","2:NET"]` |
| `value` | no | stored as the device value |
| `name` | no | device title override |
| `rotation` | no | `0/90/180/270` for the schematic symbol |

Pin keys are **pin numbers**, not pin names. Any symbol pin missing from `pins`
is an ERC `E001` unconnected pin and fails the build. That is deliberate: a
silently floating pin is the most common way an AI-authored circuit is wrong.

### Inline symbols

```json
"symbol": { "name": "MCU", "designator": "U", "pins": ["1:VDD", "2:GND", "3:PA0"] }
```

Two-column auto layout: even pins down the left (`rotation 0`, x=-20), odd pins
down the right (`rotation 180`, x=+20), 10 mil pitch by default, pin length 10.
Tips therefore land at x = ±30. The body rectangle derives from the pins.
For a specific look, `pins` also accepts `"num:name:x:y:rotation"` — rotation must
be 0 (left) or 180 (right); vertical pin columns have no verified real-client
sample.

### Inline footprints

```json
"footprint": { "name": "SOT23_5", "designator": "U",
  "pads": [[1,-27,-19,24,30], [2,0,-19,24,30], [3,27,-19,24,30], [4,27,19,24,30], [5,0,19,24,30]],
  "outline": [-45,-45,45,45] }
```

Pads: `[num, x, y, width, height, drillDiameter?]` in mil. A 6th value switches
the pad to through-hole (ROUND hole + ELLIPSE copper on the MULTI layer).
`outline` is the component body box `[x1,y1,x2,y2]`; omit it and the pads' bounding
box is used.

Use realistic land-pattern numbers — the DRC ignores pad-to-pad spacing *inside*
one footprint, but pads of different parts still need ≥ clearance.

## PCB

| Field | Default | Notes |
| --- | --- | --- |
| `place` | auto | `{ "R1": [x, y, angle] }` — explicit placement wins |
| `route` | on | `false` == `--no-route` |
| `pour` | `{net:"GND"}` on | `{ net, stitch }`; set `"pour": false` to skip |
| `rules` | see below | router + DRC numbers |

`rules` defaults: `grid 10`, `clearance 14`, `trackWidth 12`, `viaDiameter 24`,
`viaDrill 12`, `edgeClearance 20`, `layers 2`, `bendCost 6`, `viaCost 120`.

The router skips the poured net (the plane connects it) and reports anything it
cannot route; unrouted nets surface as `D004` from the DRC.

Auto placement follows the schematic block order, packs parts left→right at
~140 mil gaps with a 150 mil board margin. Supply `place` when a connector must
sit on a board edge or a part needs a fixed position.

## Router behaviour and limits

The PCB router is a 2-layer grid A* with a per-connection node budget and a
15 s wall-clock budget. It:

- connects nets in nearest-neighbour order, skipping the poured net;
- never crosses another net's pad copper or another net's track;
- is allowed to squeeze through a *pad's* clearance zone when there is no clean
  path (best effort), and keeps the track's own clearance as a hard wall;
- reports everything it could not connect, which the DRC surfaces as `D004`.

Known limits. `node scripts/eval.js` currently reports **17/17 cases clean**
(average lint 100, average DRC 100), but the router does not become omniscient —
these are the situations it cannot solve on its own:

- Very dense packages (0.5 mm pitch connectors, fine-pitch QFN) need design
  rules below the 10 mil defaults. Set `pcb.rules.clearance` /
  `pcb.rules.trackWidth` down to 6–8 for those boards, or route them by hand
  with `add-track.js`. Do not copy a `pcb.rules` override from one board to
  another "just in case" — a stale `{"grid": 2}` override is what dropped several
  of the shipped recipes from 100 to 40–88 before it was removed.
- A net whose two pads sit on opposite sides of a large symbol, with other nets
  already occupying both escape directions, can come back `D004`. Remedy: give
  `pcb.place` an explicit position for the two parts, or raise the board size.
- Block grouping matters more than board size: when a net has to fall back to
  stub+label, a label-encoded net can merge with a neighbouring power-flag group
  (this is how `RS485_DI` once shorted into `RS485_A`). Keep blocks to ~2–3
  related parts in declaration order and the fallback stops happening.
- No differential pairs, length matching, impedance control or multi-layer
  (>2) routing. Those are finished in the client.

`build.js` treats DRC errors as a build failure. When the router's best effort
is acceptable for the moment, pass `--allow-drc` and read the reported
`D001`/`D004` list — do not silence it by lowering the DRC thresholds.

## Multi-sheet designs

`build.js` creates one sheet. Multi-sheet work is incremental:

```bash
# after a build, add a second sheet through the primitives:
node scripts/add-symbol.js     --dir <p> --sch Schematic1 --sheet P2 --symbol PORT_IN --x …
node scripts/add-wire.js       --dir <p> --sch Schematic1 --sheet P2 --from U1.3 --to J1.1
```

Cross-sheet connectivity uses `PORT_IN` / `PORT_OUT` / `PORT_BI` entries or the
`OFFPAGE_*` symbols; the netlist and ERC consider label/port names global.

## Rebuilding and repair

`build.js --force` regenerates everything from the design file — the generated
records are not a source of truth, the design file is. Patch the design, rebuild,
re-read the gates. Hand-editing `.esch2`/`.epcb2` JSON is a last resort reserved
for things the declarative layer cannot express yet (e.g. a specific silkscreen
artwork), and requires [`format-reference.md`](format-reference.md).

## Recipes

`recipe/*.json` are complete, buildable designs covering common sub-circuits
(LDO, buck, MCU minimum system, USB-C power, I2C sensor, RS485, crystal, MOSFET
switch, power tree, RC filters, divider, LED, button debounce, UART). The
fastest safe way to author a new board: copy the closest recipe, change the
parts and nets, run `build.js`.

A recipe may also be **parameterised**, which turns it into a reusable block:

```json
{
  "params": { "r": "1k", "c": "100nF" },
  "parts": [
    { "id": "R1", "value": "${r}", "symbol": "RES", "footprint": "R0603",
      "pins": { "1": "SIG_IN", "2": "SIG_OUT" } }
  ]
}
```

```bash
node scripts/recipe.js list                       # table: parts, params, blocks
node scripts/recipe.js show rc-lowpass             # resolved summary + apply hint
node scripts/recipe.js apply rc-lowpass --to design.json \
     --set r=4k7,c=22nF \                          # override params (${r} → 4k7)
     --net SIG_IN=AF_IN \                          # rename nets inside the recipe
     --suffix _2 \                                 # suffix for colliding part ids
     --out merged.json                             # default: overwrite --to
```

`apply` merges `parts`, `blocks` and `powers` into the target design, renames
colliding ids (`R1` → `R1_2`) **and their block references**, appends into an
existing block with the same title, and leaves the target's own parts alone.
Placeholders are plain string substitution — no templating engine, no deps.

## Auto pour

`build.js` pours by default. To (re)pour an existing board:

```bash
node scripts/pour-auto.js --dir <p> [--pcb PCB1] [--net GND] \
     [--clearance 16] [--layers 1,2] [--spacing 100] [--no-stitch] \
     [--replace] [--dry-run] [--json]
```

It reads the `BOARD_OUTLINE` poly, insets by the edge clearance, writes one POUR
per copper layer, and adds a stitching-via fence plus a coarse interior grid.
`--replace` drops existing pours on those layers first, so the command is
idempotent; `--dry-run` shows the region and via count without writing.
