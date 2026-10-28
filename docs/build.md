# Declarative build (`design.json`)

`scripts/build.js` turns one design file into a complete, checked `.eprj3`
project. This document is the reference for everything the file can express;
[`SKILL.md`](../SKILL.md) has the short version.

```bash
node scripts/build.js --design design.json --dir <absolute project dir> [options]
```

Options: `--force` (rebuild; removes index, `sch/`, `pcb/`, `panel/`, `.tmp/`),
`--dry-run` (rehearse into a throwaway dir, then delete it),
`--plan` (print the confirmed plan — power chain, nets, widths, rules, intent —
then run the same rehearsal; the target dir is never touched. This is the
human confirmation gate; its board line reads
"只布局（本 skill 不做布线/铺铜，铜皮在客户端完成）"), `--schematic-only`,
`--report <file>`, `--quiet`, `--keep-tmp`,
`--allow-erc`, `--allow-lint`, `--allow-drc`, `--allow-intent`, `--no-tidy`
(keep declared rotations — default runs the sch-tidy two-pass orientation
optimizer: layout → rotate symbols onto their signal axes → re-layout).

`--route`, `--pour`, `--no-route` and `--no-pour` were **removed in 1.13** —
the skill never routes and never pours, so passing any of them is an
`Unknown option` error. See "Copper policy" below.

Exit 0 means **every gate passed**. Non-zero means the described error count;
the printed codes point at the rule that failed.

## Top-level fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | design file stem | project + index name; need not match the directory |
| `board` | `{width,height}` | `1600×1000` | mil; an explicitly declared board is a **floor** (grown to fit) — omit it and the outline auto-fits the parts |
| `sheet` | `{schematic,name}` | `Schematic1` / `P1` | `name` is the sheet title (file name) |
| `powers` | object | `{}` | net → `"up"`/`"down"`; those nets become power flags |
| `nets` | object | `{}` | `{ "VCC": { "power": "up" } }` is the long form of `powers`; `{ "MOTOR_A": { "width": 30 } }` **annotates** the intended track width (nothing is routed — the DRC uses it as a per-net floor when it reviews imported copper) |
| `netClasses` | object | `{}` | `{ "POWER": { "width": 30 } }` — groups referenced from `nets` via `{ "class": "POWER" }` (annotation only) |
| `blocks` | array | one implicit block | `[{ title, parts:[id,…], desc, sheet }]` in signal-flow order; keep 2–8 related parts per block; `desc` = one-line functional description rendered under the title; `sheet` = 1-based page override |
| `sheets` | number | `1` | schematic pagination — blocks fill N sheets in declaration order (see Multi-sheet designs) |
| `parts` | array | **required** | see below |
| `expect` | object | — | fifth-gate declarations (`decoupling`, `pairs`, `valueRange`, `divider`) — see the end of this file |
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
| `ic` | no | name of an evidence-sourced IC entry (`templates/library/ic/`) — replaces `symbol`+`footprint`; see below |
| `footprint` | yes unless `pcb:false` | preset name, `{ auto: "LQFP48" }`, or `{ name, designator, pads, outline }` |
| `pins` | yes | `{ "1": "NET", … }` or `["1:NET","2:NET"]`; `"NC"` marks an intentional no-connect |
| `polarity` | no | `{ "1": "+", "2": "-" }` — the intent gate flags a "+" pin on a ground net (a reversed LED / electrolytic) |
| `role` | no | `"shunt"` for TVS / flyback / clamp diodes: their anode legitimately sits on ground, so the polarity gate skips the "+ on ground" reversal check |
| `value` | no | stored as the device value; engineering notation (`10k`, `100nF`) is parseable by the intent gate |
| `name` | no | device title override |
| `rotation` | no | `0/90/180/270` for the schematic symbol |

Pin keys are **pin numbers**, not pin names. Any symbol pin missing from `pins`
is an ERC `E001` unconnected pin and fails the build — unless its net is `NC`
(the no-connect convention). That is deliberate: a silently floating pin is the
most common way an AI-authored circuit is wrong.

### Inline symbols

```json
"symbol": { "name": "MCU", "designator": "U", "pins": ["1:VDD", "2:GND", "3:PA0"] }
```

Two-column auto layout: even pins down the left (`rotation 0`, x=-20), odd pins
down the right (`rotation 180`, x=+20), pin length 10. The pitch DEFAULTS to
30 mil for 3+ pins (any auto column then holds ≥2 pins — a 10 mil default would
stack stubs so tightly that wires collide) and to 10 mil for 1–2 pins;
override with `"pitch"`. **The pin record point (x=±20) is the connection
point** — wires attach there with exact equality, and the pin's drawn line
runs inward toward the body. The body rectangle derives from the pins. For a
specific look, `pins` also accepts
`"num:name:x:y:rotation"` — rotation must be 0 (left) or 180 (right); vertical
pin columns have no verified real-client sample.

