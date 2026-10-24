# Changelog

All notable changes to **easyeda-eprj3-skill** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Versioning convention: every change that lands in a commit must bump `package.json` (`patch` for fixes, `minor` for new capabilities or behavior changes, `major` only for format-breaking record changes) **and** add an entry here in the same commit.

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
