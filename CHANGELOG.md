# Changelog

All notable changes to **easyeda-eprj3-skill** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Versioning convention: every change that lands in a commit must bump `package.json` (`patch` for fixes, `minor` for new capabilities or behavior changes, `major` only for format-breaking record changes) **and** add an entry here in the same commit.

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

Ground truth arrived: `examples/blink` and `examples/easyeda-eprj3-project`
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
- `examples/blink` regenerated through the V4 writer; `examples/easyeda-eprj3-project`
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
