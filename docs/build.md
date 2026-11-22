# Build a project from an authored design

`build.js` accepts `--design <file>` or `--gen <module>` with `--dir <project>`. First use `--geometry` to resolve symbol/pad geometry without writing a project. After authoring the geometry, use `--plan` to preview and `--report build.json` to capture check findings. Use `--force` only for an intended rebuild; existing traces are not preserved. `--schematic-only` skips the PCB. Run `--help` for the remaining options.

## Top-level fields

| Field | Meaning |
| --- | --- |
| `name`, `sheet`, `sheetNames` | Project and schematic document names |
| `parts`, `blocks`, `sheets` | Circuit and functional grouping; set each block's sheet for multi-page designs |
| `powers`, `nets`, `expect` | Power conventions, net-specific constraints and electrical design intent |
| `board` | Exact rectangular PCB dimensions and enabled copper layer count |
| `sch`, `pcb` | AI-authored geometry; `pcb:false` skips PCB |

See [AI layout](ai-layout.md) for the geometry schema and worked example.

## Parts

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | reference designator and part key; unique |
| `symbol` | yes | preset entry name, or `{ name, designator, pins:[…] }` |
| `ic` | no | system-library device name (optionally with `lcsc: "Cxxxx"`); resolved and PLACED through the EDA client CLI (V4.1.94+) — replaces `symbol`+`footprint`; see below |
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

#### Multi-part components (`A.chip({ units })`)

A large hand-drawn chip (an SoC whose ball map fills a whole page) is split
into functional **units** that share ONE footprint on the PCB. Each unit's
symbol is a proper wide rectangle at 0.1″ (100 mil) pitch, with pins grouped by
name and separated into captioned banks. The schematic stores the BASE
designator on every unit (`U34`); the client renders the unit ordinal itself
(`U34.1`, `U34.2`, …), exactly like the reference project. On the PCB the
units are re-merged into one `U34` footprint.

```js
A.chip({
  id: 'U34', name: 'ALLWINNER_H6', designator: 'U', pitch: 100,
  units: [
    { id: 'A', name: 'Power & Analog', groups: [
        { name: 'Power', pins: { 'VDD-CPU': 'VDD-CPU', /* … */ } },
        { name: 'Clock', pins: { 'XIN': 'XIN', /* … */ } } ] },
    { id: 'B', name: 'LPDDR3 Data', pins: { 'SDQ0': 'SDQ0', /* … */ } },
  ],
  footprint: { name: 'BGA-451', designator: 'U', pads: [[/*…*/]], outline: [/*…*/] },
  pinoutSource: '按 datasheet 手工绘制（用户已确认）'
});
```

- Each unit is `{ id, name, pins: {pin: net} [, pinNames] [, groups] }`; `groups`
  further splits a unit into visually separated banks (`{ name, pins }`).
- The result is a **true EasyEDA Pro multi-part component**: one symbol doc with
  N `PART` records (titled `<symbol>.<n>`), one device, and one schematic
  `COMPONENT` per unit, each referencing its `partId` and carrying the base
  designator. Pin names sit inside the body, pin numbers outside, at a
  20-unit (200 mil) stub.
- The netlist comparison and ERC match the units back to `U34` on both sides.
- `pitch` and `halfW` are given in **mil** (the symbol document itself is in
  10-mil units and the builder converts). The pitch defaults to 100 mil; the
  body auto-widens past `halfW` (default 400 mil each side) until the longest
  pin name fits each column.

### Auto footprints (`{ "auto": … }`)

```json
"footprint": { "auto": "LQFP48" }
"footprint": { "auto": "QFN", "pins": 24, "pitch": 20 }
```

Families (pad geometry generated from formulas with **external evidence** —
JEDEC / IPC-7351B / real LCSC parts; the per-family table with sources lives in
[`docs/footprint-evidence.md`](footprint-evidence.md) and `test/dfm.js` asserts
the key dimensions): `SOT23` `SOT23-5` `SOT23-6` `SOT223` · `SOP<n>` `SSOP<n>`
`TSSOP<n>` · `QFN<n>` `QFP<n>`/`LQFP<n>` · `DFN<n>` `LGA<n>` · `DIP<n>` · `HDR<n>` `HDR2R<n>` ·
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

