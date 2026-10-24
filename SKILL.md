---
name: easyeda-eprj3
description: Build EasyEDA Pro / 嘉立创EDA专业版 .eprj3 projects (schematic + PCB) from one design.json — auto layout, auto routing, auto copper pour, then ERC + layout lint + DRC gates. Use whenever the user wants to create or edit an eprj3 project, generate symbols/footprints, or validate/repair one.
---

# EasyEDA Pro eprj3 Skill

Author **EasyEDA Pro** (嘉立创EDA专业版) folder-format `.eprj3` projects. One design
file in, one validated project out: schematic laid out in signal-flow blocks,
every net wired, PCB placed + routed + poured, then four independent gates.

Format ground truth: [`docs/format-reference.md`](docs/format-reference.md). Deep
details are load-on-demand — see [Where to read next](#where-to-read-next) instead
of reading everything up front.

## Fast path (use this unless the user asks otherwise)

```bash
# 1. write a design file (see below), then:
node scripts/build.js --design design.json --dir <absolute project dir>
#    ... builds schematic + PCB, routes, pours, and runs validate + ERC + lint + DRC
node scripts/render.js --dir <project dir>      # SVG preview → <project>/preview/
node scripts/open.js open --dir <project dir>   # launch the offline client
```

`build.js` exits non-zero if any gate has an error, so a clean exit *is* the
quality proof. It prints one summary line:

```
blink.eprj3 at /path — 4 components, 15 wire segments, lint 100/100, drc 100/100.
```

`--force` rebuilds an existing directory (deletes only skill-owned files:
index, `sch/`, `pcb/`, `panel/`, `.tmp/`). `--dry-run` rehearses into a throwaway
directory and deletes it. `--schematic-only` skips the PCB.
`--report <file>` writes the machine-readable report (validate/erc/lint/drc + stats).

## design.json — the whole contract

All lengths are **mil** (1000 mil = 1 inch), Y up. Only `parts` is required.

```json
{
  "name": "blink",
  "board": { "width": 1600, "height": 1000 },
  "sheet": { "schematic": "Schematic1", "name": "P1" },
  "powers": { "VCC": "up", "GND": "down" },
  "blocks": [
    { "title": "POWER INPUT", "parts": ["D1", "C1"] },
    { "title": "LED DRIVER", "parts": ["R1", "D2"] }
  ],
  "parts": [
    { "id": "R1", "symbol": "RES", "footprint": "R0603", "value": "330R",
      "pins": { "1": "V_LED", "2": "LED_A" } }
  ],
  "pcb": { "place": { "R1": [400, 400, 0] }, "pour": { "net": "GND" } }
}
```

| Field | Meaning |
| --- | --- |
| `name` | project/index name (does not have to match the directory) |
| `board.width/height` | board outline size in mil; the outline is drawn for you |
| `powers` | net → `"up"` (supply) or `"down"` (ground): these get **power flags** instead of wires |
| `blocks` | titled boxes in signal-flow order; parts left out join the last block |
| `parts[].id` | reference designator **and** the part key used by `blocks` / `pcb.place` |
| `parts[].symbol` | preset name (`RES`, `CAP`, `IND`, `DIODE`, `LED`, `TEST_POINT`, `PORT_IN`…) **or** an inline spec |
| `parts[].footprint` | preset name (`R0603`, `C0603`, `SMA`, `TP0.5`…) **or** an inline spec |
| `parts[].pins` | pin **number** → net name. Every unlisted pin becomes an ERC error, so list them all |
| `parts[].rotation` | 0 / 90 / 180 / 270 |
| `pcb.place` | optional explicit placement `[x, y, angle]`; everything else is auto-placed |
| `pcb.pour` | `{ "net": "GND", "stitch": true }` — pour on both layers + via fence |
| `pcb.rules` | override router/DRC numbers (`clearance`, `trackWidth`, `viaDiameter`, `layers`, `edgeClearance`) |

Inline parts (no library file needed) — use for any IC, connector or module:

```json
{ "id": "U1",
  "symbol":    { "name": "LDO", "designator": "U", "pins": ["1:GND", "2:VOUT", "3:VIN"] },
  "footprint": { "name": "SOT23", "designator": "U",
                 "pads": [[1,-27,-19,24,30], [2,0,19,24,30], [3,27,-19,24,30]],
                 "outline": [-45,-30,45,30] },
  "pins": { "1": "GND", "2": "3V3", "3": "VIN" } }
```

Pads are `[num, x, y, width, height, drillDiameter?]` in mil; a drill makes the pad
through-hole. Stick to real land-pattern numbers (0603 pads ≈ 31×35 at ±16.5,
SOT-23 pads ≈ 24×30 at 37 pitch, 0.1" header ≈ 60×60 at 100 pitch).

Reusable complete examples live in [`recipe/`](recipe) and
[`examples/designs/`](examples/designs). Copy the closest one and edit it —
that is faster and safer than writing a design from a blank page.

```bash
node scripts/recipe.js list                       # 15 sub-circuits
node scripts/recipe.js show rc-lowpass             # parts, nets, params
node scripts/recipe.js apply ldo-3v3 --to design.json \
     --set cout=22uF --net VOUT=3V3_RAIL           # merge, rename, de-duplicate ids
```

Recipes declare `params` and may use `${name}` placeholders, so `--set` is a
real override rather than a find-and-replace in your head.

## Checks — run them, read the codes

| Gate | Command | Fails on |
| --- | --- | --- |
| format | `node scripts/validate.js --dir <p>` | structural/reference corruption |
| electric | `node scripts/erc.js --dir <p> [--design design.json]` | floating pins, dead-end nets, netlist≠design, PCB↔schematic mismatch |
| layout | `node scripts/lint-layout.js --dir <p>` | overlapping symbols, wires through bodies, parts outside their block, off-grid |
| copper | `node scripts/drc.js --dir <p>` | spacing, track width, edge clearance, unrouted nets, missing pour |

`--json` on any of them gives machine-readable output; lint and DRC also print a
0–100 score. Rule tables: `node scripts/lint-layout.js --rules`,
`node scripts/drc.js --rules`, and [`docs/checks.md`](docs/checks.md).

**Repair loop:** read the failing code, fix the *design* (not the generated JSON),
re-run `build.js --force`. Never hand-edit project files unless you have read
[`docs/format-reference.md`](docs/format-reference.md).

## Incremental editing (when a design file is overkill)

```bash
node scripts/pins.js --dir <p>                       # every pin + exact tip + net
node scripts/add-wire.js --dir <p> --sch S --sheet P \
     --from R1.2 --to C1.1 [--net SIG]               # wire BY PIN REFERENCE
node scripts/netlist.js --dir <p>                    # what is actually connected
node scripts/add-symbol.js  --dir <p> --sch S --sheet P --symbol RES --footprint R0603 --x 300 --y -440 --refdes R1
node scripts/add-footprint.js --dir <p> --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:SIG"
node scripts/add-track.js / add-via.js / add-pour.js / add-text.js / add-shape.js / add-pcb-shape.js / add-pcb-text.js / add-region.js / add-fill.js
node scripts/pour-auto.js --dir <p> [--net GND] [--layers 1,2] [--replace]  # pour from the board outline + via fence
node scripts/recipe.js list | show <name> | apply <name> --to <design.json>  # parameterised sub-circuits
node scripts/generate-symbol.js from-pins --dir <p> --name <sym> --pins "1:A;2:B"
node scripts/generate-footprint.js from-pads --dir <p> --name <fp> --pads "1:-16,0,31,35;2:16,0,31,35"
node scripts/set-refdes.js renumber --dir <p> --sch S --sheet P --prefix R
node scripts/cleanup.js --dir <p>                    # drop .tmp staging (build does this itself)
```

**Never hand-compute a pin coordinate.** `scripts/pins.js` lists exact tips;
`add-wire --from/--to` (or `--link "R1.2>C1.1;R1.1>U1.3"`) resolves them and
routes orthogonally. Hand arithmetic is how a schematic silently loses a net.

Coordinates are mil, Y up, 10 mil grid. Connectivity is exact coordinate equality
on the pin tip; that is why the helpers above exist.

## Layout rules the builder already enforces

Blocks are grid-packed in declaration order (signal flow left→right), symbols are
ordered by connectivity inside each block, every block gets a frame + title, nets
are encoded weakest-to-strongest: straight wire → L/Z → trunk bus → stub+label,
and power nets become flags. The layout lint verifies the result. If you hand-place
parts, keep these invariants:

- one block = 3–10 related parts; decoupling caps stay with their IC;
- wires orthogonal only, endpoints on pin tips;
- nearby pins get **visible wires**, not labels — a pin fanning into labels is the
  anti-pattern; labels are for far/cross-block links and need a ≥30 mil stub;
- net names UPPERCASE and meaningful (`SPI_CLK`), never `N$1`;
- rows ≥200 mil apart so designator/name labels don't collide.

## Library tiers

Presets ship with the skill (`templates/library/{symbol,footprint}/`) and resolve
first; generated/inline entries are staged under `<project>/.tmp/library/` during
authoring and removed by `build.js` or `cleanup.js`. `load-library.js list|show|remove`
inspects both tiers. Inline entries are staged as `SYM_*` / `FP_*` so a symbol and
footprint sharing a display name cannot collide.

## Where to read next

| Need | Read |
| --- | --- |
| design.json edge cases, multi-sheet, PCB rules | [`docs/build.md`](docs/build.md) |
| every check code and what it means | [`docs/checks.md`](docs/checks.md) |
| record-level format spec | [`docs/format-reference.md`](docs/format-reference.md) |
| a full worked manual flow (no design file) | [`docs/workflow.md`](docs/workflow.md) |
| launching the client, non-default install paths | `node scripts/open.js --help` |
| regression / benchmark | `node test/pipeline.js`, `node scripts/eval.js` |

## Output style

- Show the design file you wrote, the `build.js` invocation, and the final summary line.
- Do not narrate the format spec or "what eprj3 is" unless asked.
- Reference files as Markdown links: `[build.js](scripts/build.js)`.
- Report scores and any remaining warning codes honestly; a 82/100 layout with two
  `L006` warnings is worth stating, not hiding.

## Known limitations

- Fidelity is only provable in the real client. If it refuses to open, run
  `validate.js` first, then compare with [`examples/blink`](examples/blink).
- `add-pour` writes the pour *region*; the client recomputes filled copper on open.
  Pour style is SOLID (the only real-client-backed mode).
- The router is a 2-layer maze router: no differential pairs, length matching or
  impedance control. Hierarchical multi-sheet navigation and simulation documents
  are not authored — finish those in the client.
- `DIFF_PAIR`/`SHORT` special symbols and the A4/A3 frame symbols are not yet
  verified against the real client.
