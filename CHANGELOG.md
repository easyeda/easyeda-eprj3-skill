# Changelog

All notable changes to **easyeda-eprj3-skill** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Versioning convention: every change that lands in a commit must bump `package.json` (`patch` for fixes, `minor` for new capabilities or behavior changes, `major` only for format-breaking record changes) **and** add an entry here in the same commit.

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
- `.elibz2` import and KiCad conversion from this skill (`436a2c9`) — conversion lives in the separate **kicad-to-easyeda-eprj3** project.

## [1.0.0] - 2026-09-08

### Added
- Initial skill: cross-platform Node scripts for bootstrapping `.eprj3` projects (`init.js`), placing schematic components (`add-symbol.js`), PCB footprints (`add-footprint.js`), wires/net labels, refdes renumbering, format validation (`validate.js`), and launching the EasyEDA Pro / LCEDA Pro offline client (`open.js`).
- Format documentation in `docs/format-reference.md` plus the `blink` example project and the smoke regression suite.
