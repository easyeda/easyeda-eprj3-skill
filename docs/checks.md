# Checks: codes and what to do about them

Five independent gates. Run them individually, or let `build.js` run all five and
fail on the first error class.

```bash
node scripts/validate.js     --dir <p> [--json]
node scripts/erc.js          --dir <p> [--design design.json] [--json] [--strict] [--no-pcb]
node scripts/lint-layout.js  --dir <p> [--json] [--strict] [--min-score 90] [--rules]
node scripts/drc.js          --dir <p> [--json] [--strict] [--min-score 90] [--rules]
node scripts/intent.js       --design design.json [--json] [--strict] [--rules]
```

`--strict` promotes warnings to failure. `--min-score` fails on a low score even
with no errors. Scores are `100 − Σ(rule weight)` per gate, clamped at 0.

Every finding (in text and in `--json`) carries a `fix:` field — the exact edit
to make. Mechanical fixes (NC for unconnected pins, decoupling caps) are
automated: `node scripts/autofix.js --design design.json [--check]`.

## Format — `validate.js`

No codes; it reports plain messages about index shape, doc uuids, ticket-pair
uniqueness, Device/Symbol/Footprint reference integrity, wire↔LINE linkage,
PAD_NET↔NET↔COMPONENT references, missing panel files and stray files in a
schematic directory. Any error means the file is corrupt — rebuild rather than
patch, unless you know exactly which record is wrong.

Since 1.10 it also catches the corruption classes the corpus found blind, and
in 1.12 every rule was re-calibrated against **real client-saved V4 projects**
(official quick-start + H610, 2138 DOCHEAD lines) — rules no real file obeys
were deleted rather than softened:
- record body that is not valid JSON after a stray `||` (*error* — bodies used to vanish into `{}`);
- `COMPONENT`/`WIRE` heads without an id (*error*);
- zero-byte / no-DOCHEAD containers (*error* — every reader reports instead of throwing);
- duplicate `(ticket, id)` **pair** within one document (*error*) — ticket alone repeating across different ids is what real saves do (all FONT rows share ticket 1), so the old "tickets unique" and the 1.10 "tickets increase in file order" rules were **removed** (the official quick-start sheet has 813 backwards tickets);
- foreign `DOCHEAD.client` (*warning*, aggregated to one line per file);
- `ATTR.parentId` that matches no record anywhere in the file (*error*) — with two legal exceptions measured on real files: cross-document element ids and the instance-path form `eNNNN(-i)eNN…` that NO_CONNECT uses to flag a pin through its component.
DOCHEAD is detected by parsed head type, never by literal prefix — ticketed V4
heads, bare V3 heads, 16- and 32-hex doc uuids, and the legacy path form of
`profile.owner.uuid` all parse cleanly. `writeLines` normalises generated
DOCHEAD frames to `{"type":"DOCHEAD","ticket":1}`.

## Electric — `erc.js`

| Code | Level | Meaning | Fix |
| --- | --- | --- | --- |
| `E001` | error | pin lands on no wire/label | add the net to `parts[].pins`, or wire it |
| `E002` | error | net with a single pin and no power flag | join it to something or remove the stub |
| `E003` | error | built netlist ≠ design intent | a wire went somewhere else; re-run `build.js --force` |
| `E004` | error | duplicate reference designator | unique `parts[].id` |
| `E005` | error | part in schematic but not on the PCB | add a footprint |
| `E006` | error | PCB pad net ≠ schematic net | PCB placement lost its `--nets` map |
| `E007` | warn | auto-named net (`N$…`) | name it, or it will not survive a refactor |
| `E008` | error | two or more outputs drive one net | mark one side as input/high-Z in the symbol or IC spec (`"num:name:dir"`), or buffer one driver — needs the design context (`build.js` and `erc.js --design` run it) |
| `W001` | warn | supply-looking net without a power flag | declare it in `powers` |
| `W002` | warn | IC on a supply with no decoupling cap | add one (0.1 µF per supply pin) — or run autofix |
| `W003` | warn | net bridges two pins of the same part | usually a typo in `pins` |

`E003` is the important one: it compares the netlist recovered from the files
against the one the design file asked for, pin by pin. It is what catches a wire
that visually looks right and electrically is not. The `NC`/`DNC` net names are
the accepted no-connect convention: a lone pin on one of them passes.

## Layout — `lint-layout.js`

| Code | Level | Weight | Meaning |
| --- | --- | --- | --- |
| `L001` | error | 10 | two symbols overlap |
| `L002` | error | 6 | a part is not fully inside a block frame |
| `L003` | error | 6 | a wire segment is not orthogonal |
| `L004` | error | 10 | a wire crosses a symbol body |
| `L005` | warn | 3 | two block frames overlap |
| `L006` | warn | 3 | free text sits on top of a part |
| `L007` | warn | 3 | a part is outside the A4 drawing frame |
| `L008` | warn | 1 | a part origin is off the 10 mil grid |
| `L009` | warn | 2 | a net label sits on a part |
| `L010` | warn | 2 | a wire endpoint touches nothing |

