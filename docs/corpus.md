# The legal / illegal corpus (`test/corpus.js`)

`test/smoke.js` proves the primitives still build a well-formed project; the
**corpus** proves the gates tell legal from illegal. It is a declarative test
set of whole projects, split in two halves:

* **legal** — projects every gate must **accept** (0 `validate` errors, and for
  generated ones 0 `erc` errors). Without these witnesses a checker that simply
  reported everything would pass the illegal half.
* **illegal** — a copy of a legal baseline with **one minimal tampering**, plus
  the `expect` that names which gate must report which code.

```bash
node test/corpus.js              # also: npm run test:corpus (part of npm test)
node test/corpus.js --probe      # print what each gate ACTUALLY reports, assert nothing
node test/corpus.js --only pour  # only variants whose name contains "pour"
```

Output style matches `test/smoke.js`: `ok` / `FAIL` lines, then
`N/M checks passed`; exit 1 on any failure.

## Files

| file | contents |
| --- | --- |
| `test/corpus.js` | runner: builds/copies baselines, applies mutations, calls the gates, asserts |
| `test/corpus/legal.json` | the legal projects (also the clone sources for variants) |
| `test/corpus/format.json` | illegal variants: structure, encoding, references, folder layout |
| `test/corpus/electrical.json` | illegal variants: nets, pads, designators, copper |
| `test/corpus/client.json` | illegal variants cloned from the committed **client-authored** project |

Everything happens under `os.tmpdir()` and is deleted on exit; the repository is
never written to (`--probe` keeps the temp tree and prints its path so you can
open a mutated project by hand).

## Baselines

A legal entry is either generated

```json
{ "name": "build/blink", "key": "blink", "build": "examples/designs/blink.json" }
```

in which case `scripts/build.js` produces it into a temp dir and the run asserts
the build exits 0 with a clean format and electrical report — or committed:

```json
{ "name": "committed/easyeda-eprj3-project", "key": "client",
  "dir": "examples/easyeda-eprj3-project", "formatOnly": true }
```

`formatOnly` marks a project this skill did not author. The **format** gate must
still accept it; its circuit is out of scope, so ERC/lint/DRC findings are
printed but not asserted (the committed client sample has unconnected pins by
design). Committed projects are copied before any variant touches them.

`key` is what an illegal variant refers to with `"base"`.

## Illegal variant shape

```json
{
  "name": "pour-flat-path",
  "base": "blink",
  "category": "pour geometry",
  "title": "POUR path loses its nesting",
  "mutate": "replace POUR1's nested path with a flat one",
  "mutation": [{ "op": "record_set", "target": "pcb",
                 "sel": { "doc": "main", "type": "POUR", "nth": 0 },
                 "set": { "body.path": ["R", 24, 976, 1552, 952] } }],
  "expect": { "validate": ["path must be an array of polygon arrays"] }
}
```

`mutation` is a list of steps applied to the copy, in order. A step that matches
nothing is a **failure** (`mutation actually applied`): a silent no-op would make
the item pass for the wrong reason.

### targets

`index` (the `.eprj3` file) · `ecfg` · `sheet` (first `.esch2`) · `pcb` (first
`.epcb2`) · `panel` (first `.epan2`) · `schDir` · `panelDir` · `root`. They are
resolved from the **pristine** baseline, so a variant can still find its files
after its own index has been destroyed.

### selectors (`sel`)

| key | meaning |
| --- | --- |
| `doc` | `"main"` (default = last doc of the container), `"any"`, or a docType string (`SYMBOL`, `DEVICE`, `SCH_PAGE`, `PCB`, `SCH`, …) |
| `type` | record head type |
| `key` | `ATTR` body key |
| `where` | dotted record paths that must compare equal, e.g. `{ "body.padNet": "V_LED" }`, `{ "id": "[\"NET\",\"\"]" }` |
| `idStartsWith` | head id prefix, e.g. `["PAD_NET",` |
| `byDesignator` | resolve the component that owns this `Designator` value and match records by **its** head id |
| `nth` / `all` | which match to take (default: the first) |

Never hard-code a record id: ids and uuids are random on every build. Select by
`where` / `byDesignator` — stable content such as a refdes or a net name.

### ops