2.x resolves model-specific devices **through the EDA client** — there is no
local library cache and no document download. The client returns the device
geometry for layout (`lib_Symbol.getGeometry` / `lib_Footprint.getGeometry`),
the skill writes the project skeleton, and the client then places the official
symbol and footprint instances itself (`sch_SourcePrimitiveComponent.add` /
`pcb_PrimitiveComponent.create`) at the planned coordinates and links the pad
nets. The flow needs the desktop client **V4.1.94+**; without it the build
stops with a clear message.

```json
{ "id": "U1", "ic": "STM32F103C8T6", "lcsc": "C8734",
  "pins": { "1": "3V3", "23": "GND", "24": "3V3", "34": "SWDIO", "37": "SWCLK" } }
```

Map only the pins the design actually uses; `autoNC: true` fills the rest as
`"NC"` from the resolved pin list. An `ic` part replaces `symbol` +
`footprint` — give one or the other, never both. If the client library cannot
find the device, self-build the inline symbol (functional pin grouping) + an
`{auto}` footprint, CONFIRM the pinout with the user against the datasheet,
and declare `pinoutSource: "按 datasheet 手工绘制（用户已确认）"` — I007 fails
undeclared real-device pinouts. Never hand-type a real chip's pins from memory.

### Typed recipes (`"bind"`)

A recipe may declare that it needs a **kind** of device instead of a specific
chip:

```json
{
  "name": "ldo-typed",
  "bind": { "device": { "class": "regulator.ldo", "requiredRoles": ["VIN", "VOUT", "GND"] } },
  "ports": { "VIN": "VIN", "3V3": "VOUT", "GND": "GND" },
  "parts": [ { "id": "U1", "$device": true }, ... ]
}
```

`lib/select.js` picks the best IC entry of that class by role coverage
(`node scripts/recipe.js devices [--class X]` lists what the library has);
`recipe.js apply … --device NAME` forces one. The chosen entry's `pinRoles`
expand into `roles: { ROLE: net }` on the part, which `design.js` turns into
pin→net and the intent gate checks as **I008** (required roles bound, no pin in
two roles bound to different nets). With no device in the class the build
fails and names the missing capability — it never invents a pinout.

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

## Schematic and PCB placement/routing

The AI specifies coordinates, rotations, wires, layer assignments, widths and vias. The emitter writes that geometry as-is and runs the checks. No local or client layout/routing engine is used. See [AI layout](ai-layout.md). Use the editor to verify placement, routing, copper fill and the actual stackup.

## Rebuilding and repair

`build.js --force` regenerates everything from the design file — the generated
records are not a source of truth, the design file is. Patch the design, rebuild,
re-read the gates. Hand-editing `.esch2`/`.epcb2` JSON is a last resort reserved
for things the declarative layer cannot express yet (e.g. a specific silkscreen
artwork), and requires [`format-reference.md`](format-reference.md).

## Recipes

`recipe/*.json` are circuit fragments covering common sub-circuits
(LDO, buck, MCU minimum system, USB-C power, I2C sensor, RS485, crystal, MOSFET
switch, power tree, RC filters, divider, LED, button debounce, UART). The
fastest safe way to author a new board: copy the closest recipe, change the
parts and nets, author the geometry, then run `build.js`.

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
  "divider": [{ "input": "VIN", "output": "FB", "top": "R1", "bottom": "R2", "ratio": 0.5, "tol": 0.05,
               "vref": 1.24, "vtol": 0.05 }]
}
```

All fields optional; the gate only runs the rules you declare. `polarity` marks
are checked even without an `expect` block. In `divider`, `vref` (the
controller's feedback reference, V) turns the ratio check into a voltage check:
I005 computes `vout = vref × (top+bottom)/bottom` and compares it against
`vout` (or the volt number in the `input` rail's name, e.g. "5V" → 5) within
`vtol` (default 5 %) — a ratio that is self-consistent but built for the wrong
reference now fails. `valueRange` parses `4k7`/`1k5`/`2R2` shorthand too.
Rule codes I001–I006 live in
[`docs/checks.md`](checks.md). `build.js` fails on intent errors just like on
ERC errors; `--allow-intent` skips the gate. Standalone: `node scripts/intent.js
--design design.json`.