`L001`/`L004` are the ones that make a schematic unreadable; they usually mean
the block is too dense — raise `layout.cellW/cellH` or split the block.

## Copper — `drc.js`

| Code | Level | Weight | Meaning |
| --- | --- | --- | --- |
| `D001` | error | 12 | copper-to-copper spacing below clearance (different nets) |
| `D002` | error | 8 | track narrower than the minimum (per-net declared widths satisfy their own floor) |
| `D003` | error | 8 | copper too close to the board edge |
| `D004` | error | 12 | a net with 2+ pads is not fully routed |
| `D005` | error | 10 | board outline missing or degenerate |
| `D006` | warn | 4 | no ground pour |
| `D007` | warn | 2 | pad without a net |
| `D008` | warn | 2 | via geometry out of range |
| `D009` | error | 6 | via/pad drill below the manufacturing minimum (`minDrill`) |
| `D010` | warn | 3 | annular ring below the minimum (`minRing`) |
| `D011` | warn | 2 | silkscreen text overlapping a copper pad (same board side) |
| `D012` | warn | 2 | same-net track segments meeting at an acute angle (`minAngle`) |

`D001` on two pads of the *same* footprint is ignored (that is the package's land
pattern), but everything else is enforced. On a board that actually carries
copper, `D004` skips nets a pour already connects — the plane is what joins them.

**Copper policy.** Since 1.13 the skill has no router and no pour generator:
every board it builds is **placed-only** — footprints, pad↔net links, board
outline, and the `rats:` handoff list (`build.js` prints the nets to connect by
hand in the client; the report says `pcb: {parts, mode: 'placed-only', rats}`).
`D004` (net not routed) and `D006` (no ground pour) are therefore **never**
judged on a self-built board — flagging copper that was never promised would
punish every correct deliverable. Everything that applies to placement itself —
`D001` pad spacing, `D003` edge, `D005` outline, `D007` orphan pad, and all four
DFM rules — still runs. A project **imported from, or re-saved by, the client**
that contains tracks/pours/vias is detected as a copper-carrying board and gets
the full review, D004/D006 included. `runDrc` reports `mode` and, for placed
only, `skipped: ['D004','D006']`; the CLI can force either reading with
`--placed-only` / `--routed` (auto-detect: a board with no tracks is placed-only).

### DFM rules (D009–D012)

- **`D009` min drill** — plated holes under `minDrill` (default 12 mil = 0.30 mm,
  the JLCPCB basic-process floor) are unbuildable, so this is an error. It checks
  via `holeDiameter` and the footprint pad `hole` field; exactly 12 mil passes.
  Fix: on a board this skill placed, choose a footprint whose through-hole pads
  drill ≥ 12 mil (the drill comes from the design, not from copper); on imported
  or client-added copper, fix or delete the offending via in the client.
- **`D010` min annular ring** — ring = (outer − drill)/2, under `minRing`
  (default 4 mil ≈ 0.1 mm) the drill can break out of the copper during
  plating. A warning with a deliberately conservative floor: fabs quote
  0.10–0.15 mm, and the shipped through-hole defaults must stay quiet.
- **`D011` silk on pad** — a `STRING` record on the top/bottom silkscreen layer
  (layerId 3/4) whose estimated text bbox crosses a copper pad *of that board
  side* (top silk vs layer 1/12 pads, bottom silk vs layer 2/12). Silk printed
  on exposed solder metal bakes into the joint. The bbox is estimated from
  `x/y/text/fontSize/origin/angle` at 0.6×0.7 em per glyph — the client stores
  no text outline. Footprint silk (LINE records in the FOOTPRINT doc) is not
  covered. Fix: move the text with `add-pcb-text.js` into the silk-safe gap.
- **`D012` acute track angle** — two same-net, same-copper-layer (`layerId` 1/2)
  track segments that SHARE an endpoint and bend under `minAngle` (default 45°)
  form an etch wedge that traps acid and thins the insulation. Only segments
  meeting at a shared endpoint are compared, never every pair. A join folded
  back exactly (0°) is overlapping copper and is left to the spacing rules;
  45° chamfers are legal. Fix (the copper is always client- or import-owned):
  reroute it as a 45° chamfer/arc in the client, or delete the segment there;
  if the placement forced the pinch, give more room via `pcb.place` and re-run
  `build.js --force` before the copper work.