Auto pin specs may also carry an **electrical direction** and a **column
hint**: `"num:name:dir"` or `"num:name:dir:side"` with dir ∈ `I` `O` `B` `P`
`W` `T` `C` (input / output / bidirectional / passive / power / tri-state /
open-collector) and side ∈ `L` `R`. Hinted pins take their column (unhinted
ones balance-fill); directions feed the ERC output-conflict check `E008` —
mark at least the outputs of driver parts so two outputs on one net fail the
build instead of the board.

### Auto footprints (`{ "auto": … }`)

```json
"footprint": { "auto": "LQFP48" }
"footprint": { "auto": "QFN", "pins": 24, "pitch": 20 }
```

Families (pad geometry generated from formulas with **external evidence** —
JEDEC / IPC-7351B / real LCSC parts; the per-family table with sources lives in
[`docs/footprint-evidence.md`](footprint-evidence.md) and `test/dfm.js` asserts
the key dimensions): `SOT23` `SOT23-5` `SOT23-6` `SOT223` · `SOP<n>` `SSOP<n>`
`TSSOP<n>` · `QFN<n>` `QFP<n>`/`LQFP<n>` · `DIP<n>` · `HDR<n>` `HDR2R<n>` ·
`SW_4P` `XTAL` `OSC` `USB_C`. Knobs: `pins` (required unless the family fixes
it), `pitch` (mil), `span` (pad row distance from the origin), `hole`
(through-hole drill), `rowSpan`/`rowGap` (DIP/headers). Compound names like
`"auto": "SOP8"` are family+pin-count shorthand. `USB_C` carries the official merged POWER pins only (A1B12/A4B9/A5/B5/B4A9/B1A12 — 6 pads, official TYPE-C-31-M-12 positions); DP/DM/SBU/shell need a hand-written inline footprint, since a design pin without a pad fails ERC (E006).

### IC pinout library (`"ic": …`)

Real ICs are referenced by name instead of hand-writing dozens of pin
definitions from memory — the single highest hallucination-risk step of
AI-authored schematics:

```json
{ "id": "U1", "ic": "STM32F103C8T6",
  "pins": { "1": "3V3", "23": "GND", "24": "3V3", "34": "SWDIO", "37": "SWCLK" } }
```

The entry (under [`templates/library/ic/`](../templates/library/ic)) ships the
evidence-sourced symbol pin list (`num:name:dir:side` — pin numbers, names,
electrical directions and column layout) and the footprint spec, each with a
citable `evidence` block (symbol source, footprint source, datasheet URL).
Map only the pins the design actually uses; everything else becomes `"NC"`.
An IC entry replaces `symbol` + `footprint` — give one or the other, never
both. Entries are curated, committed data — the skill reads them from disk and
**never queries the network at runtime**; there is no live library lookup. If
no entry fits a real part, do NOT fetch anything: hand-write the inline symbol
per [docs/build.md](build.md) rules, or (maintainers only, see
[`docs/development.md`](development.md)) curate a new entry.

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
one footprint, but pads of different parts still need ≥ clearance. Prefer an
auto footprint when one exists: fewer tokens, no invented coordinates.

## PCB

| Field | Default | Notes |
| --- | --- | --- |
| `place` | auto | `{ "R1": [x, y, angle] }` — explicit placement wins |
| `rules` | see below | DRC floors (see below) |
| `route` / `pour` | — | **removed (1.13)** — writing them has no effect; this skill never routes or pours |

`rules` keys that mean something now, all DRC floors: `clearance 10`,
`trackWidth 8` (also the minimum track width the copper gate accepts),
`edgeClearance 12`, plus the DFM floors `minDrill 12` (0.30 mm — JLC basic
process), `minRing 4` (annular ring, warn) and `minAngle 45` (acute track bend,
warn). They are used to judge **placement** (pad-to-pad and pad-to-edge
spacing) and, in an imported or client-saved project, the copper that is
already in the file. Router-era keys (`grid`, `bendCost`, `viaCost`,
`viaDiameter`, `viaDrill`, `layers`) no longer apply and are gone from the
contract. 0.5 mm-pitch boards: lower `clearance` / `trackWidth` to 6 so the
placement and any imported copper are judged against realistic floors.

Auto placement follows the schematic block order, so the board reads like the
schematic, with three deterministic refinements:

- **connectors** (`J…`) line up along the **bottom board edge**; a footprint
  whose pads form a single line (headers) is rotated so that line runs parallel
  to the edge, two-column footprints (USB-C) keep their plug axis across it;
