# Checks: codes and what to do about them

Four independent gates. Run them individually, or let `build.js` run all four and
fail on the first error class.

```bash
node scripts/validate.js     --dir <p> [--json]
node scripts/erc.js          --dir <p> [--design design.json] [--json] [--strict] [--no-pcb]
node scripts/lint-layout.js  --dir <p> [--json] [--strict] [--min-score 90] [--rules]
node scripts/drc.js          --dir <p> [--json] [--strict] [--min-score 90] [--rules]
```

`--strict` promotes warnings to failure. `--min-score` fails on a low score even
with no errors. Scores are `100 − Σ(rule weight)` per gate, clamped at 0.

## Format — `validate.js`

No codes; it reports plain messages about index shape, doc uuids, ticket
uniqueness, Device/Symbol/Footprint reference integrity, wire↔LINE linkage,
PAD_NET↔NET↔COMPONENT references, missing panel files and stray files in a
schematic directory. Any error means the file is corrupt — rebuild rather than
patch, unless you know exactly which record is wrong.

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
| `W001` | warn | supply-looking net without a power flag | declare it in `powers` |
| `W002` | warn | IC on a supply with no decoupling cap | add one (0.1 µF per supply pin) |
| `W003` | warn | net bridges two pins of the same part | usually a typo in `pins` |

`E003` is the important one: it compares the netlist recovered from the files
against the one the design file asked for, pin by pin. It is what catches a wire
that visually looks right and electrically is not.

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
| `D002` | error | 8 | track narrower than the minimum |
| `D003` | error | 8 | copper too close to the board edge |
| `D004` | error | 12 | a net with 2+ pads is not fully routed |
| `D005` | error | 10 | board outline missing or degenerate |
| `D006` | warn | 4 | no ground pour |
| `D007` | warn | 2 | pad without a net |
| `D008` | warn | 2 | via geometry out of range |

`D001` on two pads of the *same* footprint is ignored (that is the package's land
pattern), but everything else is enforced. `D004` skips poured nets, because the
plane is what connects them.

Defaults: clearance 10, min track 8, edge 12 mil, via 16–60. The built-in router
uses stricter numbers so that its output passes the defaults with headroom.

## Using the scores as a regression signal

```bash
node scripts/eval.js                 # every recipe + example, builds and gates each
node scripts/eval.js --case blink    # one case
node scripts/eval.js --json          # machine-readable
```

Each run appends a summary to `eval/history.jsonl` (version, per-case lint/drc
scores, pass/fail, build seconds). That file is the answer to "did this
iteration make things better or worse" — compare runs instead of trusting a
memory of the previous output.

Thresholds live in `eval/cases.json`; a case fails when a gate has an error, a
score is below its minimum, or the build exceeds its time budget.
