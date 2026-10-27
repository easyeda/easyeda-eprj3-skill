---
name: easyeda-eprj3
description: Build EasyEDA Pro / 嘉立创EDA专业版 .eprj3 projects (schematic + PCB) from one design.json — auto schematic layout + wiring, auto PCB PLACEMENT (footprints + pad-net links + board outline; routing and copper pour are out of scope — done in the client), then ERC + layout lint + DRC gates. Use whenever the user wants to create or edit an eprj3 project, generate symbols/footprints, or validate/repair one.
---

# EasyEDA Pro eprj3 Skill

Author **EasyEDA Pro** (嘉立创EDA专业版) folder-format `.eprj3` projects. One design
file in, one validated project out: schematic laid out in signal-flow blocks,
every net wired, **PCB placed** — then four independent gates.

**Strategy: placement only — never copper.** The delivered PCB carries
footprints, pad↔net links and the board outline; this skill **never** auto-routes
and **never** pours. Layout is the machine's job, copper is the human's: machine
routing sacrifices readability and electrical quality, while the EasyEDA client
gives a person full interactive control — so the skill's boundary is schematic +
netlist + placement + checks. `build.js` prints a **rats handoff list** (the nets
to connect by hand in the client). The DRC never judges `D004` (unrouted nets) or
`D006` (missing pour) on a board this skill built; imported or client-saved
boards that carry tracks/pours are still reviewed against the full copper rules.

Format ground truth: [`docs/format-reference.md`](docs/format-reference.md). Deep
details are load-on-demand — see [Where to read next](#where-to-read-next) instead
of reading everything up front.

## Step 0 — intake: ask once, then never again

When the request is a *feature* ("做一个温湿度采集板") rather than a design file,
run the intake protocol before writing anything:

```bash
node scripts/intake.js check --req req.json    # exit 1 = required fields missing
node scripts/intake.js resolve --req req.json --out design.json
node scripts/build.js --design design.json --dir <proj> --plan    # confirm gate
node scripts/build.js --design design.json --dir <proj>           # after the user says ok
```

- `check` prints the exact questions (zh) for missing fields — send them **all at
  once**, never serially. Ask-tier fields carry their fallback default.
- `resolve` maps keywords to recipes (`usb`→usb-c-power, `3V3`→ldo-3v3,
  `单片机/mcu`→mcu-min+crystal…), chains the power tree
  (12V→buck→5V→ldo→3V3) and derives rail widths from the declared current.
  Selections are cached (`.cache/`) — a repeated requirement resolves in one
  lookup.
- **Confirmation gates before you build or fix:** power scheme, MCU/critical part
  choice, interface names, board size/layers, and `autofix.js --diff` output
  (a diff summary before any automatic edit). Full protocol + field table:
  [`docs/intake.md`](docs/intake.md).

If the user supplied a complete design already, skip to the fast path.

## Fast path (use this unless the user asks otherwise)

```bash
# 1. write a design file (see below), then:
node scripts/build.js --design design.json --dir <absolute project dir>
#    ... builds schematic + PCB PLACEMENT, runs validate + ERC + lint + DRC
#    the PCB is placement-only; the run prints the rats list of nets to
#    connect by hand in the EasyEDA client (this skill never routes or pours)
node scripts/render.js --dir <project dir>      # SVG preview → <project>/preview/
node scripts/open.js open --dir <project dir>   # launch the offline client
```

`build.js` exits non-zero if any gate has an error, so a clean exit *is* the
quality proof. It prints one summary line:

```
blink.eprj3 at /path — 4 components, 15 wire segments, lint 100/100, drc 100/100 (placed-only).
```

`--force` rebuilds an existing directory (deletes only skill-owned files:
index, `sch/`, `pcb/`, `panel/`, `.tmp/`). `--dry-run` rehearses into a throwaway
directory and deletes it. `--schematic-only` skips the PCB.
`--report <file>` writes the machine-readable report (validate/erc/lint/drc +
stats; its `pcb` section is `{parts, mode: 'placed-only', rats}`).

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
  "pcb": { "place": { "R1": [400, 400, 0] } }
}
```

| Field | Meaning |
| --- | --- |
| `name` | project/index name (does not have to match the directory) |
| `board.width/height` | board outline size in mil; **optional** — the board auto-grows to fit the parts |
| `powers` | net → `"up"` (supply) or `"down"` (ground): these get **power flags** instead of wires |
| `nets` | per-net **annotations**: `{ "width": 30 }` records the intended track width (derived from current) — it never lays copper; the DRC uses it as a per-net floor when reviewing imported tracks. `{ "class": "POWER" }` groups via `netClasses` |
| `netClasses` | `{ "POWER": { "width": 30 } }` — named width groups referenced from `nets` (annotation only) |
| `blocks` | titled boxes in signal-flow order; parts left out join the last block; keep **2–8 related parts** per block |
| `parts[].id` | reference designator **and** the part key used by `blocks` / `pcb.place` |
| `parts[].symbol` | preset name (`RES`, `CAP`, `IND`, `DIODE`, `LED`, `TEST_POINT`, `PORT_IN`…) **or** an inline spec |
| `parts[].footprint` | preset name (`R0603`, `C0603`, `SMA`, `TP0.5`…) **or** inline spec **or** `{ "auto": "LQFP48" }` |
| `parts[].pins` | pin **number** → net name. Unconnected pins map to `"NC"` (ERC accepts the NC convention). Every other unlisted pin is an ERC error |
| `parts[].polarity` | optional `{ "1": "+", "2": "-" }` — checked by the intent gate (I001 catches an LED/diode wired backwards) |
| `parts[].rotation` | 0 / 90 / 180 / 270 |
| `expect` | optional intent block for the fifth gate — see below |
| `pcb.place` | optional explicit placement `[x, y, angle]`; everything else is auto-placed |
| `pcb.rules` | DRC floors only: `clearance`, `trackWidth` (→ min track), `edgeClearance`, `minDrill`, `minRing`, `minAngle`. 0.5 mm-pitch parts want `clearance 6, trackWidth 6` |
| `pcb.pour` / `pcb.route` | **removed (1.13)** — this skill never pours or routes; writing these keys has no effect |

Inline parts (no library file needed) — use for any IC, connector or module:

```json
{ "id": "U1",
  "symbol":    { "name": "LDO", "designator": "U", "pitch": 30, "pins": ["1:GND", "2:VOUT", "3:VIN"] },
  "footprint": { "auto": "SOT23-5" },
  "pins": { "1": "GND", "2": "3V3", "3": "VIN" } }
