# Changelog

All notable changes to **easyeda-eprj3-skill** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Versioning convention: every change that lands in a commit must bump `package.json` (`patch` for fixes, `minor` for new capabilities or behavior changes, `major` only for format-breaking record changes) **and** add an entry here in the same commit.

## [1.35.0] - 2026-11-02

**Schematic fidelity: official net ports by signal direction, readable IC
symbols with visible pin names/numbers, upright ICs, top-left module titles,
frames that contain their labels, module-clustered PCB placement.**

Driven by a review of two PRD-generated boards (ESP32 and Allwinner H6): the
netlist was correct but the drawing did not look like a human's. Layout rules
distilled (re-expressed, not copied) from an external PCB design guideline and
the `easyeda-schematic-autodraw` skill are now part of SKILL.md.

### Added
- **Port kind follows the signal.** Each block's side of a cross-block net gets
  the committed `PORT_IN`, `PORT_OUT` or `PORT_BI` preset: OUT when the block
  only drives the net, IN when it only receives it, BI for mixed/bus/unknown.
  Evidence order: declared pin direction → symbol Pin Type → pin name
  (TX/DOUT/INT drive; RX/DIN/EN/RST/CS receive). The IN preset (body on −x) is
  turned an extra half-turn so every kind sits on the far side of its wire.
- **Official-style inline IC symbols.** An inline pin list with more than four
  pins is laid out like the official library: 100 mil pitch, 200 mil stubs,
  body widened to the longest pin name, names inside / numbers outside, both
  VISIBLE (the old auto layout used a 300 mil pitch on a 200 mil sliver with
  hidden labels — USB1/U1 were unreadable). Label offsets match the client
  sample.
- **`sch-tokens.js` design tokens.** Every spacing the placer/router uses
  (pin pitch, module gaps, frame padding, title strip, stub, port name
  offset, PCB part/module gaps) comes from one token sheet, the way a slide
  deck takes every color from `base.css`.
- **Hub-and-satellites pattern** (`sch-patterns.js`): one multi-pin part (a
  regulator, connector, push-button) plus two-pin satellites that each share
  exactly one net with it — VIN/VOUT caps, an ESD array, a gate RC — are laid
  out with each satellite beside the anchor pin it belongs to, shared pin
  facing the anchor, so the router draws one short wire per satellite.
- **Module-clustered PCB placement** (`pcb-plan.js`): every schematic block is
  one cluster around its largest part; each further member takes the free spot
  closest to the pads it shares a non-ground net with (decoupling caps land at
  their supply pins). Clusters are shelf-packed in block order with a 300 mil
  channel; J/CN/USB connectors keep the board edge.
- **Vertical routing channels.** Same-block pairs also try Z paths through
  vertical channels (and wider horizontal ones), so fewer in-module nets fall
  back to stub + label.
- **Frames grow to their text.** After routing, each module frame expands to
  contain the port names, flag names and stub labels that belong to it, never
  closer than 20 units to a neighbouring frame.
- **Library-fidelity notice.** The build names every multi-pin part drawn from
  an inline pin list and asks for the official entry (`"ic": …`).
- **Dense IC power pins carry labels.** A power pin on a multi-pin symbol with
  another pin within 200 mil uses stub + net label instead of a stacked flag;
  the decoupling bank keeps the real supply/ground symbols.
- **No-clean-exit gate.** A pin the router cannot even leave (e.g. a power stub
  committed on its only escape line) is now the same retry tier as a cross-net
  contact: the candidate is re-laid on a looser grid, and the build fails with
  the pin named if every density still leaves it unconnected.
- **Ground-flag orientation policy** (`sch-route.js`): a downward pin keeps the
  plain flag; a horizontal pin gets a short vertical drop so the ground symbol
  hangs below the wire; an upward pin uses a stub + net label instead of a flag
  that would overprint the part.
- **Signal-before-power routing.** Signal nets are routed first and power flags
  last; a flag stub can no longer block a neighbouring pin's only exit (H6
  U4.43 next to a VCC-5V stub), because flags try several lengths/directions
  and avoid committed wires.

### Changed
- **Net ports use the committed presets verbatim.** Every port places the
  client-extracted `PORT_IN` / `PORT_OUT` / `PORT_BI` symbol/device documents
  (official shape, size and name); one shared symbol per kind serves all nets
  and the net name lives in the component attributes. The printed name uses
  the official 45-mil offset and is made visible (the preset documents ship an
  empty Name attribute). No more per-net rectangular `PORT_<net>` symbols.
- **Symbol/footprint documents keep the original library names**; the
  `SYM_`/`FP_` prefix survives only as the internal staging key. Device docs
  reference those original names.
- **Stub-label net names** continue the wire beyond its free end, vertically
  centred (`LEFT_MIDDLE` / `RIGHT_MIDDLE`), so at a 100 mil pitch they no longer
  climb into the neighbouring row.
- **Multi-pin symbols no longer rotate 90/270** in `sch-tidy`: a part with more
  than four pins may only flip 0/180, so ICs keep their pins on the left/right
  (two-pin R/C/D/LED parts remain free).
- **Module titles moved to the top-left.** The client draws Y-up, so the title
  strip is reserved on the TOP edge (`y2`) and the caption is drawn at
  `y2 - 20` (description `y2 - 40`); previously it sat on the bottom edge.
- **Frame padding raised to 110 mil** for the shelf placer and mixed-bank rows
  (layered already used 110). Ports print their net ~45 mil past a 40-mil body,
  so the old 36-mil frame left names outside the black box.
- **Decoupling banks are accepted up to 1.45× the block area** (was 1.10×) when
  the bank shares a declared supply/ground, so caps sit side by side instead of
  being spread by the generic grid; other banks keep the conservative gate.
- **Multi-block port sites are clearance-checked** against foreign wires, pins,
  flags and ports; when every member stub is crowded the port gets its own
  dedicated stub. `labelEncoding` also avoids dropping the printed net name
  inside a symbol body (lint L009).

### Fixed
- **Fetched LCSC symbols now load in the client.** The fetch format's graphics
  fields differ from the client record shape — RECT `x/y/x2/y2` vs
  `dotX1…`, CIRCLE `cx/cy/r` vs `centerX/centerY/radius` — and re-emitting
  them verbatim made the client reject the whole symbol document ("符号加载
  报错", associations lost; bodies invisible). All raw graphics are now
  normalized to the client's exact field set, and the raw symbol BBOX reads
  the normalized shapes (reading the old names degraded every official body
  to the pin-span box, tripping phantom through-body violations).
- A port could be anchored exactly on another net's vertical wire (ESP32 built
  only at a 5–8× looser density because of it); port sites now reject any
  foreign contact.
- The label/port name box is no longer allowed to sit on a part body in the
  stub+label fallback.

## [1.34.0] - 2026-11-02

**Mixed-block pattern subgroups and a group-level local search.**

Continues the self-developed port of the reference layout engine's ideas: a
block that is not a pure chain/bank can still absorb its decoupling bank, and
the finished placement is refined by re-routing cheap block moves. Still no
copied code and no new dependency (`scripts/depcheck.js` stays at 0).

### Added
- **Mixed-block sub-banks (`sch-patterns.js`).** When the block as a whole is
  neither a chain nor a bank, the largest subset of its two-pin members that
  forms a parallel bank (all share both nets) or a pull bank (share one net,
  distinct partners) is laid out as one row beside the rest — right of them or
  above them, whichever yields the smaller block. The frame is recomputed from
  the result (vacated space is reclaimed), and the row is applied only while
  the block stays within 1.10× its original area; otherwise the generic
  placement is kept untouched.
- **Group-level local search (`build.js`).** After the strategy candidates are
  scored, each block is nudged in 8 directions (20/40 mil, up to 2 rounds);
  every trial is re-routed and re-scored, and a move is accepted only when the
  sheet is contact-free, block frames stay apart and the same 0.985 quality
  gate accepts it. Bounded to ≤48 parts / ≤8 blocks; `--no-search` opts out.
  blink: score 30.53 → 27.70 (layered candidate), gates unchanged.

### Fixed
- **A power-flag's printed net name no longer lands on a symbol body**
  (`sch-route.js`): candidate flag sites whose label box overlaps any part are
  skipped in favour of a longer stub, in both the bank comb and the single-pin
  path. `examples/designs/inline-spec.json` lint 98 → 100 (L009 gone).
- The local-search trials share the candidate quality gate, so a block move can
  never trade a contact or an overlap for a better score.

## [1.33.0] - 2026-10-31

**Circuit pattern macros (self-developed), readable labels, and a frame that
tracks the circuit size.**

