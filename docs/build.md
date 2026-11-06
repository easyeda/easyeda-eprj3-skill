# Declarative build (`design.json`)

`scripts/build.js` turns one design file into a complete, checked `.eprj3`
project. This document is the reference for everything the file can express;
[`SKILL.md`](../SKILL.md) has the short version.

```bash
node scripts/build.js --design design.json --dir <absolute project dir> [options]
```

Options: `--force` (rebuild; removes index, `sch/`, `pcb/`, `panel/`, `.tmp/`),
`--design <file>` **or** `--gen <generator.js>` (a module `(A) => design` using
`lib/authoring.js`), `--digest` (one-page snapshot: counts, gates, rats — for
resuming a session),
`--dry-run` (rehearse into a throwaway dir, then delete it),
`--plan` (print the confirmed plan — power chain, nets, widths, rules, intent —
then run the same rehearsal; the target dir is never touched. This is the
human confirmation gate; its board line reads
"只布局（本 skill 不做布线/铺铜，铜皮在客户端完成）"), `--schematic-only`,
`--report <file>`, `--quiet`, `--keep-tmp`,
`--allow-erc`, `--allow-lint`, `--allow-drc`, `--allow-intent`, `--no-tidy`
(keep declared rotations — default runs the sch-tidy two-pass orientation
optimizer: layout → rotate symbols onto their signal axes → re-layout),
`--skill-layout` (client builds only: keep the planner's PCB placement instead
of running the client's auto layout after the import),
`--no-patterns` (skip the circuit-pattern macros below; default on),
`--no-search` (skip the local block-move search pass below; default on).

`--route`, `--pour`, `--no-route` and `--no-pour` were **removed in 1.13** —
the skill never routes and never pours, so passing any of them is an
`Unknown option` error. See "Copper policy" below.

Exit 0 means **every gate passed**. Non-zero means the described error count;
the printed codes point at the rule that failed.

When the build drives the client (any `"ic"` part), it also runs the client's
schematic DRC (`sch_Drc.check`) on the finished sheet. The report lands in
`build.json` as `schDrc` (counts + violations with rule / net / designator);
`fatalError`/`error` items fail the build unless `--allow-sch-drc` is passed.
`node scripts/eda.js sch-drc --dir <project>` re-runs the same check standalone.

## Top-level fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | design file stem | project + index name; need not match the directory |
| `board` | `{width,height}` | `1600×1000` | mil; **ignored for the outline** — the board is auto-sized to 1.25× the footprint bbox area |
| `sheet` | `{schematic,name}` | `Schematic1` / `P1` | `name` is the sheet title (file name) |
| `powers` | object | `{}` | net → `"up"`/`"down"`; those nets become power flags |
| `nets` | object | `{}` | `{ "VCC": { "power": "up" } }` is the long form of `powers`; `{ "MOTOR_A": { "width": 30 } }` **annotates** the intended track width (nothing is routed — the DRC uses it as a per-net floor when it reviews imported copper) |
| `netClasses` | object | `{}` | `{ "POWER": { "width": 30 } }` — groups referenced from `nets` via `{ "class": "POWER" }` (annotation only) |
| `blocks` | array | one implicit block | `[{ title, parts:[id,…], desc, sheet }]` in signal-flow order; keep 2–8 related parts per block; `desc` = one-line functional description rendered under the title; `sheet` = 1-based page override |
| `sheets` | number | `1` | schematic pagination — blocks fill N sheets in declaration order (see Multi-sheet designs) |
| `sheetNames` | string[] | — | one functional title per page (`["电源与充电","主控",…]`); it becomes the tab and the file name. Without it a multi-page design names each page after its first block; a single-page design keeps `sheet.name` (P1) |
| `parts` | array | **required** | see below |
| `expect` | object | — | fifth-gate declarations (`decoupling`, `pairs`, `valueRange`, `divider`) — see the end of this file |
| `layout` | object | see table | grid/tuning knobs |
| `frame` | object | `{}` | `{ titleBlock: true }` 显示明细表（默认隐藏）。图框的 **Width/Height 按内容包围盒（含负坐标）+ 60 单位边距**计算：内容放得进 A4 就用 A4，放不进就用恰好包住内容的**自定义宽高**（`Size` 只作标准纸标签），客户端按这两个数值画框，内容居中摆放 |
| — | — | — | cross-block nets encode as **net-port connectors** merged by name — the human pattern; only same-block nets draw wires. Every port places a committed client-extracted preset **verbatim** — `PORT_OUT` when the block only drives the net, `PORT_IN` when it only receives it, `PORT_BI` otherwise (declared pin dir → symbol pin type → pin name); the net name is a component attribute, not a regenerated per-net symbol. A pin in a 100-mil column (another pin within 160 mil on the same axis) takes a **stub + global net label** instead: a port body/name is ~14 units tall and would overlap the neighbouring row — that is the readable drawing for a multi-unit IC. The same fallback applies whenever no clean port site exists (the port body or its printed name would land on another wire / designator) — a label is smaller and never forced into clutter |
| — | — | — | an inline symbol with >4 pins is drawn in the official IC style (100 mil pitch, names inside / numbers outside, both visible, body sized to the longest name) and keeps its original name; the build lists such parts and asks for the official `"ic"` entry instead |
| — | — | — | an **auto footprint** (`{auto:"QFN",pins:24}`) is named from its generated land pattern (`QFN-24_L5.6-W5.6-P0.50`), not from the bare family token; a name with the official `_L…-W…-P…` form is kept verbatim |
| — | — | — | the Designator prints at the symbol's **top-left**, the value/name at its **bottom-left**, both outside the body for any rotation. Rows are measured from the **body** box, not the pin-inclusive extent (a rotated two-pin part's rows used to float at its far pin tips); a vertical two-pin part puts both rows to the **right** of the body, stacked around its centre. On a client build the rows are applied through `sch_SourcePrimitiveComponent.updateAttribute` (source API, addressed by designator + key), so the client-placed library symbols get them too |
| — | — | — | a wire's net name prints **horizontally**, just right of a vertical wire (rotated text ran through designators and neighbouring wires); vertical T-drops meet a trunk on a **segment endpoint** (a wire ending inside another wire does not connect) |
| — | — | — | PCB: each block is one cluster around its largest part, members placed beside the pads they share a non-ground net with; clusters packed in block order with a 300 mil channel; J/CN/USB connectors on the board edge |
| — | — | — | module captions read **top-left** (the title strip is reserved on the client's top edge); a module frame pads 110 mil, enough to contain the printed net names and port bodies |
| — | — | — | multi-pin symbols never rotate 90/270 (`sch-tidy`): ICs keep their pins on the left/right; two-pin R/C/D/LED parts may take any of the four orientations. After the final placement, 2-pin parts are re-checked once more on the spot they actually occupy (a 90° turn is taken when it shortens the run to same-net pins and the rotated body still fits its frame) |
| — | — | — | a block made only of **two-pin parts in a chain** (LED + series resistor, RC, voltage divider, pull-up ladder) is laid out by the pattern macro: vertical chain, supply north, ground south, shared pins facing, a sideways port on an internal cross-block net. Clashing frames push whole blocks apart (`sch-patterns.js`) |
| — | — | — | collinear, contiguous **same-net pins of one block share a rail and ONE flag** (bank comb); a foreign pin between two members cancels the bank. A ground flag follows its pin: downward pin keeps the flag, horizontal pin gets a short drop, upward pin becomes a stub + net label (no flag printed on the part) |
| — | — | — | a block made only of two-pin parts that all share both nets (decoupling caps) or one net with distinct partners (pull-up/down) is laid out as an aligned row (`sch-patterns.js`), so the bank comb can merge the common side into one rail |
| — | — | — | **pattern catalog** (`sch-patterns.js`, matched by pin topology and declared power nets — never by part number/refdes): two-pin **chains**, **parallel/pull banks**, **hub + satellites** (a regulator/connector/button with its caps, ESD or gate-RC beside the pins they serve), **crystal + load caps**, **series + shunt** (inductor/ferrite/0R feeding an output-cap row, incl. multi-phase DCDC), **bridge** (AC-coupling caps or series resistors between two ICs). A mixed block absorbs several patterns in one pass; each group stacks below the parts that stay put. The composed frame keeps its top edge and is rejected above 1.10× the original area (1.45× for a supply/ground bank), restoring the generic placement on rejection. Measure coverage with `node scripts/pattern-coverage.js --design <file>` (target ≥90%, `--fail-under` for CI) |
| — | — | — | **local search**: after the layout strategies are scored, one block at a time is nudged on the 10-mil grid (up to 8 directions, 2 rounds), re-routed and re-scored; a move is kept only when the sheet stays contact-free, block frames stay apart and the same 0.985 quality gate accepts it. Bounded to ≤48 parts and ≤8 blocks so a large sheet does not pay for a route per trial |
| `pcb` | object or `false` | `{}` | `false` skips the PCB entirely; `layout: "skill"` keeps the planner's own placement instead of the client's auto layout (client builds only); `rules` declares the DRC/DFM floors (`clearance`, `trackWidth`, `edgeClearance`, `minDrill`, `minRing`, `minAngle`) |
| `meta` | object | — | requirement metadata written by `intake.js` (`function`, `input`, `current_mA`, `rails`, `interfaces`, `mcu`, `package`, `layers`, `modules`). Documentation only: the project report turns it into the 功能描述 / 功能特性 sections; the build itself ignores it |

`layout` knobs: `cols` (max columns per block, default 3), `cellW` (150),
`cellH` (110), `blockGapX` (160), `blockGapY` (140), `margin` (70). Increase the
cells for large inline symbols so blocks keep their gutters.

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

The board outline is sized from the placement: **area = 1.25× the tight union
of every footprint's bbox**, with the bbox's own aspect. There is no minimum
area and no declared-size floor — `board.width/height` in the design is ignored
for the outline. When the target is too dense the placer tightens its part
spacing (down to ×0.25) and re-packs; only if even that does not fit does the
outline grow, and the build log reports the bbox and the achieved factor.
Supply `place` when a part needs an exact spot — it always wins, and a fixed
part is a **keepout** for everything the placer arranges around it (mounting
holes no longer get a resistor dropped on them).

### Client auto layout (2.x client builds)

When the build drives the client for any `"ic"` part, it does not stop at the
skill's planned positions: after the board outline exists and the client's
"schematic → PCB" import has created the footprints, `build.js` calls the
client's **own auto layout** (`pcb_Document.autoLayout`) in the same headless
session and saves the arranged board. The planner's positions remain the
fallback (they still decide the board size and the pad-net/rats data); if the
engine is unavailable or reports a failure, the build keeps them and logs it.

- `pcb.layout: "skill"` or `--skill-layout` keeps the skill's engineering
  placement instead (connectors on the edge, decoupling caps beside their IC).
- `build.json` records `pcb.layout` (`"client-auto"` / `"skill-placement"`) and
  `pcb.autoLayout` (engine duration, failed count, error).
- The engine arranges for spacing, not for our tight outline, so it can park a
  footprint just outside it. The build then **grows the board outline** to
  contain every placed pad (+50 mil) and logs
  `board grown to W×H mil`; the planned 1.25× size stays the floor, the origin
  stays at 0 where possible.
- The DRC/DFM gates then judge the arranged board, so an auto layout that
  still spills fails the build the same way a hand placement would.

The **schematic** side gets the same treatment: the build verifies the routed
sheet for cross-net contacts (where the client would merge two nets) and, if
one exists, redoes the layout on a looser grid before failing — density is
never allowed to silently short a net.

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
section is `{parts, mode: 'placed-only', layout, source, rats}`.

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