```

`"auto"` footprints are generated from real land-pattern formulas — no
hand-written pad coordinates: `SOT23`/`SOT23-5`/`SOT23-6`/`SOT223`,
`SOP8`/`SOP16`…, `SSOP`, `TSSOP`, `QFN32`, `LQFP48`/`LQFP64`…, `QFP`, `DIP8`…,
`HDR6`, `HDR2R8`, `SW_4P`, `XTAL`, `OSC`, `USB_C`. Knobs: `pins`, `pitch`,
`span`, `hole` (`"auto": "LQFP", "pins": 48, "pitch": 19.7`). Use them instead
of hand-writing pads — fewer tokens, no invented coordinates.

Hand-written inline pads are still accepted (`[num, x, y, width, height,
drillDiameter?]` in mil; a drill makes the pad through-hole). Stick to real
land-pattern numbers (0603 pads ≈ 31×35 at ±16.5, SOT-23 pads ≈ 24×30 at 37
pitch, 0.1" header ≈ 60×60 at 100 pitch). Inline symbols need `"pitch": 30`
for ≥4-pin parts — the 10 mil default stacks stubs on top of each other.

### expect — declare the circuit's intent (fifth gate)

The other gates prove the files match design.json; `expect` catches mistakes
INSIDE design.json (an LED wired backwards, a missing decoupling cap, a
mis-wired divider):

```json
"parts": [
  { "id": "D2", "symbol": "LED", "footprint": "LED0603",
    "pins": { "1": "3V3", "2": "LED_A" }, "polarity": { "1": "+", "2": "-" } }
],
"expect": {
  "decoupling": true,
  "pairs": [["USB_DP", "USB_DM"]],
  "valueRange": [{ "ref": "R1", "min": "100R", "max": "1k" }],
  "divider": [{ "input": "VIN", "output": "FB", "top": "R1", "bottom": "R2", "ratio": 0.5 }]
}
```

Rule table: `node scripts/intent.js --rules`; codes I001–I006 in
[docs/checks.md](docs/checks.md). Mark `polarity` on every LED, diode and
electrolytic capacitor — it is the one check that catches reverse polarity.

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
| copper | `node scripts/drc.js --dir <p>` | spacing, edge clearance + DFM: min drill / annular ring / silk-on-pad / acute track angle (D009–D012). A board this skill built is always `placed-only` — `D004` (unrouted) and `D006` (no pour) are never judged on it; imported or client-saved boards that carry tracks/pours get the full copper rules |
| intent | `node scripts/intent.js --design design.json` | polarity reversed, decoupling/pair/divider/value-range violations — mistakes *inside* design.json |

`--json` on any of them gives machine-readable output (every finding carries a
`fix` field — do what it says). lint and DRC also print a 0–100 score. Rule
tables: `node scripts/lint-layout.js --rules`, `node scripts/drc.js --rules`,
`node scripts/intent.js --rules`, and [`docs/checks.md`](docs/checks.md).

**Repair loop:** read the failing code, apply its `fix:` line (usually: edit
the design, re-run `build.js --force`). Mechanical fixes — NC for unconnected
pins, decoupling caps — are automated, but **show the diff before writing**:
`node scripts/autofix.js --design design.json --diff` prints the exact
before/after lines and writes nothing; drop `--diff` only after the user has
seen it. Never hand-edit project files unless you have read
[`docs/format-reference.md`](docs/format-reference.md).

## Incremental editing (when a design file is overkill)

Copper primitives are out of the skill since 1.13 — `add-track.js`,
`add-via.js`, `add-pour.js`, `add-fill.js` and `pour-auto.js` were removed;
tracks, vias and pours are drawn in the EasyEDA client. Keep-out regions
(`add-region.js`) stay, because a keepout is not copper.

```bash
node scripts/pins.js --dir <p>                       # every pin + exact tip + net
node scripts/add-wire.js --dir <p> --sch S --sheet P \
     --from R1.2 --to C1.1 [--net SIG]               # wire BY PIN REFERENCE