- **decoupling caps** (`C…` with one pin on a ground net, same schematic block
  as a `U…` IC) are pulled next to their IC's power side;
- **gaps scale with the parts** (140–260 mil) instead of one fixed stride.

The board outline settles after placement: a declared `board` is a floor
(grown when the placer needs more), an **undeclared** board auto-fits the
parts (a 3-part board no longer ships on a 1600×1000 mil blank). Supply
`place` when a part needs an exact spot — it always wins.

## Copper policy (out of scope since 1.13)

This skill **never** auto-routes and **never** pours. The maze router
(`lib/pcb-route.js`), the pour generator (`lib/pour.js`) and the
`--route` / `--pour` build flags were removed, together with `add-track.js`,
`add-via.js`, `add-pour.js`, `add-fill.js` and `pour-auto.js`. The reason is a
division of labour: layout is something a machine does well, copper is not —
auto-routed traces sacrifice readability and electrical quality, while a human
in the EasyEDA client has full interactive control (real fan-out, differential
pairs, plane shapes, design rules you can see). So the skill's boundary is
schematic + netlist + placement + checks, and the delivered PCB is exactly that.

**Reading the handoff.** After placement the build prints:

```
pcb: 4 footprints · placement-only (this skill never routes or pours)
  rats: 3 net(s) to connect by hand in the client — GND(2p) V_LED(3p) LED_A(2p)
```

`rats: K` lists every net that still needs copper, with its pad count in
parentheses — a net with 2 pads wants one trace, a 3-pad net wants a small
tree. `--plan` shows the same policy on its board line
("只布局（本 skill 不做布线/铺铜，铜皮在客户端完成）"), and the report JSON's `pcb`
section is `{parts, mode: 'placed-only', rats}`.

**Finishing copper.** Open the project in the EasyEDA Pro client
(`node scripts/open.js open --dir <p>`) and route by hand — or use the client's
own autorouter and pour tools; that is exactly where copper belongs. Your edits
live in the `.epcb2` files this skill produced. Remember `build.js --force`
regenerates `pcb/` from the design file, so rebuild *before* the client-side
copper work, not after.

**Imported copper is still fully judged.** The DRC's copper rules (D001
clearance, D002 track width, D004 unrouted nets, D006 missing pour, D008 via
geometry, D012 acute angles) do run — just not against this skill's own
boards: a board it built is reported `mode: 'placed-only'`, and D004/D006 are
not judged there because that copper was never promised. A project imported
from, or re-saved by, the client contains LINE/VIA/POUR records, is detected
as routed, and gets the complete review — including every `pcb.rules` floor
and per-net `width` annotation the design declares.

`build.js` treats DRC errors as a build failure. If a finding on imported
copper is acceptable for the moment, pass `--allow-drc` and read the reported
`D001`/`D004` list — do not silence it by lowering the DRC thresholds.

## Multi-sheet designs

`sheets: N` splits the blocks across N sheets in declaration order
(~`ceil(blocks/N)` per page); `blocks[].sheet` (1-based) assigns a block
explicitly. Page 1 keeps the declared sheet name, pages 2+ are `P2`, `P3`….
The intake asks 单页/多页 and writes this field.

A net whose pins sit on more than one sheet becomes a **cross-sheet net**:
each sheet gets a stub + net port (`PORT_<NET>`), and the netlist/ERC merge
port names globally — both sides connect without wires. Manual multi-sheet
editing still goes through the primitives:

```bash
node scripts/add-symbol.js     --dir <p> --sch Schematic1 --sheet P2 --symbol PORT_IN --x …
node scripts/add-wire.js       --dir <p> --sch Schematic1 --sheet P2 --from U1.3 --to J1.1
```

Cross-sheet connectivity uses net ports (built automatically) or `PORT_IN` / `PORT_OUT` / `PORT_BI` entries; the netlist and ERC consider label/port names global.

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

## expect — the intent gate

```json
"parts": [
  { "id": "D2", "symbol": "LED", "footprint": "LED0603",
    "pins": { "1": "3V3", "2": "LED_A" }, "polarity": { "1": "+", "2": "-" } }
],
"expect": {
  "decoupling": true,
  "pairs": [["USB_DP", "USB_DM"]],
  "valueRange": [{ "ref": "R1", "min": "100R", "max": "1k" }],
  "divider": [{ "input": "VIN", "output": "FB", "top": "R1", "bottom": "R2", "ratio": 0.5, "tol": 0.05 }]
}
```

All fields optional; the gate only runs the rules you declare. `polarity` marks
are checked even without an `expect` block. Rule codes I001–I006 live in
[`docs/checks.md`](checks.md). `build.js` fails on intent errors just like on
ERC errors; `--allow-intent` skips the gate. Standalone: `node scripts/intent.js
--design design.json`.
