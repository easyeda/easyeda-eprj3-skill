# Changelog

All notable changes to **easyeda-eprj3-skill** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Versioning convention: every change that lands in a commit must bump `package.json` (`patch` for fixes, `minor` for new capabilities or behavior changes, `major` only for format-breaking record changes) **and** add an entry here in the same commit.

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