node scripts/netlist.js --dir <p>                    # what is actually connected
node scripts/add-symbol.js  --dir <p> --sch S --sheet P --symbol RES --footprint R0603 --x 300 --y -440 --refdes R1
node scripts/add-footprint.js --dir <p> --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:SIG"
node scripts/add-text.js / add-shape.js / add-pcb-shape.js / add-pcb-text.js / add-region.js
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

- one block = 2–8 related parts (tight blocks keep signals wired instead of
  falling back to labels — that fallback is how nets have shorted before);
  decoupling caps stay with their IC;
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
| design.json edge cases, multi-sheet, PCB rules, copper policy | [`docs/build.md`](docs/build.md) |
| every check code and what it means | [`docs/checks.md`](docs/checks.md) |
| record-level format spec | [`docs/format-reference.md`](docs/format-reference.md) |
| a full worked manual flow (no design file) | [`docs/workflow.md`](docs/workflow.md) |
| extending the skill, iteration protocol | [`docs/development.md`](docs/development.md) |
| requirement form, 追问 protocol, confirmation gates | [`docs/intake.md`](docs/intake.md) |
| launching the client, non-default install paths | `node scripts/open.js --help` |
| regression / benchmark / compliance | `node test/pipeline.js`, `node test/dfm.js`, `node test/corpus.js`, `node scripts/eval.js [--diff] [--design <file>]`, `node scripts/depcheck.js` |

## Output style

- Show the design file you wrote, the `build.js` invocation, and the final summary line.
- Do not narrate the format spec or "what eprj3 is" unless asked.
- Reference files as Markdown links: `[build.js](scripts/build.js)`.
- Report scores and any remaining warning codes honestly; a 82/100 layout with two
  `L006` warnings is worth stating, not hiding.

## Known limitations

- **Format dialect: V4.** Generated files write the current client shapes
  (ticketed `{"type":"DOCHEAD","ticket":1}` frame, `.ecfg` = DOCHEAD+META);
  the readers accept V3 and V4 alike — calibrated against real client-saved
  projects (official quick-start from 4.1.78 + H610): `validate.js` 0 errors
  on both. Never detect record kinds by string prefix; `E.isDocHeadLine` and
  `E.parseRecord` are the only sanctioned readers.
- Fidelity is only provable in the real client. If it refuses to open, run
  `validate.js` first, then compare with [`examples/blink`](examples/blink).
  Set `EPRJ3_DETERMINISTIC=1` to build byte-identical projects for golden-file
  diffs.
- No routing, no copper pour — by design. The skill never writes tracks, vias
  or pours; copper is done by a human in the EasyEDA client. The handoff is the
  `rats:` line `build.js` prints (nets still to connect, with pad counts), and
  every `pcb.rules` number you declare is used as the DRC floor when the DRC
  reviews imported or client-saved copper. Differential pairs, length matching
  and impedance control are client tasks too. Hierarchical multi-sheet
  navigation and simulation documents are not authored — finish those in the
  client.
- `DIFF_PAIR`/`SHORT` special symbols and the A4/A3 frame symbols are not yet
  verified against the real client.