Defaults: clearance 10, min track 8, edge 12 mil, min drill 12, min ring 4, min
angle 45. `build.js` judges placement — and any imported or client-saved copper
it reviews — against the SAME `pcb.rules` the design declares, so a board that
declares fine-pitch floors is judged by them, not by these defaults. The three
DFM thresholds are configurable the same way through `runDrc(file, {rules})` —
and through the design contract: `pcb.rules.minDrill` / `minRing` / `minAngle`
are forwarded by `build.js`, so a design that declares a fab floor is judged by
its own floor, not the default.

## Netlist — `netcheck.js` (schematic ↔ PCB)

`build.js` runs this comparison after every build and stores it in
`report.netcheck`; `node scripts/netcheck.js --dir <p> [--json]` re-runs it
standalone (exit 1 on any mismatch). It diffs both netlists pin by pin:

| Code | Meaning | Fix |
| --- | --- | --- |
| `PAD_NET` | schematic pin's PCB pad has no net | re-run `build.js --force` |
| `NET_MISMATCH` | pad net ≠ schematic net | re-run `build.js --force`; if it persists fix `parts[].pins` |
| `NO_PAD` / `EXTRA_PAD` | symbol pin without a footprint pad (or the reverse) | align `parts[].pins` with the footprint |
| `NO_FOOTPRINT` / `NO_SYMBOL` | part on one side only | add the missing half |
| `PAD_NO_NET` | PCB pad without a net | map every pad in `parts[].pins` |
| `PIN_FLOATING` | schematic pin connects to nothing | map it (or `"NC"`) |

## Netlist audit — `netlist.js --audit` (independent review)

`netcheck.js` compares the schematic with the PCB — both produced by this
skill, so a mistake present on both sides matches perfectly. The audit closes
that hole by handing a reviewer **two independent views** of the same design:

- **spec** — the pin→net map declared in design.json (what was asked for)
- **built** — the netlist recovered from the generated schematic (what exists)

```bash
node scripts/netlist.js --dir <p> --design design.json --audit <out.json>
```

It writes a self-contained package (`schema: eprj3-netlist-audit/1`) holding
both views, `mechanical` (the tool's diff, the netcheck verdict and advisory
`suspicions`), the `rubric` to run and the required `verdictSchema`. It always
exits 0 — it reports, it does not judge. A fresh sub-agent with no inherited
context runs the rubric and returns `{ok, summary, findings[]}`; the exact loop
lives in [SKILL.md § Netlist audit](../SKILL.md#netlist-audit--a-fresh-reviewer-not-you).

`mechanical.ok` is true only when spec and built agree net by net, no pin sits
on two nets, no declared pin has vanished from the symbol, NC declarations are
honoured on both sides, no pin is floating, and `netcheck` matches. The
reviewer adds judgement on top — single-pin nets, auto-named `N$` nets, supply
names drawn without a power flag, a part whose pins all sit on one net — as
`warn` findings that never trigger a rebuild by themselves.

## Intent — `intent.js` (the fifth gate)

Catches mistakes that live *inside* design.json, which no connectivity or copper
check can see. Rules run only when the relevant declaration exists, so a design
without `expect`/`polarity` skips the gate entirely.

| Code | Level | Weight | Meaning |
| --- | --- | --- | --- |
| `I001` | error | 15 | a `polarity`-marked pin sits on a ground net with mark "+" — the reversed-LED / reversed-electrolytic killer. A TVS/flyback clamp declares `"role": "shunt"` and is exempt (its anode belongs on ground). A cathode on ground or a rail-to-rails orientation is never judged (undecidable from nets alone) |
| `I002` | error | 10 | `expect.decoupling`: a supply net has no capacitor to ground |
| `I003` | error | 8 | `expect.pairs`: a declared pair is unused or has unbalanced pin counts |
| `I004` | error | 8 | `expect.valueRange`: a part's value is outside its declared range (unparseable values warn) |
| `I005` | error | 10 | `expect.divider`: top/bottom resistors are mis-wired, or the actual ratio (from parsed values) is outside `ratio ± tol` |
| `I006` | warn | 2 | a declared pair is remembered for the handoff — routing it as a differential pair is a client task (this skill never routes) |

Values parse in engineering notation: `10k` `330R` `100nF` `4.7uF` `1MΩ`.

## Using the scores as a regression signal

```bash
node scripts/eval.js                 # every recipe + example, builds and gates each
node scripts/eval.js --case blink    # one case
node scripts/eval.js --design my.json  # measure a new design with the same yardstick
node scripts/eval.js --diff          # compare against the previous run in history
node scripts/eval.js --json          # machine-readable
```

Each run appends a summary to `eval/history.jsonl` (version, per-case lint/drc
scores, pass/fail, build seconds). That file is the answer to "did this
iteration make things better or worse" — compare runs instead of trusting a
memory of the previous output.

Thresholds live in `eval/cases.json`; a case fails when a gate has an error, a
score is below its minimum, or the build exceeds its time budget.