| op | step fields | effect |
| --- | --- | --- |
| `json_delete` / `json_set` | `target`, `path`, `value` | edit the index (or any JSON target) by dotted path |
| `json_raw` | `target`, `content` | overwrite a file with literal bytes |
| `raw_append` | `target`, `lines[]` | append raw record lines |
| `record_set` / `record_unset` | `target`, `sel`, `set{}` / `keys[]` | edit dotted paths (`head.id`, `body.value`, …) of matching records |
| `record_remove` | `target`, `sel` | delete matching records |
| `record_dup` | `target`, `sel` | copy a record verbatim to end of file (same ticket) |
| `ticket_swap_tail` | `target` | swap the tickets of the last two records of the main doc |
| `doc_uuid_duplicate` | `target`, `source`, `into` | copy one doc's uuid onto another doc |
| `wire_remove` | `target`, `sel` (a `NET` attr) | delete that wire, its `LINE`s and its attrs |
| `line_remove_of_net` | `target`, `net` | delete one `LINE` segment of the wire labelled `net` |
| `component_remove` | `target`, `designator` | delete a component with its attrs and `PAD_NET`s |
| `component_move` | `target`, `designator`, `dx`, `dy` | shift a component off its coordinates |
| `line_skew` | `target`, `sel`, `dx`, `dy` | bend one wire segment off the orthogonal grid |
| `remove_net_copper` | `target`, `net` | delete all tracks + vias of a net |
| `stray_file` | `target`(dir), `name`, `content` | create an extra file |
| `file_delete` | `target` | remove a file |

### expect

| key | matched against |
| --- | --- |
| `validate` / `validateWarnings` | substrings of `validate.js` error / warning messages (the format gate has **no codes** — see `docs/checks.md`) |
| `erc` / `ercWarnings` | ERC finding ids (`E000`–`E007`, `W001`–`W003`) — or a fragment of the message |
| `lint` / `drc` | finding codes (`L0xx`, `D0xx`) |
| `leak: true` | recorded **blind spot**: nothing is expected to report it. Prints, never fails |
| `crash: ["validate", …]` | recorded **robustness gap**: those gates throw instead of reporting a finding. Prints, never fails |
| `blindTo: ["validate", …]` | documentation on a caught item: another gate found it, these did not |

All four gates (`validate`, `erc`, `lint-layout`, `drc`) run **in process** on
every variant, and every one of them is wrapped: a checker that throws is
reported as a crash, never as a pass. ERC is always given the baseline's design
file, so `E003` (built netlist ≠ design intent) is part of the comparison.

## Adding a variant

1. Write the `mutation` and a **guess** for `expect`.
2. `node test/corpus.js --only <name> --probe` — read what the gates really
   report (validate messages, ERC ids, lint/DRC codes, crashes).
3. Paste the real values into `expect`. Never invent a code: `validate` has no
   codes, so it quotes message substrings; `E00x` / `L0xx` / `D0xx` must exist in
   `scripts/lib/erc.js`, `scripts/lib/lint.js`, `scripts/lib/drc.js`.
4. `node test/corpus.js` — the run also checks that the expectation was **not**
   already true on the untouched baseline. An `expect` that the pristine project
   already satisfies is rejected as *vacuous*, because it would pass whether or
   not the tampering worked.
5. If nothing at all reports it, keep the variant with `expect.leak = true` and a
   `suggest` naming the rule a future checker should grow — that is how a blind
   spot becomes tracked work instead of a forgotten one. When a rule is added,
   the run prints `recorded gap looks closed` and you move the item to a real
   `expect`.

Cascade findings are listed too: renaming a power flag's net breaks both `E003`
(netlist ≠ design) and `E006` (board ≠ schematic), and the manifest says so.
Declare what actually happens, not just the interesting part.

## Recorded gaps as of today

The run prints these under `recorded gaps`; they are assertions-free on purpose.

| item | gate | what is missing |
| --- | --- | --- |
| `schematic-wire-segment-dropped` | all four | deleting a segment of a multi-segment wire removes copper-equivalent drawing while the net still connects — connectivity-only reasoning cannot see it |

Everything else the corpus once had to record as blind is **closed** in
`scripts/lib/checks.js` (and its manifest entry moved to a real `expect`):

| was | now | level |
| --- | --- | --- |
| stray `||` silently losing a body | "record body is not valid JSON" | error |
| tickets unique but unordered | "N ticket(s) out of file order" — scoped to MAIN docs (real client SYMBOL docs are unordered by design) | warning |
| foreign `DOCHEAD.client` | "DOCHEAD client … ≠ project client" — warning because genuine merged client projects legitimately differ | warning |
| dangling `ATTR.parentId` | "parentId … references nothing in the document" | error |
| `COMPONENT`/`WIRE` head without `id` | "head has no id" | error |
| zero-byte container crashing the gates | "document file has no DOCHEAD records" + `netlist/drc/pins` stubs that degrade to findings instead of throwing | error |

The warning-vs-error choice is empirical, not taste: both committed real-client
examples pass every new error-level rule, and the two rules they would have
failed (client id, ticket order on client-authored main docs) are exactly the
two kept at warning.