The reference layout engine's pattern-macro idea (`eda-copilot-backend
src/circuit-layout/patterns/`) is now implemented for our own placer: no code
copied, no dependency added, only the algorithm re-derived in `sch-patterns.js`.
The same pass also fixed the flag symbols, label offsets and frame sizing that
made the blink example look wrong.

### Added
- **`scripts/lib/sch-patterns.js` — two-pin chain macros.** Per block it
  1. builds the two-pin net graph and splits it into paths (a star, a loop or a
     lone part cancels the macro);
  2. orders each path and orients it: supply end north, ground end south;
  3. stacks members so shared pins face each other (`PIN_GAP` 80) and chooses
     each rotation (0/90/180/270) that makes the two pins vertical;
  4. re-lays the block frame with title strip and pushes later blocks right
     when a grown frame would touch them (parts move with the frame);
  5. marks chain-internal nets so a cross-block one takes a **sideways port**
     instead of a port in the chain gap.
  Applies to both the shelf and layered candidates; `--no-patterns` opts out.
  Verified on blink (POWER INPUT and LED DRIVER become VCC→D1→V_LED→C1→GND and
  V_LED→R1→LED_A→D2→GND straight chains).
- **Restored the client-extracted preset symbols** deleted in 1.19.0:
  `OFFPAGE_IN/OUT/BI` (real Off-Page-Connector, docType 25), `AGND`, `PGND`,
  `SHORT` (docType 22), `DIFF_PAIR` (docType 31) and the `A3`/`A4` frame
  symbols, back under `templates/library/symbol/` (from git history; the
  loader accepts all four kinds). `templates/README.md` lists them.
- **Parallel / pull banks get a row layout and a shared rail.** A block made
  only of two-pin parts that all share both nets (decoupling caps) or one net
  with distinct partners (pull-up/down bank) is laid out as one aligned row
  (`sch-patterns.js`); the common side faces the supply (or the ground for a
  down bank). The router then merges collinear contiguous same-net pins of that
  row into one rail with a single flag on the middle stub (rail split at every
  junction, a foreign pin between members cancels the merge) — the reference
  engine's `mergeLocalFlags` / `centerBankFlags` idea. H6: power flags
  679 → 643, gates unchanged. Mixed blocks (a bank plus other parts) are not
  split yet.

### Fixed
- **Power flag symbols were vertically inverted.** Symbol docs are Y-UP: the
  client's `Power-VCC` bar sits at `(0,+10)` and `Ground-GND`'s bars at
  `y −10…−19`. Both were drawn on the opposite side, so every GND flag hung on
  top of its wire. Bars, names and the symbol `y` now match the client's saves.
- **Wire NET text is hidden along any connected path that reaches a flag or
  port** (union-find over segment endpoints, per sheet), and short pin-to-pin
  links / chain-internal nets print no name. Disjoint stub+label wires keep
  their NET value — that is what joins them in the client.
- **Designator/value offsets follow the client's saves**: above/below a
  horizontal part, on the right of a vertical one (they used to sit on the pin
  axis / on the body).
- **Page content is centered** in the chosen frame (offset snapped to the
  10-mil grid) instead of hugging the bottom-left corner.
- **The drawing frame tracks the circuit size through Width/Height**: the box
  is the full content extent (both ends, negative x/y included) plus a 60-unit
  margin; A4 is used when it fits, otherwise the frame is exactly the content
  size (the smallest enclosing standard paper is only the `Size` label) —
  region counts follow it. No more snapping up to A3 for content that is a few
  units over, which left the circuit in a mostly empty sheet.
- **Blocks hold their labels**: `BLOCK_PAD` 36 → 110, shelf cells 90×80 →
  150×110, gaps 110/100 → 160/140.

### Changed
- `examples/blink` regenerated with this version (it was still a 1.25 save with
  no `yAxisDirection`, which opened mirrored outside the frame); its content
  fits A4 again, so it ships on the matching `Drawing-Symbol_A4` frame.
- The corpus skew case bends the selected LINE in **both** axes so it stays a
  skewed-wire test whichever segment happens to be first.
- H6 board: label-overlap pairs stay at 14 (from 300 before 1.32.2), lint/DRC
  100/100, netlists match; each sheet takes the content-sized frame.

## [1.32.2] - 2026-10-31

**Net labels and ports stop printing on top of each other at pin ends.**

Measured on the H6 project (326 parts, 679 flags, 474 ports): overlapping
terminal labels drop from 300 pairs to 24, and the dense pin banks read again.

### Fixed
- **A stub that ends at a power flag or net port no longer repeats the net name
  as the wire's NET text.** The client's own saves leave that value empty; a
  second copy sat right beside the pin and overprinted the part's
  designator/value. The value stays on the record (netlist naming unchanged) —
  only `valueVisible` turns off.
- **Net ports are placed like the client's Off-Page-Connector-In**: the
  component rotates so its body points away from the wire (rotation
  0/180/90/270 by stub direction) and the name sits beyond the body
  (`x±28` / `y±28`) instead of over the 20-unit rectangle. Every port has a
  direction (`dir`) carried from the router to the writer.
- **Power flags and ports walk a four-step staircase by pin column** (stub 40 /
  54 / 68 / 82 units) when a name would collide. A 10-unit pin pitch put every
  label of a bank on one row; the reserved label box (`ctx.flagBoxes`, shared by
  flags and ports) is checked before each placement, and an electrically clean
  position with crowded text is preferred over a flag sitting on the pin.

## [1.32.1] - 2026-10-31

**Drawing frame and content finally agree — measured against the reference.**

The page border used to sit in the top-left corner with the circuit hanging
below it. The cause was the y-axis flag plus a frame template taken from an
older client save. Everything below was measured from
`examples/multi-part-sch` (client 4.1.93), not guessed.

### Fixed
- **Every schematic record declares `yAxisDirection: "up"`** — components,
  their ATTRs, wires, wire segments, block rects, free text and every element
  of a symbol doc (CANVAS/PART/PIN/RECT/TEXT/ATTR). Without the flag the
  client reads the record as y-down and mirrors the part below the page, which
  is exactly what a frame "floating above the circuit" looked like.
- **The frame template is regenerated from the reference**: title-block field
  coordinates (`Company` y −10, `Drawed` y 80, …), the placeholder order and
  the y-up flags now match record-for-record (the old template carried negated
  y values and no flags).
- Page `Size`/`Width`/`Height`/`X/Y Region Count`/`Title Block` in both the
  frame device and the sheet's title-block attrs now follow the chosen paper
  instead of a hardcoded A4.
- `build` sizes the frame from the content in the sheet's own units, and when a
  dense sheet exceeds A0 it emits a custom page of the content size (still
  labelled A0) so no part hangs outside the border.
- Each sheet's content is lifted by a 40-unit margin above the page origin
  (`shiftSheetsIntoPage`), so block frames and their titles stay inside.

Result on the H6 board: all 9 sheets lint 100/100 with zero findings, and the
rendered pages put every block inside the border; units render `U34.1 … U34.7`.

## [1.32.0] - 2026-10-31

**Multi-part components + EasyEDA-Pro-style symbols + a tenfold unit fix.**

A large hand-drawn chip (the H6's 186-pin logical symbol used to render as a
20×6000 mil sliver) can now be authored as ONE part split into functional
units, serialised as a TRUE multi-part component: one symbol doc with N `PART`
records and one device, exactly like EasyEDA Pro — verified record-by-record
against `examples/multi-part-sch` (a client-saved `SP485EEN-L/TR` project) and
the `BCM89071` library entry.

While validating against that reference this also uncovered a units bug that
had made **every** generated and imported symbol ten times oversized.

### Added
- `A.chip({ units: [...] })` — declare a multi-part component. Each unit is
  `{ id:'A', name:'HDMI', pins:{…} [, pinNames] [, groups] }`; `groups` further
  splits a unit into separated pin banks (`groups:[{ name:'DQ', pins:{…} }]`),
  and each bank is captioned inside the body.
- Multi-part symbol serialisation (`buildMultiPartSymbolDoc`): ONE symbol doc
  holds N `PART` records (title `<symbol>.<n>`, `DeviceName` by name only), each
  owning its body/pins and per-part `Symbol`/`Designator`/`Name`/`Device`/
  `Footprint`/`Multi-Part Group` attrs; the schematic places one `COMPONENT`
  per part (same symbol + device uuid, a different `partId`).
- EasyEDA Pro pin-label layout: pin **name inside** the body, pin **number
  outside** near the pin (2 mil in / 5 mil out, name 5 mil above the line, as in
  the reference), 20-unit stub, `valueVisible` on.
- Grouped symbol layout (`layoutSymbolPins`): body auto-widens until the longest
  pin name fits each column (`halfW`, mil), 100 mil pitch, a 300 mil band
  between banks with a caption.

### Changed
- **A multi-part unit stores the BASE designator (`U34`)**; the client appends
  the unit ordinal itself and renders `U34.1 … U34.7` (the reference project
  stores `U1` on both units). Unit designators are never rotated by the
  orientation pass — a bank symbol is read left-to-right.
- The PCB stage re-merges units into ONE footprint with the base designator,
  pads bound from the union of every unit's pins.
- Schematic↔PCB netlist comparison and ERC use the base designator on both
  sides (`E003` expectations, `E004` duplicate check counts one multi-part
  symbol as a single owner), with the unit-letter fallback kept for the
  standalone CLIs.
- Sheets are real paper sizes: a generated frame now carries a standard
  Width/Height (A4 `1170×825`, A3, A2, A1, A0) and the same size in
  `Size`/`Page Size`, instead of a content-sized rectangle that the client drew
  as a second, smaller border inside the page.

### Fixed
- **Generated grouped symbols were 10× oversized**: design values (pitch,
  halfW) are in MIL but the symbol document is in 10-mil units — a 100 mil
  pitch was laid out as 1000 mil, so an A4 sheet could never hold the symbol.
- **Imported LCSC symbols were 10× oversized**: `fetch-lcsc` multiplied library
  symbol coordinates by 10 although both sides already use 10-mil units
  (`K4E6E304EC` came out 88 in tall — exactly ten times its 8.9 in of 100-mil
  rows). Imported pin stubs are now the official 20 units.
- `lint` compared the frame (multiplied by 10) against raw sheet coordinates, so
  L007 never fired; `build` divided the content extent by 10 when sizing the
  frame, so it always chose A4. Both now use the sheet's own units.
- The layout density ladder retries at 1×/1.7×/2.9×/5×/8× before failing.


## [1.31.2] - 2026-10-30

**Eliminate the remaining cross-net contacts: flag/port/NC/label placement.**

Completes the collision avoidance from 1.31.1. The h6 9-sheet board still
hard-failed with 6 (shelf) / 34 (layered) cross-net contacts even at 493% grid
loosening; every one traced to a placement that ignored a foreign pin/port/wire.

### Fixed
- **Power-flag placement now clears foreign pins and net ports**, not just other
  flags and part boxes: a flag drawn *through* another net's port or
  not-yet-wired pin used to short the two nets the moment that pin's stub was
  later drawn (the `flag(GND) x <net>` / `port(X) x GND` family).
- **Cross-sheet net-port placement checks its stub against foreign committed
  wires and pin tips** before emitting; when no clean stub fits, the port sits
  directly on the pin tip. This was the `port(HDMI-CEC) x DDC_CEC_EN` /
  `port(HSCL) x HDMI-SDA` family (a port dropped onto a level-shifted net's wire).
- **NC / DNC nets never get a net port, even cross-sheet** — they fall through to
  the stub+label path, matching single-sheet NC semantics (a port would merge the
  no-connect pins into one net).
- **`placeNodePort` also avoids foreign pin tips**, closing the last port-vs-pin
  gap.
- **Label jog last-resort** no longer emits a shorting stub: when even the 10-mil
  jog touches a foreign wire (two facing pins of different nets meet in the
  middle), the stub steps *perpendicular* from the pin tip — a label alone would
  not connect the pin (the netlist only unions a pin where a wire endpoint lands
  on it), so the escape wire still carries the net name — the `NC x UBOOT_KEY`
  family.

### Verified
- h6 (320 parts · 9 sheets) now builds at 100% grid density with **0** cross-net
  contacts (was 82 → 6 → 2, requiring 170% loosening). The tighter base grid
  keeps blocks packed closer to the reference-project look.
- smoke 133/133 · pipeline 95/95 · dfm 97/97 · corpus 110/110 · depcheck 0.

## [1.31.1] - 2026-10-30

**Routing collision avoidance + per-sheet block density.**

### Fixed
- **`scoreOf` now rejects routes that touch a foreign power flag / net port /
  pin tip** (exact contact, matching `countCrossNetContacts`) — a trunk used to
  draw straight through another net's flag or not-yet-wired pin, shorting two
  nets at tight layout density. `ctx` now tracks `pinPoints` / `portPoints`.
- **Power-flag jog last-resort** no longer emits a clashing lateral stub: when
  no clean exit exists the flag sits directly on the pin (co-located, so the
  netlist unions it) instead of shorting the pin to a foreign net.
- **Per-sheet √N block packing** (`layoutSchematic` + `layoutLayered`):
  `colsPerRow` was computed from the WHOLE design's block count, so a 9-block
  sheet got 8 columns and spread 31 inches wide; now it uses the block count ON
  that sheet.

### Verified
- smoke 133/133 · pipeline 95/95 · dfm 97/97 · corpus 110/110 · depcheck 0.

## [1.31.0] - 2026-10-30

**Post-build reports: `project-report.md` + `ai-report.md`.**

### Added
- [`lib/report.js`](scripts/lib/report.js) + `scripts/report.js --dir <project>
  [--design design.json | --gen gen.js] [--report build.json]` — writes
  `project-report.md`: 工程概述 / 功能特性 / 信号框架图 / 电路（电源）框架图
  （mermaid）/ 网络概览 / 验证结果 / 遗留问题 / 建议. Everything is computed from
  design.json + the built project, never guessed; `--report build.json` fills the
  gate results (lint/DRC scores, gate findings, netcheck), otherwise they read
  "未知".
- `make-board.js` writes `project-report.md` automatically and exposes its path
  as `projectReport` in the digest, so the one-shot path ships both the build
  and the report.
- SKILL.md **Reports** section: `project-report.md` (machine-generated) and
  `ai-report.md` (agent-written — model, tokens, agent names, start/end time and
  a step timeline; `N/A` when the host exposes no counter). Template included.
- `package.json` adds a `report` script.
- SKILL.md **运行时任务进度**: the agent prints a 5-step task checklist
  (intake → build → audit → report → open) before starting, ticks each step as
  it completes (`✅ [i/N]`), and stops on the current step with `❌` + reason on
  failure — so the user always sees how many tasks are left and which one is
  running.

### Fixed — 原理图外观与符号保真
- **模块矩形框恢复**（`build.js`）: 每个功能模块重新画一圈矩形框 + 标题/说明
  （之前误删，用户反馈「模块没有被框包裹」）。
- **官方库符号本体丢失**（`fetch-lcsc.js`）: EasyEDA `dataStr` 的矩形格式是
  `R~x~y~radiusX~radiusY~w~h~…`，旧解码把圆角半径（2,2）当成宽高，导致
  AXP805 等大 IC 的 1000×2900 mil 本体被解成 20×20 mil 小点，符号只剩悬空
  引脚、没有外壳。已按正确字段解码（含圆角），并重抓全部 18 个缓存 IC。
- `countCrossNetContacts` 增加 `EPRJ3_DEBUG_CONTACTS` 环境变量门控的详情
  dump（默认零影响），用于定位布线跨网接触。

### Verified
- smoke 133/133 · pipeline 95/95 · dfm 97/97 · corpus 110/110 · depcheck 0.

## [1.30.0] - 2026-10-29

**One day, merged:** an independent netlist audit, a schematic layout/routing
upgrade, typed recipes, the library policy, client-fidelity fixes — and the
preview pipeline removed.

### Netlist audit — a fresh reviewer, not you
The build's own `E003` compares the recovered netlist with design.json *inside
the build*, but the agent that wrote the design is the agent reading that
verdict — a mistake shared by both sides is invisible. Every build now ends
with an independent read:
- [`lib/audit.js`](scripts/lib/audit.js) + `scripts/netlist.js --design
  <design.json> --audit <out.json>` (or `--gen` for generator-authored designs,
  via `design.readSource`): a self-contained package
  (`schema: eprj3-netlist-audit/1`) holding `spec` (pin→net declared in
  design.json), `built` (netlist recovered from the schematic), `mechanical`
  (net-by-net diff, pins on two nets, vanished pins, NC violations, netcheck
  verdict, advisory suspicions), the `rubric` the reviewer must run and the
  `verdictSchema` it must return. Exits 0 — it reports, it does not judge.
- `make-board.js` writes that package automatically and exposes
  `audit: {ok, file}` in the digest.
- SKILL.md makes the review mandatory: a **fresh** sub-agent per round (no
  inherited context, 3-round cap, `mechanical.ok` as the hard floor, a new
  reviewer after every rebuild), with the no-sub-agent fallback.
- `--design` without `--audit` prints the spec↔built diff as a table.

### Schematic layout & routing
- **Layered placement** ([`lib/sch-place.js`](scripts/lib/sch-place.js)):
  signal-flow layers from a connectivity anchor, barycenter ordering and median
  alignment — replaces declaration-order shelves.
- **Quality model** ([`lib/quality.js`](scripts/lib/quality.js)): area / wire /
  bends / crossings / collinear overlap / through-node, with a √2 landscape
  shape preference. The build runs shelf and layered across densities and keeps
  the best under a safe gate, so a new strategy can never make a sheet worse.
- **Block-aware trunk routing** ([`lib/sch-route.js`](scripts/lib/sch-route.js)):
  a ≥3-pin same-block net routes as a shared trunk; a cross-block net wires each
  block's sub-net and crosses the boundary with one net port per block.
- **Near-square block packing** (`ceil(√N)` columns) instead of a tall sparse
  column.
- **NET labels on the last segment's midpoint** (a trunk's bbox centre floats or
  lands on a part → L009); a power flag steps laterally off a blocking trunk
  drop.

### Typed recipes & library policy
- IC entries carry `class`, `pinRoles` and `requiredRoles`; `lib/select.js`
  binds a device by class + role coverage and names the missing capability when
  nothing fits (`recipe.js devices` lists the cache).
- Recipes declare `"bind": { "device": { class } }`; `recipe.js apply` expands
  the chosen device's roles into `roles: {ROLE: net}`, and `A.recipe()` merges
  one from a gen file. Shipped: `ldo-typed`, `npn-switch-typed`; gate **I008**
  rejects incomplete or ambiguous role bindings.
- **Library policy:** `templates/library/` holds only generic, non-model
  entries. Real part numbers are fetched on demand and cached —
  `<project>/.tmp/library/ic` → `<skill>/.cache/ic` → `~/.easyeda-eprj3/ic`;
  `fetch-lcsc.js --install` writes the per-user cache. On a clean checkout the
  typed tests are skipped with a note, not failed.
- intake prints the typed/fixed recipe coverage split.

### Client fidelity
- **Schematic coordinates are the client's native Y-down**: blocks lay out
  downward from y=0, block titles sit on the top edge, the frame height is
  `y2 + margin`, lint's `FRAME` is y-down.
- **`open.js open` uses the OS file association** (`cmd /c start` on Windows,
  `open` / `xdg-open` elsewhere) — identical to double-clicking the `.eprj3`.
- `A.chip` accepts `pinNames`, so a pin's name and its net are independent.
- Refdes collisions are impossible by construction (one registry, checked at
  the call site); fixed `pcb.place` parts act as keepouts for the auto placer.
- `DFN<n>` / `LGA<n>` auto footprints (IPC-7351B-derived, no thermal pad).

### Preview images removed (user decision)
The skill no longer generates preview images, and no longer hands them to the
agent for visual recognition. Verification is the script gates and the
machine-readable `--report` JSON — not looking at a picture.
- `scripts/render.js` and `scripts/lib/render.js` deleted (SVG generation and
  the headless-browser PNG path / `EPRJ3_BROWSER`); the `render` npm script,
  the test assertions and the docs' preview references removed.
- `make-board.js`'s preview step and the `previews` digest field dropped.
- Kept: `floorplan.js` (a text `pcb.place` map) and `open.js`.

### Fixed
- **Multi-sheet builds** (`sheets: N`) died on every design — blink on two
  pages included — with "cross-net contact(s) … at every density". Sheets are
  independent coordinate spaces, but `countCrossNetContacts` and
  `quality.evaluate` paired objects across pages (phantom contacts, phantom
  `through` hits), and the cross-sheet port branch tested a per-sheet node set,
  so it never fired. Contacts and quality now pair only same-sheet objects,
  cross-sheet detection runs over the whole design, and power nets keep their
  flags on every page.
- Layout density can no longer short nets: every candidate is verified for
  cross-net contacts, retried on a 170 % looser grid, then failed loudly with
  the fix.
- `--plan` prints `N 信号网络 (+ M NC)`; `--digest` prints a one-page resume
  snapshot.

### Verified
- smoke 133/133 · pipeline 83/83 · dfm 97/97 · corpus 110/110 · depcheck 0.

## [1.24.0] - 2026-10-28

**Fetched symbols are used AS-IS** — the official symbol's graphics, pin
geometry, device attributes and footprint silkscreen are carried through
verbatim instead of being re-drawn as a two-column auto layout (user report:
「下载后的符号库放置在原理图里面和原官方库的样式都不一样了；原始符号的器件
属性参数都没有了」). Plus the report-driven fixes from four ESP32-S31 sessions.

### Added
- **`fetch-lcsc.js` verbatim mode**: decodes the official EasyEDA symbol's
  shapes (P/PL/PG/R/E — pins with connection points + rotation, polylines,
  polygons, rects, ellipses) into rawSymbol entries carrying graphics + pin
  geometry + device attrs (c_para: Manufacturer/Package/Supplier Part/…);
  footprint silk TRACK paths decoded from layer 3. `parts.buildInlineSymbolEntry`
  gains a raw mode that writes the official graphics + pin geometry without
  re-drawing. Verified live: C2145 (MMBT5551, 3 pins + 4 POLY + 3 silks),
  C8734 (STM32F103C8T6, 48 pins + 2 graphics + 48 verbatim pads).
- **`autoNC`** (deepseek/mimo reports): unmapped pins of inline/IC symbols
  default to `"NC"` per part (`autoNC: true`) or design-wide (`A.autoNC()`).
  IC entries default to it.
- **`A.chip` / `A.conn`** authoring helpers (report 5.3): inline symbol +
  footprint via a single call, connector W003-exempt.
- **Partial-place notice** (glm §5.1): a `pcb.place` covering only some parts
  logs which parts remain auto-placed.
- **Aspect guard on auto-fit** (qwen §5.5): undeclared boards clamp to
  aspect 1:2.5.
- **DRC findings carry coordinates** (glm §5.4): D001/D003 include `[x,y]`.
- **`--report` gains `elapsed_ms` / `generatedAt`** (mimo §7.11).

### Fixed
- **W003 false positives** (all four reports): legal same-part bridges
  (USB-C A6/B6 dual contacts, connector 3V3 pairs, module jumpers) no longer
  warn. Exempt: power nets, designator `J`, parts with ≥6 pins, or
  `bridge: "ok"` on the part.
- **I006 no longer fires on placed-only boards** (mimo §7.7).
- **`.tmp` cleanup EPERM/EBUSY no longer fails a finished build** (mimo §3):
  cleanup degrades to a note.
- **Output noise** (mimo §7.6, glm §5.7): stub+label fallback notes aggregate
  into one count line; details stay in the report JSON.
- **`--force` into a directory that only holds the gen file** no longer dies
  (the --gen workflow writes the gen file next to the project).
- **Lint L004 body rect for raw symbols** uses the graphics extent (not the
  pin-tip span) so wires to the pins don't false-fire.
- **lint L007 reads each sheet's frame size** from its embedded frame device
  doc instead of a hardcoded A4 (auto-sized frames).

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21. Raw symbol end-to-end: MMBT5551 built with 10 POLY graphics +
  netcheck OK + lint 100.

## [1.23.0] - 2026-10-28

Seventh round, from four real ESP32-S31 board sessions (`jlc-work-project/report/*`):
every agent wrote its own generator scripts (6 temp scripts, 70k tokens of
debugging in one session). This release makes the official authoring path the
easy path, so agents call scripts with parameters instead of writing code.

### Added
- **`lib/authoring.js` + `build.js --gen board.gen.js`** (all four reports'
  #1 ask): the agent writes a SHORT generator file using official helpers —
  `A.block(title, {desc})`, `A.cap/res/ind/led/diode`, `A.ic` (library entry,
  autoNC default), `A.chip` (inline symbol + footprint), `A.conn` (W003-exempt
  connector), `A.place`, `A.power/net/pair/expect`, auto refdes numbering —
  and build.js runs it through the full pipeline. No temp scripts, no
  hand-written 60 KB JSON.
- **`autoNC`** (deepseek/mimo reports): unmapped pins of inline/IC symbols
  default to `"NC"` per part (`autoNC: true`) or design-wide (`A.autoNC()`).
  IC entries default to it; 80-pin MCUs no longer enumerate 30 NC strings.
- **Partial-place notice** (glm §5.1): a `pcb.place` covering only some parts
  logs which parts remain auto-placed, instead of silently colliding.
- **Aspect guard on auto-fit** (qwen §5.5): an undeclared board clamps to
  aspect 1:2.5 (keeps area) instead of growing into a 40×235 mm sliver.
- **DRC findings carry coordinates** (glm §5.4): D001/D003 messages include
  the clash midpoint `[x,y]`.
- **`build.js --report` gains `elapsed_ms` / `generatedAt`** (mimo §7.11).

### Fixed
- **W003 false positives** (all four reports): legal same-part bridges —
  USB-C A6/B6 dual contacts, connector power pairs, module jumpers — no
  longer warn. Exempt: power nets, designator `J`, parts with ≥6 pins
  (connectors/modules), or `bridge: "ok"` on the part.
- **I006 no longer fires on placed-only boards** (mimo §7.7): the pair
  warning was permanent there and carried no information.
- **`.tmp` cleanup EPERM/EBUSY no longer fails a finished build** (mimo §3,
  Windows file locks): cleanup degrades to a note; make-board digests stay
  truthful.
- **Output noise** (mimo §7.6, glm §5.7): stub+label fallback notes
  aggregate into one count line; details stay in the report JSON.
- `--force` into a directory that only holds the generator file no longer
  dies (the --gen workflow writes the gen file next to the project).

### Deferred (from the reports, needs data or bigger scope)
IC entry expansion (ESP32-S3/S31, CH343P, ES8389, QMI8658A… — needs the
official-library LCSC ids, one `fetch-lcsc --install` each), connector auto
families (USB-C 16P full, FPC, micro-SD, GH1.25/SH1.25), pin planner,
power-domain checks, per-block cell sizes.

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21. New probes: authoring helpers (refdes numbering, block
  membership, autoNC) and a `--gen` end-to-end build (netcheck match,
  elapsed_ms reported).

## [1.22.0] - 2026-10-28

**Official-library fetch is now a first-class capability** (user request): when
a part is missing from the IC library, the agent pulls the official EasyEDA
symbol + footprint verbatim instead of hand-typing pinouts — with a defined
self-build fallback when the fetch fails.

### Added
- **`scripts/fetch-lcsc.js`** — `--id C<LCSC>` fetches
  `https://easyeda.com/api/products/{LCSC}/components` and converts the
  official symbol (pin numbers/names/columns verbatim, power-direction naming
  rule applied) + footprint (pad coordinates verbatim, 10-mil units y-down →
  mil/y-up) into an IC entry with the `evidence` block auto-filled (API URL,
  footprint title, datasheet link from the payload). `--install` writes into
  `templates/library/ic/`, `--out <file>` to a path, `--raw` dumps the API
  JSON. Verified live: C6186 (AMS1117-3.3) and C8734 (STM32F103C8T6, 48 pins +
  48 verbatim pads); unknown ids fail cleanly.
- **Two-tier pinout policy** (user constraint, replaces the "never fetch"
  boundary from 1.15.1): ① fetch the official library via the script; ② when
  the fetch fails or the part is absent — self-build a quality symbol
  (functional pin grouping) + an `{auto}` footprint, CONFIRM the pinout with
  the user against the datasheet, and declare
  `pinoutSource: "按 datasheet 手工绘制（用户已确认）"` (I007 still fails
  undeclared real-device pinouts). Policy written into SKILL.md, build.md,
  development.md and footprint-evidence.md.

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21.

## [1.21.0] - 2026-10-28

Seventh round, from the user's verdict on drawing quality and the hand-drawn
`examples/esp32-s31` sample as ground truth. The decisive observation: **the
human never routes long wires** — every cross-module signal is a short stub +
named connector pair placed in tight columns (10 mil spacing), power flags are
local and rotated to the pin direction, modules are grouped by whitespace and
title lines without RECT boxes, and each sheet uses a custom-sized frame.

### Added
- **Connector encoding for cross-block nets** (`sch-route`): any net spanning
  >1 block or >500 mil is encoded per-pin as an adaptive short stub (40→10)
  + named net port — long routed wires no longer exist. Only short
  same-block nets draw visible wires. Same-sheet ports flow through
  `routeNet → routeSchematic → build` (they were silently dropped before).
- **Flag/port collision registries**: connector ports and power flags refuse
  positions within 34/30 mil of a foreign port, on top of the wire-contact
  rules.
- **`netlist` unions co-located pins AND re-evaluates floating pins against
  named groups after UF naming** — a port placed directly on a pin (last
  resort) stays electrically sound instead of reading as E001.

### Fixed
- The connector last-resort no longer emits a jog that can touch a foreign
  wire: the port sits directly on the pin hotspot (clean by construction).
- All `routeNet` returns carry `ports` (the power branch and both
  label-encoding branches dropped them, corrupting same-sheet port nets).
- `layoutSchematic` writes `block.sheet` AFTER pagination; `rc-highpass` and
  the pipeline's pin-reference case route clean again at tight density.

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21 (lint/drc 100). Zero cross-net wire contacts on blink,
  rc-highpass, the two-sheet and the 62-part probes (programmatic scan).

## [1.20.0] - 2026-10-28

Sixth round: drawing-frame quality — no 明细表 by default, and the drawing
frame auto-sizes around the compactly packed modules instead of a fixed A4.

### Added
- **明细表 (title block) hidden by default.** The frame's DEVICE attribute
  `Title Block` is written as `0` and the embedded TABLE record (the title
  block drawing itself) is stripped from the generated frame symbol — nothing
  renders it. `design.frame.titleBlock: true` opts back in.
- **Auto-sized drawing frames.** The frame's `Width`/`Height` attributes (the
  client draws the border from them) are sized around each sheet's packed
  blocks + margin, with `Size` reporting the nearest A-series sheet and the
  region counts rescaled. A 2-block board now gets a ~790×800 mil sheet
  instead of a mostly empty A4.
- **Compact interlocking packing** (紧凑插空): the block shelf packs into a
  region sized ~1.15× the square root of the total block area (clamped to
  [max-block+300, A4]), instead of always spreading along a full A4 row.
- **I007 — real-chip pinouts must not be invented** (user constraint): a
  multi-pin inline symbol whose value looks like an MPN or whose pins carry
  GPIO-style names fails the build unless the part declares `pinoutSource`
  (datasheet URL / 官方库出处 verified by the author) or uses an `ic` entry.
  Generic stand-ins declare what they are (`"pinoutSource": "通用示例符号…"`);
  mcu-min and rs485 recipes annotated.
- **Intake cache keys now include a recipe-content fingerprint** — an edited
  recipe (like the new pinoutSource fields) invalidates stale cached resolves
  instead of silently serving the old design.

### Fixed
- `lint` L007 (part outside the drawing frame) now reads each sheet's frame
  size from its embedded frame device doc instead of a hardcoded A4 — the
  check tracks the auto-sized frames.

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21 (the sensor-board case passes again via the cache fix).
- Probes: blink frame auto-fits to 79×80 units with no TABLE record; the
  62-part probe stays lint 100; I007 verified firing on an un-annotated
  10-pin stand-in and silent with `pinoutSource` declared.

## [1.19.0] - 2026-10-28

Fifth round, from the user's report: 「单页原理图分散太厉害、每个模块平铺摆放、
导线不避让弯绕」— schematic drawing quality, part two.

### Fixed
- **Compact layout** (`layoutSchematic`): the grid ran on fixed 260×200 cells
  with 70 mil frame padding and 280 mil block gaps — small parts sat alone in
  big cells and neighbouring blocks kept 420 mil of air. Now the pitch is
  derived from each part's real extent (120 mil floor), frames pad 36, block
  gaps 150/130. A 2-part block shrank from ~700 to 290 mil wide.
- **Asymmetric extent columns**: a rotated symbol's extent box reaches
  BACKWARD past its origin (U2 rot 270 → 150 mil left); the column model now
  tracks backward/forward reach separately and shifts origins right, so
  rotated parts no longer overlap the previous column (L001).
- **Cross-net wire contacts eliminated at the source** — the report's 「不避
  让」 root cause, found while chasing E006 net-merges at tight density:
  facing stubs of different nets met at a shared endpoint (R1.1 stub left
  40 + D2.1 stub right 40 = exactly touching), power-flag stubs drove
  through foreign flag origins, and the 3-sample-point shared-key check
  missed unsampled T-touches. Fixes stack:
  - `sch-route` candidates are REJECTED on any contact with another net's
    committed segments (X, T, and collinear overlap — the client merges nets
    at any contact), falling back to stub+label;
  - label and power-flag stubs are ADAPTIVE (40 → 30 → 20 → 10, then a
    perpendicular jog): facing stubs can no longer meet;
  - a node already connected by an earlier edge of the same net is skipped
    (no duplicate stubs/jogs);
  - the netlist unions co-located pins (two pins snapped to one point
    connect, the client behaviour), so flag-on-pin remains electrically sound;
  - column/row corridors widened to 100 mil — the gap between facing stubs
    (40 + 40) plus clearance, killing the collision class at layout level.

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21 (lint/drc 100).
- Zero cross-net wire contacts on blink and the two-sheet probe (programmatic
  scan); the 57/62-part session probe builds lint 100 with the report's own
  floating-pin artifacts as the only findings.

## [1.18.0] - 2026-10-28

Fourth round: the schematic drawing quality pass — an orientation optimizer
that turns symbols onto their signal axes, a crossing-avoiding router, and
functional pin grouping for generated symbols — plus the report's one-shot
workflow tools and the frozen common-parts base library.

### Added
- **`sch-tidy` orientation optimizer** (`lib/sch-tidy.js`, two-pass in
  `build.js`): after the first layout pass, every symbol's rotation is chosen
  from the net geometry — 2-pin parts turn onto their connection axis
  (vertical partners → vertical resistor), ICs rotate toward their partner
  mass (objective: total Manhattan distance from each pin hotspot to its
  net-partner centroid, minimized over 0/90/180/270). The AI supplies rough
  positions; the algorithm finishes orientation. Explicit
  `parts[].rotation` is respected; `--no-tidy` skips the pass.
- **Crossing-avoiding router**: candidate routes are now penalized for X
  intersections with other nets' committed segments (points were already
  covered; crossings were the visual "弯绕" killer), and the candidate set
  gains Z-paths through mid channels instead of only hugging endpoint rows.
- **Functional pin grouping for generated symbols** (`autoPinLayout`): when
  pin specs carry directions, inputs group top-left, outputs top-right,
  bidirectionals under the outputs, passives under the inputs, and power
  lands at the bottom of the shorter column — the human arrangement, in the
  same 2-column format. No hints → the old alternating behaviour, unchanged.
- **`floorplan.js`** (report P0-2): preview the PCB placement map (fitted
  board + every `[x, y, angle]`) without building; `--write` pins the map
  into `pcb.place` so the AI can tweak coordinates before building.
- **`make-board.js`** (report P0-3): one-shot workflow — build (all gates +
  netcheck) → SVG previews → `build.json` digest (`ok / scores / rats /
  previews / actions[]` with code+fix). The AI writes one design file and
  reads one report.
- **Base library frozen at the common parts**: 9 zero-reference / unverified
  presets removed (`A3` `A4` `AGND` `PGND` `DIFF_PAIR` `SHORT`
  `OFFPAGE_IN/OUT/BI`). Policy in SKILL.md: the base set does not grow — new
  device types arrive as evidence-cited IC entries or on-demand inline
  generation.

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21. Probes: blink rotates D2 vertical (its axis), the 62-part
  session probe rotates 18 parts with lint 100; pin grouping verified
  (VIN bottom, EN/FB above, OUT top-right); floorplan/make-board round-trip.

## [1.17.0] - 2026-10-28

Third round, driven by the real 57-part STM32 session report
(`D:\下载\ne555-eprj3\SKILL-WORKFLOW-REPORT.md`): the two PCB-placer bugs that
blew the board up to 347×247 mm are fixed with regressions, multi-sheet
schematics and block descriptions answer the 单页/多页 intake question, and the
schematic↔PCB netlist check is an explicit workflow step.

### Fixed
- **`pcb-plan` board blow-up (S1/S2, report P0-1).** Explicit `pcb.place`
  extents were translated twice (once at resolve, once in the final required
  pass → 3540 declared became 6850/13666 mil), and the grid wrap kept the
  PRE-wrap cursor for `right`/`neededW`, cascading every later part onto one
  row then one column. Both fixed; probe (62 parts, 6 double-row headers,
  explicit place, declared 3540×2360) now stays at **3540×2618** with lint 100.
- **Connectors wrap into further edge rows** when the declared board is too
  narrow (S3), and **slide past explicit footprints** already sitting in the
  band instead of stacking on them (the report's USB-C-at-board-edge
  conflict).
- **L004 judged the whole part extent** — since 1.16.0 wires attach at the
  hotspot inside that extent; the rule now tests the symbol BODY rectangle.

### Added
- **`netcheck.js` — schematic ↔ PCB netlist comparison, in the workflow**
  (user request): `build.js` runs it after every build (verdict line +
  `report.netcheck`), and `node scripts/netcheck.js --dir <p> [--json]` re-runs
  it standalone (exit 1 on mismatch) — including after hand edits in the
  client. Codes PAD_NET / NET_MISMATCH / NO_PAD / EXTRA_PAD / NO_FOOTPRINT /
  NO_SYMBOL / PAD_NO_NET / PIN_FLOATING, each with a fix line
  (`docs/checks.md`).
- **Multi-sheet schematics + the 单页/多页 intake question.** `sheets: N`
  fills N sheets in declaration order; `blocks[].sheet` overrides; the intake
  asks (default 单页). Cross-sheet nets become stubs + net ports
  (`PORT_<NET>` per sheet), merged by name globally; ERC exempts cross-sheet
  nets from the per-sheet single-pin rule. Probe: 2 sheets, LED_NET joins
  U1.3 (P1) ↔ R1.1 (P2), ERC 0 errors.
- **Block functional descriptions**: `blocks[].desc` renders under the block
  title and shows in `--plan` (模块 POWER（3V3 LDO 电源）@P1 …). The intake/AI
  asks for one per module.
- **`--plan` prints the rehearsed board** (S7): 板框（演练） W×H with a ⚠ when
  it exceeds the declared size by 1.5× — the plan gate can no longer hide a
  board blow-up.
- **Rebuild-loop guidance** (S8): SKILL.md now tells agents to iterate with
  `--quiet --report build.json` instead of re-reading verbose output.
- **Regressions (S10)**: pipeline grows 56 checks (+9) — 57-part probe asserts
  the board stays at its declared size, netcheck matches with explicit
  places, and the CLI exits 1 on a tampered pad net.

### Deferred (report P0-2/3/4, P1-6/7 — next rounds)
`floorplan.js`/`make-board.js` one-shot workflow, pin planner, board-level
recipes, CH340C/LM386/USB-C-16P library entries (each needs an official-library
sample per the evidence policy).

### Verified
- smoke 135/135 · pipeline 56/56 · dfm 95/95 · corpus 110/110 · depcheck 0 ·
  eval 21/21 (lint/drc 100). Multi-sheet probe and 57-part probe build clean;
  blink example byte-identical under EPRJ3_DETERMINISTIC.

## [1.16.0] - 2026-10-28

**Pin-attachment semantics fixed — the report that started it: "生成的原理图导
线没有连在引脚上".** The generator, the netlist and the lint all shared one
wrong assumption about what a PIN record's `(x, y)` means, so their internal
consistency (ERC E003 green) proved nothing about the client.

### Fixed
- **`geom.pinTip` treated `(x, y)` as the pin's INNER end and placed the
  connection point one pin-length outward** (`(x,y) − len·dir`). Ground truth
  from the committed client-authored sample: **every human-drawn wire endpoint
  lands exactly on the record point** — `(x, y)` IS the connection point (the
  client's hotspot); the drawn pin line runs inward from it along `+rotation`.
  Generated wires therefore floated 10 mil beside every pin in the client,
  while ERC/L010 — sharing the same wrong math — stayed green. All consumers
  (netlist, lint, route, parts, pins) go through `pinTip`, so one fix corrects
  the chain; `render.js` now draws the pin line hotspot→inward.
- **The corpus mis-diagnosis is resolved.** "the committed client sample has
  unconnected pins by design" was this bug's symptom: our reader saw 12 of its
  16 pins as unconnected. After the fix it reads fully connected, and
  `test/corpus.js` now asserts it (2 new checks, 110 total) — hotspot
  semantics can never drift silently again.
- **L004 (wire crosses body) now judges the symbol BODY rectangle** (PART
  BBOX), not the whole part extent: with wires attaching at the hotspot —
  inside the extent by definition — extent-based sampling flagged every
  legitimate stub.
- Docs: workflow.md/build.md connection-point claims corrected
  (`±30` → the record point `±20`; `IND ±17` was the same bug's artifact).

### Verified
- smoke 135/135 · pipeline 47/47 · dfm 95/95 · corpus 110/110 (new attachment
  anchor) · depcheck 0 · eval 21/21 (lint/drc 100 across cases).
- Probes: client sample reads 0 unconnected pins on both sheets; a fresh blink
  build places every wire endpoint on a pin hotspot or a wire/label junction;
  EPRJ3_DETERMINISTIC rebuild of the committed example updated.

## [1.15.1] - 2026-10-28

Docs contract fix: the official-library API URL read like a runtime instruction
("最高优先" in the evidence table), which could lead the agent to query the
network during normal skill use. The skill is **offline at runtime** — fetching
is a maintainer-curation action only.

### Changed
- `docs/footprint-evidence.md`: opens with a runtime-boundary statement (the
  table cites where committed numbers came from; it is not a fetch instruction);
  the curation workflow moved out of this doc.
- `docs/development.md`: new "库数据维护（需联网，仅限维护会话）" section — the
  fetch workflow, record format, direction naming rule and the list of already
  curated LCSC samples live there, behind an explicit runtime-offline banner.
- `SKILL.md` (Library tiers) and `docs/build.md` (IC entries) state that the
  library is committed data with **no live library lookup**; if no entry fits,
  the agent hand-writes an inline symbol instead of fetching.
- `design.js` unknown-IC error now says the runtime is offline and points
  maintainers at the curation process.
- Version labels `1.15.0 → 1.15.1`.

## [1.15.0] - 2026-10-28

Second review round: every auto footprint family was re-calibrated against the
**EasyEDA 官方库** (fetched per part from
`easyeda.com/api/products/{LCSC}/components`), and real ICs can now be
referenced from an **evidence-sourced pinout library** instead of being
hand-typed from model memory.

### Fixed
- **SOIC/SOP pads had swapped axes.** The SOP family (and rs485's hand-written
  SOIC_8P) emitted 24-wide × 55-tall pads — radial 0.6 mm, tangential 1.4 mm at
  a 1.27 mm pitch, i.e. adjacent pads overlapping and the long axis along the
  row instead of pointing outward. Now 76.8×22.4 (1.95×0.56 mm) at ±106.5 per
  the official LM358DR2G footprint (C7950).
- **SOT-23 pin pitch was wrong by 2×.** The family spaced pads 1/2 at 0.95 mm —
  the official package is P1.90 (two same-side leads 1.9 mm apart). Now
  39.4×25.6 pads at ±39.4, y=±37.4 per official MMBT5551 (C2145).
- **TSSOP defaulted to the wrong pitch standard**: 37 mil (0.95 mm) instead of
  25.6 (0.65 mm), with swapped pad axes. Now 58×16 at ±112.7 (IPC-7351B
  derivation; official sample still pending).
- **LQFP span undersized**: default ±143 → ±167.3 (official STM32F103C8T6
  footprint C8734). Larger bodies want an explicit `span` knob (documented).
- **QFN recalibrated** on the official MPU-6050 footprint (C24112): pads
  11×31.5 at ±78.7, bottom-row-left numbering per the official part.
- **SOT-223 pads undersized** (28×40 at y=-100, tab 60×100): now 43.3×98.4 at
  y=-116.9 with a 141.7×92.1 tab at +116.9 per official AMS1117-3.3 (C6186).
- **SOT-23-5/-6 right column was interleaved** (±18.5): the official TSOT-23-5
  (ME6211, C82942) aligns its two right-hand leads with rows 1 and 3 — now
  ±37.4, pads 45.6×19.3 at ±45.4.
- **SMA preset pads**: square 78.7×78.7 at ±86.6 → 98.4×70.9 at ±78.74
  (DO-214AC derivation).
- **dualRow/quad numbering conventions aligned with the official library**:
  dual rows now start top-left (official SOIC-8), quads start bottom-left
  counter-clockwise (official QFN-24); exact real parts ship verbatim official
  pads instead.
- **USB-C auto family now matches the official connector**: 6 merged power/CC
  pads (A1B12/A4B9/A5/B5/B4A9/B1A12) at the official TYPE-C-31-M-12 positions
  (C165948); usb-c-power recipe moved onto them.
- Large centred symbols (a 48-pin IC) stuck half above the drawing frame:
  `layoutSchematic` now anchors each part's extent top to its row top (L007
  stays as the backstop).

### Added
- **IC pinout library** (`templates/library/ic/`, design contract
  `"ic": "STM32F103C8T6"`): an evidence-cited symbol pin list
  (num:name:dir:side) plus footprint per part, so a real IC is referenced by
  name instead of the agent typing 48 pin definitions from memory — the
  highest hallucination-risk step of AI-authored schematics. Entries are
  curated data with mandatory `evidence` citations pointing at the
  official-library API and the datasheet, never generated. First two:
  STM32F103C8T6 (C8734, symbol + verbatim LQFP-48 pads) and AMS1117-3.3
  (C6186, symbol + official SOT-223 geometry); pin counts asserted in
  `test/dfm.js`.
- **Pin directions and the E008 output-conflict rule.** Inline/IC pin specs
  accept `"num:name:dir"` (+ optional `:L`/`:R` column hint; dir ∈ I O B P W T
  C). ERC `E008` fails a net driven by ≥2 outputs. Directions live in the
  design context only — the client's Pin Type enum is unverified beyond
  `IN`/`Undefined`, so no new values are written into records.
- Recipes declare `expect` (decoupling on mcu-min/ldo-3v3/usb-c-power; divider
  + decoupling on buck-5v) — the fifth gate now actually runs in eval.
- W002 decoupling heuristic widened (VDDA/VBAT/VBUS/VOUT/1V8/2V5/AVDD).

### Verified
- smoke 135/135 · pipeline 47/47 · dfm 95/95 (land-pattern contract re-asserted
  against official-library numbers) · corpus 108/108 · depcheck 0 · eval 21/21.
- New probes: STM32F103C8T6 minimum system builds placement-only via the IC
  entry (48 pins mapped/NC'd, lint 100, drc 100); a two-drivers-on-one-net
  design fails with E008; negative polarity/LED tests still fail correctly.

## [1.14.0] - 2026-10-27

The senior-engineer review pass (see `tmp/analysis-*.md`): the gates were all
green, yet the deliverable hid real engineering errors the gates cannot see —
a physically unmountable SOT-23 land pattern, a polarity gate that never ran,
and recipes that avoided polarity marks because the original I001 rule
false-positived on the TVS/flyback diodes they correctly contain. This release
fixes the deliverable's engineering content, not just its plumbing.

### Fixed
- **SOT-23 family land patterns were unmountable.** `auto SOT23/SOT23-5/SOT23-6`
  put pad rows at ±30 mil (1.52 mm span) — SOT-23 leads span 2.1–2.5 mm and
  TSOT-23-5/-6 span 2.8 mm. Pads now sit at ±47 (SOT23) / ±55 (SOT23-5/-6),
  per JEDEC MO-178 / IPC-7351B; the hand-written inline footprints in
  `ldo-3v3` and `mosfet-switch` moved with them. Nothing in the pipeline could
  see this (D001 ignores intra-footprint spacing), so
  [docs/footprint-evidence.md](docs/footprint-evidence.md) now records every
  family's dimensions with their external source, and `test/dfm.js` asserts the
  key numbers (land-pattern contract section).
- **The polarity gate (I001) never ran.** `build.js` skipped the intent gate
  unless an `expect` block existed, contradicting docs ("polarity marks are
  checked even without an `expect` block") — and no shipped recipe or example
  carried a single polarity mark, so the flagship check had zero coverage.
  `build.js` now runs intent when any part declares `polarity`, and every
  LED/diode in the recipes is marked.
- **I001's rule was wrong for shunt diodes** — which is *why* the recipes never
  marked polarity: a TVS's anode on ground / a flyback's cathode on its rail
  are correct, but the old rule flagged both as reversals. New semantics: only
  `+` on a ground net is a reversal, exempt when the part declares the new
  `role: "shunt"` field (all three TVS recipes do). Cathode-on-ground and
  rails-to-rails orientations are not judged (undecidable from nets alone).
  Negative test: a reversed LED still fails the build with I001.
- **DIODE/LED preset pin conventions contradicted each other.** DIODE was
  pin 1 = K with designator `U?`; LED was pin 1 = A with `D?`. Both now follow
  pin 1 = A / 2 = K (通用约定) with designator `D?`; the DIODE symbol
  artwork is mirrored to match, and the recipes' pins maps were flipped
  accordingly. `power-tree`'s TVS was in fact wired backwards under the old
  convention — the flip fixes it.
- **The LED symbol was a bare rectangle** (indistinguishable from a resistor,
  polarity unreadable). It now carries the diode triangle + cathode bar +
  emission arrows, same record shapes as the captured DIODE preset.
- **0402 preset pads were 0603-sized** (31.5×35.4 mil). Now 23×25 mil at ±19 —
  IPC-7351B nominal for 1005M. `R0603` was already correct.
- **Inline footprints lost their pad dimensions.** `buildInlineFootprintEntry`
  passed pads as `{w,h}` while `buildFootprintDoc` read `width/height` — every
  inline/auto footprint's PAD record omitted dimensions, so the DRC and any
  consumer silently fell back to 20 mil pads. `buildFootprintDoc` now accepts
  both spellings.
- **`pcb.place` parts could stick past the board outline**: `required` was
  computed with a flat `x + EDGE` heuristic that ignored part extents. The
  required size now comes from every placed part's real extent box.
- DRC `edgeClearance` default documented as 20 mil in build.md, 12 in checks.md
  and in code — build.md corrected to 12.
- SKILL.md's "real land-pattern numbers" example cited 0402 spans as "0603".
- `sch-route.js`: several pins sharing the `NC` net are no longer MST-wired
  together (that shorted every no-connected pin); each gets stub + NC label.

### Changed
- **PCB placement has three engineering refinements** (`pcb-plan.js`): `J…`
  connectors line the bottom board edge (single-line pad footprints rotated
  parallel to the edge, two-column ones keep the plug axis across it);
  decoupling caps are pulled next to their IC; gaps scale with part size
  (140–260 mil) instead of one fixed 260 stride. An undeclared board now
  **auto-fits** the parts instead of defaulting to 1600×1000 mil (declared
  boards stay a floor). The fit loop iterates to a fixed point, and the wrap
  test no longer mixes part origins with extent boxes (it wrapped one part too
  many).
- **Schematic blocks wrap onto new rows** instead of marching off the A4 frame
  on larger designs (`layoutSchematic`; L007 stays as the backstop).
- **Inline symbol pitch is automatic**: 30 mil for 3+ pins (10 for 1–2) in both
  `buildInlineSymbolEntry` and `generate-symbol.js` — the old 10 mil default
  stacked stubs, and the workaround lived in prompts instead of code.
- `USB_C` auto family renamed honest: 10 pads (`pins: 10`), documented as
  power-only; DP/DM/SBU need a hand-written inline footprint.
- `lib/route.js` renamed **`lib/sch-route.js`** — it wires the schematic; the
  name kept colliding with the PCB routing the skill deliberately does not do.
- **Previews show real symbol artwork** (diode triangle, LED arrows, cap
  plates) instead of anonymous boxes, and `render.js` now also renders each
  PCB: board outline, pads (with drills), refdes and the rats — the
  placement-only deliverable can be sanity-checked without the client.
- New recipe `mounting-holes` (4× M3, auto-fit board demo); eval grows to 21
  cases.
- Docs: build.md (pitch automatic, USB_C power-only, placement refinements,
  `role` field, board auto-fit), checks.md (I001 semantics), workflow.md,
  SKILL.md (evidence links, pitch, recipe count), new
  [docs/footprint-evidence.md](docs/footprint-evidence.md).
- Housekeeping: `.gitignore` excludes `/tmp/`; comment mojibake (`-?` → em
  dash) normalised in `lib/netlist.js`; `eval/history.jsonl` carries the
  1.14.0 run records.

### Verified
- smoke 135/135 · pipeline 47/47 · dfm 86/86 (16 new land-pattern/symbol
  contract assertions) · corpus 108/108 · depcheck 0 violations ·
  eval 21/21 (avg lint 100, avg drc 100, placed-only).
- Negative probes: reversed LED fails I001; reversed TVS (cathode on ground)
  fails I001 even as `role: "shunt"`; mounting-holes auto-fits a 1420×460 mil
  board with drc 100; mcu-min places J-connectors on the bottom edge and C1
  next to U1.

## [1.13.1] - 2026-10-27

Scope statement (docs only): **the skill generates the `.eprj3` project — and
nothing else.** Manufacturing artifacts were ruled out of scope by the
maintainer: BOM, pick-and-place / coordinate files and Gerber/production
archives are exported by the EasyEDA client, not by this skill. Written into
the places an agent reads before acting, so no future "helpful" export script
creeps in.

### Changed
- `SKILL.md`: front-matter description now lists manufacturing exports alongside
  routing/pour as out of scope; a new Known-limitations bullet states the
  deliverable boundary ("Do not add export commands to this skill").
- `README.md` (EN intro + ZH 引言): boundary sentence in both language sections.
- Version labels `1.13.0 → 1.13.1` (package.json, README). No code or behavior
  changed; suite status is the 1.13.0 green run (smoke 135 · pipeline 47 ·
  dfm 70 · corpus 108 · eval 20/20 · depcheck clean).

## [1.13.0] - 2026-10-27

The scope release: **the skill no longer touches copper at all.** Since 1.11 routing and pour were opt-in; opt-ins turned out to be surface the agent could still reach for. Since 1.13 they are gone — the deliverable is schematic + netlist + PCB **placement** (+ pad-net binding + outline), and every copper decision belongs to a human in the EasyEDA client. The boundary is now enforced structurally: the flags do not exist, so nothing can lay tracks or pours even by accident.

### Removed
- `build.js --route / --pour / --no-route / --no-pour` — passing them now fails with `Unknown option` (the parser, not a warning, is the guard; smoke and pipeline assert this).
- The capability itself: `scripts/lib/pcb-route.js` (2-layer A\* maze router) and `scripts/lib/pour.js` (pour planner + stitching fence), plus the CLIs `add-track.js`, `add-via.js`, `add-pour.js`, `add-fill.js`, `pour-auto.js` and their `package.json` entries. `add-region.js` stays — keep-outs are not copper.
- `intake`: the `output.pour` field (FIELDS + template), the pour derivation, and the dense-board fine-rule pre-arm (rules were armed for a router that no longer exists; `pcb.rules` remains purely a DRC contract).
- `eval`: the `copper` case flag and `--routed` plumbing; `cases.json` keys updated. `test/pipeline.js`: the opt-in copper build section. `test/smoke.js`: the tracks/via/pour/fill/pour-auto primitive sections.
- Dead `README_en.md` links in README.md (the file was removed by the maintainer; the bilingual README carries English first).

### Added
- **The rats handoff.** `build.js` now prints `rats: K net(s) to connect by hand in the client — GND(32p) VBUS(8p) …` (nets with ≥2 pads, NC/DNC excluded) and the report carries `pcb: {parts, mode:'placed-only', rats}`; the `--plan` and summary lines state the policy (`只布局（布线/铺铜在客户端完成）`, `drc 100/100 (placed-only)`). Placement-only is now a structural fact, not a mode: the build passes `placedOnly: true` to the DRC unconditionally.
- **corpus `copper_prep`** — since the builder makes no copper, copper-tampering variants inject their own witness copper first (tracks chained pad-center to pad-center from the CURRENT placement, or a well-formed POUR, tickets beyond the file max). D001/D004/D006 and the POUR shape rules stay under regression without the skill ever emitting copper: `pcb-net-left-unrouted`, `pcb-track-net-retagged`, `pcb-padnet-against-schematic` (prep + retag), `pour-flat-path`, `pour-undeclared-net` (prep + tamper) all caught, all non-vacuous.
- Policy-guard tests in smoke/pipeline: `--route` and `--pour` must exit non-zero with `Unknown option`.
- DRC fix hints for D004/D006 now point at the client (this board's copper was never promised; imported boards with tracks/pours still get the full copper judgment — unchanged and tested by the corpus witnesses).

### Changed
- The whole documentation surface rewritten for the new scope: SKILL.md (front matter, strategy, fast path, design-table — `pcb.pour/route` marked removed, widths re-labelled as handoff annotations), README.md (EN+ZH), docs/build.md (the two copper sections replaced by one "Copper policy (out of scope since 1.13)"), docs/checks.md, docs/intake.md (confirmation gate #7 = "copper is out of scope"), docs/workflow.md, docs/development.md, docs/format-reference.md (POUR/LINE/VIA/FILL are read-and-judge-only for the skill now), docs/corpus.md (witness mechanism).
- `design.js` warns about very wide nets as handoff notes, not pour advice; intake's plan line reads 只布局（布线/铺铜在客户端完成）.

### Verified
- smoke 135/135 · pipeline 47/47 · dfm 70/70 · corpus 108/108 (44 caught, 2 recorded gaps: `schematic-wire-segment-dropped`, `ticket-regression` by design) · depcheck 60 files / 0 violations · eval 20/20 cases (avg lint 100, avg drc 100, placed-only).
- intake e2e: `sensor-board` (33 parts) resolves, plans, builds placement-only with drc 100 and a 20-net rats list.
- `EPRJ3_DETERMINISTIC=1` golden still byte-identical across dirs and `--force` rebuild.
- Real client-saved V4 projects (quick-start 4.1.78, H610) keep validating at 0 errors — the removal changed nothing about read compatibility.

## [1.12.1] - 2026-10-27

Ground truth arrived: `examples/blink` and `examples/eprj3-example`
were opened and **re-saved in the real client (4.1.84)** (user commit
`77e2680`). The gates accept both round-tripped samples (validate 0 errors —
the aggregated foreign-client warnings are the point, not a problem), and the
save's byte diff taught the writer side three facts now documented in
`docs/format-reference.md` ("Client round-trip facts").

### Fixed
- `test/smoke.js`: the `examples/blink` assertion demanded *zero warnings* —
  correct for skill-built files, wrong for a client round-trip (the save
  stamps fresh `version`/`updateTime` on the docs it touches, and may re-key
  their `client` to the editing installation's id, while untouched embedded
  docs keep their original hash). Now asserts **0 errors** with the aggregated
  foreign-client warnings tolerated — exactly the state V003 was designed to
  describe.

### Changed
- `docs/format-reference.md`: new "Client round-trip facts" block — per-doc
  client drift as the normal state, DOCHEAD tickets rewritten to arbitrary
  document clocks (observed 634; the `ticket: 1` seed is legal), `editVersion`
  left alone. (An earlier draft of this note blamed the client for deleting the
  sample's README files — that deletion was manual maintenance, not save
  behaviour.)

## [1.12.0] - 2026-10-25

Closes issue #2 — and the calibration turned into a full **V4 format
alignment**. Two real client-saved projects on disk (the official quick-start
written by client 4.1.78, and the H610 mainboard sample) became the ground
truth; every format assumption was measured, not remembered. Result:
`validate.js` reports **0 errors on both real V4 projects** (it used to crash
or false-reject them in six different ways), generated projects write the V4
shape, and two rules that no real file obeys were deleted rather than
softened. Note: the client ships no headless save CLI (the bundled `pro-api`
cli.js is an API-docs browser) — "re-save the cases" became "calibrate on the
real client files already here + regenerate `examples/blink` with the V4
writer".

### Added
- **V4 write shape** — `writeLines` normalises every DOCHEAD frame to
  `{"type":"DOCHEAD","ticket":1}` (single chokepoint: init, add-*, build and
  all embed paths go through it); `buildEcfgDoc` now writes DOCHEAD+META only
  (2 records — the RULE pair is V3 residue), matching what 4.1.78 saves.
- **V4 read compatibility** — DOCHEAD detected semantically via
  `E.isDocHeadLine` (parsed head type) at every boundary site
  (`checks.docsOf`, `netlist.readSheet`, `drc.docSplit`, `eprj3`'s
  insert/last-head/ensure-nets scans, corpus/smoke helpers): ticketed heads,
  bare heads, and mixed files all parse. This is the issue #2 fix; the
  synthetic repro from the report now recognizes its documents, and real
  4.1.71+ saves read cleanly through all five gates.
- **Format rules calibrated to measured V4** (`scripts/lib/checks.js`):
  doc uuids accept 16- and 32-hex (client-created SCH/PCB/page docs use 32;
  embedded library docs 16); `.ecfg` accepts 2 (V4) or 4 (V3) records — the
  "want 4 records" error becomes "want 2 or 4"; `index.profile`'s
  `blockSymbols/simSchematics/simulations` are optional (H610-era indexes
  lack them); `profile.owner.uuid` accepts the offline path form (warns);
  `ATTR.parentId` resolves across the whole container file (H610 footprint
  metadata references sibling-doc element ids) and the instance-path form
  `eNNNN(-ie)NNN…` is exempt (NO_CONNECT pin flags — 794 false errors on
  H610 before this was measured); foreign `DOCHEAD.client` collapses to one
  aggregated warning per file (H610 has 2007 such docs).

### Removed
- **Ticket-order check (V002)** — real saves break it by the hundred (813
  backwards tickets in the official quick-start sheet); record tickets are
  per-atom clocks, not an ordering invariant.
- **"Tickets unique within a document" as such** — replaced by `(ticket, id)`
  **pair** uniqueness: every FONT row in a real file shares ticket 1 with
  different ids; only a copied/torn line repeats the pair (the corpus
  duplicate-ticket witness still fires).

### Changed
- `test/smoke.js`/`test/corpus.js` helpers treat DOCHEAD as document framing,
  not a record row (its ticket clock overlaps record clocks in V4); new
  assertions pin the V4 output shapes (ticketed head line, 2-record ecfg).
- corpus: `ticket-regression` became a by-design `leak` entry (documents why
  nothing may reject it); `ecfg-fifth-record` expects the new 2-or-4 message.
- `examples/blink` regenerated through the V4 writer; `examples/eprj3-example`
  stays as the V3 witness — the validator reads both. The 1.10 "closed blind
  spots" table in docs/corpus.md was re-marked for the two deleted rules.
- Docs: format-reference grammar section rewritten for V4 (ticketed/bare heads,
  uuid shapes, pair-uniqueness, instance-path parentIds), checks.md format
  section, SKILL.md "V4 dialect" limitation, corpus.md gap tables.

### Fixed
- issue #2 end to end: the report's synthetic repro recognizes its document;
  a valid client-saved project cannot be misjudged as "no DOCHEAD records"
  anymore; embedded-library validation can no longer be silently skipped by
  a DOCHEAD shape the reader didn't know.

## [1.11.0] - 2026-10-24

The strategy release: **the skill now ships placement-only boards.** No copper
pour, no auto-routing in the deliverable — the PCB arrives with footprints
placed, pad↔net links bound and the board outline, ready for a human to
finish. Routing and pour become explicit opt-ins (`--route` / `--pour`) so a
generated project never contains copper the user did not ask for. Every gate,
test, benchmark and doc now speaks the new strategy, and the copper path stays
under regression rather than being deleted.

### Changed
- **`build.js` default = placement-only.** New opt-in flags `--route`
  (2-layer maze router) and `--pour` (ground plane + stitching fence, honoring
  the design's `pcb.pour` recipe). The old `--no-route` / `--no-pour` remain
  accepted as legacy no-ops. The build log and summary say `placement-only` /
  `(placed-only)`, and the report carries `pcb.mode`.
- **The DRC is mode-aware.** `D004` (net not fully routed) and `D006` (no
  ground pour) judge copper that was promised: skipped on placement deliverables,
  enforced on routed boards. `runDrc` gains `placedOnly` (explicit) + file
  auto-detect (no tracks → placed-only); results report `mode` and `skipped`.
  `drc.js` CLI gains `--placed-only` / `--routed`. Everything that applies to
  placement itself (pad spacing, board edge, outline, orphan pads, all DFM
  floors) always runs.
- **intake no longer writes a pour by default**: `output.pour` default becomes
  null (a declared net is a *recipe for `--pour`*, not an auto-pour); the plan
  line reads "只布局（默认不布线/不铺铜）"; dense-board fine rules are still
  pre-armed but inert until `--route`.
- **Regression coverage follows the strategy, it does not shrink.** eval
  gained `copper: true` cases (`eval/cases.json` — `examples/blink`,
  `recipe/ldo-3v3`) so the router+pour path is built and judged in routed mode
  inside the 20/20 benchmark; `test/pipeline.js` asserts BOTH the default
  placed-only deliverable (`mode === 'placed-only'`, 0 tracks, 0 pours, footprints
  present) and a second `--route --pour` build (pours/vias/routed-mode);
  `test/corpus.js` baselines build with `--route --pour` so the copper
  tampering variants (unrouted net, retagged track) stay meaningful;
  `test/dfm.js` probes a real routed board for the via floors.
- Docs rewritten for the strategy: `SKILL.md` (front matter, intro, fast path,
  design.json table `pcb.route/pcb.pour`, copper gate row, known limits),
  `README.md` + `README_en.md` (placement-first framing, report line),
  `docs/build.md` (options, pcb table, router section = opt-in),
  `docs/checks.md` (placement-only mode paragraph),
  `docs/intake.md` (pour default, confirmation gate #7 "要不要铜皮", dense-rules
  pre-armed wording), `docs/development.md` (script table, manual flow step 6,
  decision table).

### Fixed
- `eval/cases.json` per-case overrides never applied: the keys were written as
  `examples/designs/blink` while eval names cases `examples/blink`. Keys
  corrected (and documented in `_comment`); blink/inline-spec now genuinely
  enforce their 100-point floors.

## [1.10.0] - 2026-10-24

The intake release: the skill now starts from a *feature request*, not a design
file. A fixed requirement schema with a one-pass clarification protocol turns
"做一个传感器板" into a confirmed plan and then a buildable design — power tree
chained by derivation instead of guessing, dense merged boards auto-sized to
fine rules, every human confirmation point made visible before anything is
written. Zero third-party dependencies — added `depcheck.js`, which proves that
claim by reading the code.

### Added
- **Requirement intake (`scripts/intake.js`, `scripts/lib/intake.js`,
  `docs/intake.md`)** — `template`/`fields`/`check`/`resolve`. Fields are tiered:
  *required* (check exits 1 with the exact zh questions), *ask* (one question,
  carries its fallback default), *default* (applied silently, reported for
  veto). Ask everything at once — serial追问 is a round-trip tax on the user.
- **Keyword→recipe selection table** — 15 FEATURES covering usb/buck/ldo/mcu/
  crystal/i2c/uart/rs485/mosfet/divider/rc/led/button/power-tree, merged in
  signal-flow order with de-duplicating id suffixes.
- **Power-chain derivation** — a regulator's `VIN` lands on the nearest net
  *above* its own output (12V→buck→5V→ldo→3V3 chains correctly; the LDO is no
  longer hung off the raw bus). Rail width follows declared current
  (16/20/30/40 mil at 0.5/1/2 A). Linear-regulator drop >6 V @ ≥150 mA prints a
  heat estimate and suggests a buck — it never silently changes the BOM.
- **Dense-board rules auto-applied** — merged boards (≥2 recipes or ≥12 parts)
  get `clearance 6, trackWidth 6, grid 5, edgeClearance 12`: at default 10 mil
  the pad keep-outs overlap and the router has no legal channel (measured, not
  assumed — 33-part merged designs go 0-DRC-error with this, failed without).
- **`build.js --plan` — the confirmation gate.** Real stats (it really builds,
  into a throwaway dir that is deleted on exit), zero writes to the target:
  板框/电源/线宽/规则/模块/网络/意图 printed from the validated design.
- **`autofix.js --diff` — write nothing, show the line diff.** Self-contained
  LCS diff, normalized both sides so indentation noise does not hide the real
  change. The apply path still exits 1 like before.
- **`scripts/depcheck.js`** — scans every `.js` for require/import specifiers
  (comment state machine included), classifies builtin/self/external/escaping,
  checks `package.json` dependency fields and a stray `node_modules/`. Exit 1
  on any violation. `npm run depcheck`.
- **Selection cache (`scripts/lib/cache.js`, `.cache/intake.json`, gitignored)**
  — requirement+params+netmap → resolved recipe, keyed by sha256. A repeated
  resolve is one file read; deleting `.cache/` changes speed, never output.
- **eval now measures the cost metrics too**: `~Ntok` per case (bytes/4 of the
  design the AI must author) and a run total (`total 7.6s, ~11991tok authored`)
  written into `history.jsonl`, so "faster / fewer tokens" is a diff, not an
  opinion. Gate averages now exclude cases without scores instead of counting
  them as 0.
- **eval grew intake cases** (`intake/sensor-board`, `intake/psu`,
  `intake/partial`): complete requirements are resolved through the real
  intake path into `eval/.intake/*.design.json` (gitignored) and built + scored
  like any other case — the whole feature→design→project chain is now under
  regression. `intake/partial` (missing `power.input`) asserts the opposite:
  the 追问 protocol must name the missing required field or the case fails.
  20/20 cases.
- **`drc.js --design <design.json>`** — the copper gate judges the board under
  the design's own `pcb.rules` contract (clearance/trackWidth/edge/minDrill/
  minRing/minAngle + pour net + per-net widths), the same way `build.js` does.
  Without it a board that legitimately declared fine-pitch rules was
  misjudged by the DRC defaults (found by `intake/sensor-board`: lint 100,
  drc 0 standalone vs drc 100 in-build — the gates now agree).
- **UTF-8 BOM tolerance everywhere a human file is read** (design.json,
  requirement.json, library entries, project index) — Notepad/VS Code "UTF-8
  with BOM" no longer breaks `JSON.parse`.
- Shared recipe-merge engine `scripts/lib/merge.js` (`recipe.js` refactored onto
  it; identity net-renames no longer drop the `powers` entry).
- **Intake example requirements**: `examples/intake/sensor-board.req.json`,
  `examples/intake/psu.req.json`.
- **DFM rules in the copper gate** (`scripts/lib/drc.js`, D009–D012): minimum
  drill (`minDrill` 12 mil = 0.30 mm JLC basic floor, error), minimum annular
  ring (`minRing` 4 mil, warn), silkscreen-on-pad (`D011`, warn, layer-aware
  top/bottom silk vs pad metal), acute track angle (`minAngle` 45°, warn — only
  same-net same-layer segments that SHARE an endpoint; 0° folds are router stubs
  and stay with the spacing rules). All three thresholds are overridable from
  `design.json pcb.rules` and are forwarded by `build.js`. `test/dfm.js`
  (70 assertions) covers trigger/non-trigger/boundary per rule; every eval
  case still scores drc 100 — the thresholds are conservative by measurement,
  not by hope.
- **Legal/illegal corpus** (`test/corpus.js`, `test/corpus/*.json`,
  `npm run test:corpus`): the real build chain produces the legal baseline,
  then 40+ single-tampering variants assert the gates report the expected code
  (validate/erc/lint/drc). Tamperings no checker catches are recorded as
  `expect:{leak:true}` blind spots — visible gaps, not silent ones; the run
  prints them and stays green. `--probe` re-observes real output for manifest
  maintenance. 104/104 checks, 6 blind spots registered.
- `npm test` now chains everything that guards quality: smoke + pipeline + dfm
  + corpus + depcheck.
- **Five format rules closed from the corpus blind-spot list**
  (`scripts/lib/checks.js`): corrupt record body after a stray `||`
  (*error* — the silent `{}` fallback used to make bodies vanish),
  `ATTR.parentId` must resolve in-document (*error*), `COMPONENT`/`WIRE` heads
  must carry an id (*error*), main-doc tickets in increasing file order
  (*warning* — real client SYMBOL docs are unordered by design, so the rule is
  scoped where it holds), and `DOCHEAD.client` ≡ project client (*warning* —
  genuine merged client projects legitimately differ). Error/warning levels are
  chosen empirically: both committed real-client examples pass every new
  error-level rule. Empty/truncated container files now report
  "no DOCHEAD records" and every reader (`checks`, `netlist`, `drc`, `pins`)
  degrades to findings instead of throwing. The corpus manifest moved those
  six items from `leak`/`crash` to real `expect`s: **109/109 checks, 45
  variants caught, 1 recorded gap** (`schematic-wire-segment-dropped`, blind
  by construction for connectivity reasoning).

### Changed
- **README.md is now bilingual with English first**: a complete English section
  (what makes it different, install, AI one-line prompt, the intake→confirm→
  build→gates pipeline, docs table) above the unchanged Chinese section;
  `README_en.md` mirrors the English content exactly as the standalone page.
  Cross-links go both ways, and the Chinese heading anchors stay intact for
  existing references.

### Fixed
- **Deterministic-id collision across steps** — `EPRJ3_DETERMINISTIC=1` used a
  constant counter seed, so two `node scripts/*.js` steps of one project handed
  out the same ids (`Symbol attr references missing SYMBOL doc`). The stream is
  now seeded from the invocation: path-like arguments are ignored (same design
  into two dirs = byte-identical), pure output/cleanup booleans are ignored
  (`--force` rebuild = byte-identical to the first build), and everything
  semantic — script, symbols, coordinates, net names — participates, so no two
  steps of one project collide. Verified both ways by hash; smoke is 141/141
  under the flag. `EPRJ3_DET_SALT` pins a stream across steps.
- `build.js` intent summary line printed array objects instead of counts.
- **`pcbGeometry` read VIA fields that do not exist** (`body.x/y/width/hole`) —
  every via silently fell back to the 24/12 default, so D008 and the new DFM
  rules saw fiction. The reader now takes the real record fields
  (`centerX/centerY/viaDiameter/holeDiameter`) and keeps the old names as a
  fallback; D008 now judges actual copper for imported projects too.
- `recipe.js apply` with an identity net rename (`--net X=X`) deleted the
  `powers` entry instead of keeping it (merge.js renameNets order fix).

## [1.9.0] - 2026-10-24

Correctness and closing-the-loop release: stitching vias stop landing on
foreign copper, power traces can be wider than signal traces, a fifth gate
catches design-intent mistakes (reverse polarity, missing decoupling), error
messages carry their own fix, mechanical fixes are automated, and builds can be
byte-reproducible. Zero dependencies added — everything below is self-contained Node.

### Added
- **Stitching-via obstacle avoidance** (`scripts/lib/pour.js`) — pour vias are
  planned against the actual copper (pads/tracks/vias of other nets); conflicting
  positions are nudged ±30 mil on the grid or dropped, and the build log reports
  moved/dropped counts. Previously a fence via could land straight on a pad.
- **Per-net track widths** — `nets: { "MOTOR_A": { "width": 30 } }` and
  `netClasses: { "POWER": { "width": 30 } }`. The router keeps pads clear of the
  widest trace on the board, reserves what it lays per net, and refuses to
  squeeze a wider-than-default trace through a pad gap. The DRC judges each net
  against its own declared floor.
- **Fifth gate: design intent** (`scripts/intent.js`, `scripts/lib/intent.js`) —
  `parts[].polarity` ("+" pin on ground → `I001`) plus an `expect` block:
  `decoupling` (every supply net gets a cap to ground, `I002`), `pairs`
  (differential pairs exist and are balanced, `I003`), `valueRange`
  (engineering-notation value bounds, `I004`), `divider` (wiring + ratio from
  parsed resistor values, `I005`). build.js runs it after ERC and fails on
  error; `--allow-intent` skips.
- **Every finding carries a `fix:` field** (ERC/ERC-CLI/lint/DRC, text and
  `--json`) — the concrete edit instead of a bare code.
- **`scripts/autofix.js`** — mechanical design-level fixes: unconnected pins →
  `NC`, dead-end nets → `NC`, missing decoupling caps added (100nF, C0402).
  `--check` reports without writing.
- **`NC`/`DNC` no-connect convention** — a lone pin on a net named `NC` passes
  ERC instead of failing `E002`.
- **Auto footprints** (`scripts/lib/fp-auto.js`) — `"footprint": { "auto":
  "LQFP48" }` generates real land patterns for SOT23/-5/-6, SOT223, SOP/SSOP/
  TSSOP, QFN/QFP/LQFP, DIP, HDR/HDR2R, SW_4P, XTAL, OSC, USB_C, with
  `pins`/`pitch`/`span`/`hole` knobs; compound names (`"SOP8"`) included.
  Calibrated against the hand-written values already shipped in the recipes.
- **Deterministic builds** — `EPRJ3_DETERMINISTIC=1` freezes ids and timestamps;
  two builds of one design.json are byte-identical (verified by hash), which
  makes golden-file fidelity regressions possible.
- **`eval.js --diff` / `--design`** — compare runs against history (`--diff
  [--since n]`) and measure a freshly generated design with the same yardstick
  (`--design file [--baseline case]`).
- **Decision tables for agents** — SKILL.md/development.md now answer the
  recurring questions (board size auto-grows, fine-pitch rules, supply widths,
  NC pins, autofix, auto footprints, intent).

### Fixed
- **Schematic exit directions** — `route.js` guessed each pin's exit direction
  from |dx| vs |dy|, which called a right-facing pin on a tall IC "vertical" and
  drove stubs back through the body (20+ `L004` on a 48-pin symbol). Directions
  now derive from the pin's own stub geometry + placement rotation.
- **Schematic block pitch** — row/column pitch adapts to real symbol extents
  (a 48-pin IC stretches its cell instead of overlapping the next row); small
  parts keep the default 260×200 grid bit-for-bit.
- **DRC ↔ router rule desync** — `build.js` judged copper with the DRC's
  built-in defaults even when the design declared its own `pcb.rules`; a
  fine-pitch board was guaranteed `D001`/`D002` noise. The DRC now receives the
  design's rules (and per-net widths).
- **Router soft-pass could overlap real copper** — the allowSoft fallback
  treated a track keep-out merged with a pad zone as a passable gap, producing
  0.0 mil track-to-track overlaps. Track/via reservations are now recorded
  separately and never passable; a soft pass only squeezes through pad
  clearance zones at the default width or below.
- **`evaluate` under sandboxed runners** — `test/smoke.js`, `test/pipeline.js`
  and `scripts/eval.js` now capture child output via a pipe-or-file fallback
  (`test/capture.js`) instead of failing with a bare `exit null`.
- Docs drift: README said 1.7.3 and described the pre-1.8 manual command chain;
  `docs/workflow.md` linked a removed SKILL.md anchor; block-size guidance said
  "3–10" in one file and "~2–3" in another. Unified (README → 1.9.0 declarative
  flow, anchor fixed, blocks → 2–8 everywhere).

## [1.8.0] - 2026-09-16

Engineering layer on top of the format layer: a declarative build pipeline, four
independent quality gates, PCB auto-layout/routing/pour, reusable recipes and a
benchmark. Zero dependencies added — everything below is self-contained Node.

### Added
- **`scripts/build.js`** — one design file in, one complete checked project out.
  Resolves library entries (preset, inline spec, or staged), auto-lays the
  schematic in signal-flow blocks, routes every net (straight → L/Z → trunk bus →
  stub+label, power nets as flags), annotates block frames, places footprints,
  routes the PCB (2-layer maze router with vias), pours copper on both layers with
  a stitching-via fence, then runs all four gates and fails on error.
  `--force`, `--dry-run`, `--schematic-only`, `--no-route`, `--no-pour`,
  `--report`, `--quiet`, `--keep-tmp`, `--allow-{erc,lint,drc}`.
- **`scripts/lib/design.js`** — design.json schema, defaults, structural
  validation and the block/grid layout engine (connectivity ordering inside blocks).
- **`scripts/lib/parts.js`** — library entry → electrical geometry (pin tips,
  pad centres, body boxes) and inline symbol/footprint synthesis.
- **`scripts/lib/geom.js`** — dependency-free planar geometry (pin-tip rotation,
  orthogonal pathing, rect/segment predicates) shared by every checker.
- **`scripts/lib/route.js`** — schematic auto-wiring with a shared-point registry
  so two nets can never touch.
- **`scripts/lib/netlist.js`** + **`scripts/netlist.js`** — recover the electrical
  truth from the files (union-find over wire endpoints, pin tips, T-junctions,
  labels and power flags) and print it, per sheet or per PCB.
- **`scripts/lib/erc.js`** + **`scripts/erc.js`** — electrical rules: unconnected
  pins, single-pin nets, duplicate designators, PCB↔schematic disagreement, and
  a **netlist diff against the design file** (E003), plus decoupling and naming
  warnings.
- **`scripts/lib/lint.js`** + **`scripts/lint-layout.js`** — geometric review:
  overlapping symbols, wires through bodies, parts outside their block, text on
  parts, off-grid origins, dangling ends; 0–100 score.
- **`scripts/lib/drc.js`** + **`scripts/drc.js`** — copper review: spacing, track
  width, board-edge clearance, unrouted nets, pour presence, via geometry.
- **`scripts/lib/pcb-route.js`** — grid A* router, two layers, bend/via costs,
  obstacle reservation per net; reports what it could not route.
- **`scripts/lib/pour.js`** — pour regions derived from the board outline plus a
  stitching-via fence and interior grid.
- **`scripts/lib/pcb-plan.js`** — footprint auto-placement following the
  schematic's block order, with explicit `pcb.place` override.
- **`scripts/lib/pins.js`** + **`scripts/pins.js`** — resolve `R1.2` to an exact
  tip and list every pin's coordinate, exit direction and net.
- **`scripts/add-wire.js --from/--to/--link`** — wire by pin reference; the script
  measures the pins and routes orthogonally. Hand-computing tips is no longer
  necessary (or recommended).
- **`scripts/lib/render.js`** + **`scripts/render.js`** — SVG preview of every
  sheet (bodies, pins, wires, blocks, flags) so the result can be looked at.
- **`scripts/lib/checks.js`** — `validate.js` core extracted to a reusable
  function; `validate.js` gains `--json`.
- **`scripts/eval.js`** + `eval/cases.json` — builds every recipe and example,
  scores all gates, appends to `eval/history.jsonl` for iteration tracking.
- **`test/pipeline.js`** — 40-check regression suite for the declarative path.
- `recipe/` — buildable reference designs for common sub-circuits.
- **`scripts/recipe.js`** — `list` / `show` / `apply` over `recipe/`. Recipes may
  declare `params` and use `${NAME}` placeholders; `apply` overrides params
  (`--set`), renames nets (`--net`), merges parts/blocks/powers into an existing
  design and de-duplicates colliding ids (`--suffix`, references included).
- **`scripts/pour-auto.js`** — pour from the `BOARD_OUTLINE` instead of by hand:
  one POUR per copper layer, stitching-via fence, interior grid, idempotent
  `--replace`, and `--dry-run`.
- `test/smoke.js` extended from 121 to 141 checks: the declarative build
  (build → validate → ERC → netlist → pins → pin-reference wiring → render →
  dry-run), `pour-auto --replace` leaving the DRC clean, and `recipe list/show/apply`.

### Changed
- `SKILL.md` restructured around the declarative fast path (20 KB → ~10 KB);
  record-level and manual-flow details moved to `docs/build.md`, `docs/checks.md`
  and the pre-existing `docs/workflow.md`, loaded only when needed.
- `writeLines` is now atomic (temp file + rename) so a crash cannot leave a
  half-written document.
- `Project.load` falls back to the single `.eprj3` file in the directory, so a
  project name no longer has to match its folder.
- `build.js` removes the `.tmp` staging area after a clean build (`--keep-tmp` opts out).
- `insertDocsBeforeMain` de-duplicates within one batch, not just against docs
  already in the file.

### Fixed
- Inline footprints were built against the old `buildFootprintDoc` return shape
  (array, not `{lines, pads, attrs}`), breaking every multi-pin device.
- An inline symbol and an inline footprint sharing a display name collided in the
  staging directory (lookup scans both subfolders by file name); inline entries
  are now staged as `SYM_*` / `FP_*`.
- Placing a `PORT_*` / power entry as a part crashed on `entry.symbolDoc`; the
  placement path now dispatches by entry kind.
- `validate.js --json` required a value for a boolean flag.
- DRC no longer flags pad-to-pad spacing inside a single footprint.
- Schematic router no longer accepts a candidate with an empty middle section
  (two disconnected stubs scored better than any real path, silently splitting
  every misaligned net); the netlist now registers every segment of a wire under
  its label, and a pin connects only where a wire ENDPOINT lands on its tip.

### Baseline

`node scripts/eval.js` on the shipped tree: **17/17 cases clean** — format, ERC,
layout 100/100 and DRC 100/100 for all 15 `recipe/` designs plus both examples
(`rs485` is the one case at layout 98, for a deliberate label placement).
Average lint/drc 100, every case builds in under 1.5 s.

Getting there required two design-level lessons, both now documented in
`docs/build.md`:

- **Do not copy a `pcb.rules` override between boards.** A stale
  `{"grid": 2, "trackWidth": 10, "clearance": 14}` block (injected by a bulk
  edit while authoring recipes) silently degraded several designs from DRC 100
  to 40–88; the router defaults are strictly better and the overrides are gone.
- **Keep schematic blocks to ~2–3 related parts, in declaration order.** When a
  net falls back to stub+label, a label-encoded net can merge with a neighbouring
  power-flag group; regrouping removed the last ERC short (`RS485_DI` merging
  into `RS485_A`).
- Inline symbols want an explicit `"pitch"` (30 mil is comfortable); the 10 mil
  default packs a 5-pin SOT-23 into 40 mil and makes neighbouring stubs collide.

Baselines are appended to `eval/history.jsonl`.

## [1.7.3] - 2026-09-15

### Changed
- Removed redundant `README_zh.md`; `README.md` already serves Chinese users, with `README_en.md` as the English fallback.
- Added bilingual top-links between `README.md` and `README_en.md`.

## [1.7.2] - 2026-09-15

### Changed
- Rewrote `README.md` from an ordinary user's perspective: one-line AI install prompt at the top, installation first, an 8-step quick-start plus a minimal command flow, and development/technical details moved to the bottom. Added `README_en.md` as the English fallback.

## [1.7.1] - 2026-09-12

### Added
- `CHANGELOG.md`: release history backfilled from 1.0.0 with a SemVer + bump-on-every-change convention (package.json aligned to the documented version).

## [1.7.0] - 2026-09-12

### Added
- SKILL.md section **"Schematic layout & wiring rules"**: module-block partitioning (coarse blocks, rect enclosure + title text required), signal-flow placement (inputs left/top → outputs right), 10 mil grid, pin-tip coordinate math (`tip = (px − L·cos r, py − L·sin r)` rotated CCW), and the wire-over-label encoding table. Anti-pattern banned: net labels fanned directly out of pins instead of visible wires.

### Fixed
- `add-netlabel.js`: labeling a wire drawn without `--net` failed ("has no NET attr") — it now creates the NET attr in the official named-wire shape (`e3c2cbe`).
- `set-refdes.js set`: was matching Designator attrs across the whole file, so it could rewrite the `R?` placeholders inside embedded SYMBOL docs; now scoped to the main document like `renumber`.
- `add-pcb-text.js`: the `--origin` anchor list in the header comment was inverted against the implementation (`EAlign`: 0 = LEFT_BOTTOM … 8 = RIGHT_TOP).
- `add-pcb-shape.js` / `add-fill.js` / `add-region.js`: `--x/--y` option descriptions still said "top-left" after the 1.5.0 bottom-left convention; corrected.
- Smoke suite extended: 121 checks (unlabeled-wire labeling, placeholder protection, PCB `set` rename).

## [1.6.0] - 2026-09-12

External review round (`c9fb48d`) — 7 of 9 reported issues confirmed and fixed; BOM export and ERC/DRC validation rejected as out of scope for this skill.

### Added
- `init.js --board-w/--board-h` to size the board outline in mil (default 4000×3000).
- `generate-footprint.js --pads` 6th field: drill diameter → through-hole pad (ROUND hole + ELLIPSE copper on MULTI layer, shape from the official example).
- `generate-symbol.js`: explicit per-pin coordinates (`num:name:x:y:rot`) now honored; `--pitch` configurable; symbol body rect derived from actual pin geometry.

### Changed
- `add-footprint.js --angle` default `90` → `0` (unrotated placement).
- `add-pour.js`: omitting `--name` now picks the next free `POURn` instead of duplicating `POUR1`.

### Fixed
- `audit-format.js`: whitelist `groupId` omission on SCH PIN/POLY — real-client elibu exports legitimately omit it.

## [1.5.0] - 2026-09-10

### Fixed
- PCB rectangle path anchor convention (`4e2c84a`): `["R",x,y,w,h]` covers x∈[x, x+w], y∈[y−h, y] — the anchor is the min-x/max-y corner with height extending toward −y. All rect-emitting scripts (`init` board outline, `add-pcb-shape`/`add-pour`/`add-fill`/`add-region rect`) now take the **bottom-left corner + size** in authoring space, so placed geometry lands inside the board outline (verified against a real-client export).

## [1.4.0] - 2026-09-10

### Changed
- Panel documents are no longer created by default (`bcd6e24`) — opt in with `init.js --panel`.

## [1.3.0] - 2026-09-10

### Fixed
- Real-client open failures (`d5cd874`): embedded DOCHEAD records were missing the project `client` field, and ATTR heads lacked the `id` the client links through `parentId`. Schematics verified in the offline client after this fix.

## [1.2.0] - 2026-09-10

### Added
- Two-tier library (`7aca315`): **preset templates** under `templates/library/{symbol,footprint}/` (RES/CAP/IND/DIODE/LED/TEST_POINT, GND/AGND/PGND/5V/VCC, net ports, off-page connectors, DIFF_PAIR/SHORT, R0402…SMA/TP0.5 — split from a real-client `.elibu` export via `scripts/tools/split-elibu.js`), resolved first on every placement; **temp entries** generated per project under `<project>/.tmp/library/`, removed by the new `cleanup.js`.
- `scripts/tools/split-elibu.js` maintainer tool; `load-library.js` gains `list`/`show`/`remove` over both tiers.

### Changed
- Unified placement entry `add-symbol.js` dispatches by entry kind (symbol/power/port/special); `add-power.js` and `add-port.js` removed. DEVICE docs are composed on the fly from `--symbol`/`--footprint` — device staging dropped.

## [1.1.0] - 2026-09-09

### Added
- Primitive authoring scripts (`467d5d2`): `generate-symbol.js`, `generate-footprint.js`, `add-text.js`, `add-shape.js`, `add-pcb-shape.js`, `add-pcb-text.js`, `add-via.js`, `add-pour.js`, `add-fill.js`, `add-region.js`, `load-library.js`.
- `scripts/tools/audit-format.js` (`d61d316`): cross-checks every generated record against the **easyeda-pro-format-skill** JSON Schemas with a divergence whitelist where real records win.

### Removed
- `.elibz2` import and third-party format conversion from this skill (`436a2c9`) — conversion lives in a separate project.

## [1.0.0] - 2026-09-08

### Added
- Initial skill: cross-platform Node scripts for bootstrapping `.eprj3` projects (`init.js`), placing schematic components (`add-symbol.js`), PCB footprints (`add-footprint.js`), wires/net labels, refdes renumbering, format validation (`validate.js`), and launching the EasyEDA Pro / LCEDA Pro offline client (`open.js`).
- Format documentation in `docs/format-reference.md` plus the `blink` example project and the smoke regression suite.
