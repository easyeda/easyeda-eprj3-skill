---
name: easyeda-eprj3
description: Create and edit EasyEDA Pro folder-based .eprj3 PCB projects. Use this skill whenever the user wants to author a schematic/PCB in EasyEDA Pro offline-client format from AI prompts, build symbols/footprints/devices, or run validation. Drives the Node.js scripts under scripts/.
---

# EasyEDA Pro eprj3 Project Skill

This skill teaches any coding agent to author **EasyEDA Pro** (嘉立创EDA专业版) projects in the folder-based `.eprj3` format. The format spec is documented in [`docs/format-reference.md`](docs/format-reference.md); the authoritative, machine-checkable spec lives in the **easyeda-pro-format-skill** repo at https://github.com/easyeda/easyeda-pro-format-skill (per-record field tables under `primitives/`, real record samples under `examples/`, JSON Schemas under `schemas/`). The official example project (https://github.com/easyeda/easyeda-pro-eprj3-format) remains the ground truth for record shapes — where a schema and a real record disagree, the record wins.

## When to invoke

Trigger this skill when the user wants any of the following:

- Create a new `.eprj3` project (schematic + PCB) from scratch.
- Generate symbols / footprints / devices and place them on a sheet or the PCB.
- Draw wires, net labels, power symbols, net ports, free text, graphic shapes, vias, copper pours, or copper tracks.
- Validate the format of an existing `.eprj3` directory.
- Open the resulting project in the EasyEDA Pro (or LCEDA Pro / 嘉立创EDA专业版) offline client.

KiCad → eprj3 conversion is out of scope for this skill — it lives in the separate **kicad-to-easyeda-eprj3** project. Do not invoke this skill for it.

Do not invoke it for the legacy single-file `.eprj`/`.eprj2` SQLite format, or for `.elibz2` library archives — neither is supported.

## Required user inputs

Ask the user the following before writing any file. Stop and ask again if a key piece is missing — do not invent values.

1. **Project storage path** (absolute, must be writable, no existing `.eprj3` there).
2. **Project name** (defaults to the folder basename).
3. **Schematic requirements** — components, pin numbers/names, nets, power symbols, sheet count.
4. **PCB requirements** — board outline size, component placement, which pads join which net, tracks.
5. **Component library** — the scripts auto-generate minimal symbols/footprints from pin/pad specs (see below). There is no `.elibz2` import; if the user needs a specific vendor part, derive its pin/pad geometry from the datasheet and generate it.

Always confirm the resolved path/name before running `init.js`.

## Standard workflow

**Path note:** every `node scripts/...` invocation below is relative to **this skill's repository root** (the directory containing SKILL.md) — not the user's project directory. `cd` into the skill directory or use absolute paths. The `docs/` links are relative to the same directory.

All coordinates are **mil** unless a script's help says otherwise.

```
1.  Resolve paths & project name                    (AskUserQuestion)
2.  node scripts/init.js --dir <dir> --name <name>
    [--schematic Schematic1] [--sheet P1] [--pcb PCB1]
3.  Pick library entries — check the preset templates first:
      node scripts/load-library.js list             (presets; add --dir to also list project staging)
    Place a preset directly (resolved first on every placement), e.g.:
      node scripts/add-symbol.js ... --symbol RES --footprint R0603
      node scripts/add-symbol.js ... --symbol VCC             (power flag)
      node scripts/add-symbol.js ... --symbol PORT_IN         (net port)
      node scripts/add-footprint.js ... --symbol RES --footprint R0603
    No preset fits? Stage a temp entry under <dir>/.tmp/library/
    (names must not shadow a preset — the scripts reject that):
      node scripts/generate-symbol.js from-pins --dir <dir> --name <sym>
           [--designator R] [--pins "1;2:A;3:x:y:rot"]
      node scripts/generate-footprint.js from-pads --dir <dir> --name <fp>
           [--pads "1:x:y:w:h;..."] [--outline "R,x,y,w,h"] [--silk "rect,x1,y1,x2,y2;..."]
      node scripts/load-library.js power --dir <dir> --net VCC [--style up|down]
      node scripts/load-library.js port  --dir <dir> --net SIG [--name <entry>]
4.  node scripts/add-symbol.js --dir <dir> --sch <s> --sheet <p>
    --symbol <entry> [--footprint <fp>] --x <mil> --y <mil>
    [--rotation 0|90|180|270] [--refdes R1] [--name <device title>]
    (unified placement, dispatched by entry kind: symbol -> component block,
     power -> power flag, port -> net port, special -> DIFF_PAIR/SHORT flag)
5.  node scripts/add-wire.js --dir <dir> --sch <s> --sheet <p>
    --segs "x1,y1,x2,y2;..." [--net SIG]
6.  node scripts/add-netlabel.js --dir <dir> --sch <s> --sheet <p> --net SIG --at x,y
7.  node scripts/add-text.js --dir <dir> --sch <s> --sheet <p>
    --value "text" --x .. --y .. [--size N] [--rotation N]
    node scripts/add-shape.js <rect|poly|circle|ellipse|arc|bezier> --dir <dir>
    --sch <s> --sheet <p> <shape options>                    (annotation graphics)
8.  node scripts/set-refdes.js renumber --dir <dir> --sch <s> --sheet <p> --prefix R
    (or: set --designator R1 --value R5)
9.  node scripts/add-footprint.js --dir <dir> --pcb <pcb>
    --symbol <entry> --footprint <fp> --x <mil> --y <mil>
    [--angle 90] [--refdes R1] [--nets "1:VCC,2:GND"]
10. node scripts/add-track.js --dir <dir> --pcb <pcb> --net SIG --x1 .. --y1 .. --x2 .. --y2 ..
    [--layer 1] [--width 10]
    node scripts/add-via.js  --dir <dir> --pcb <pcb> --x .. --y .. [--net SIG]
    node scripts/add-pcb-shape.js <rect|poly|circle|arc> --dir <dir> --pcb <pcb> ...
    node scripts/add-pcb-text.js --dir <dir> --pcb <pcb> --value "text" --x .. --y ..
    [--layer 1] [--size 60] [--origin 0-8]
    node scripts/add-pour.js <rect|poly> --dir <dir> --pcb <pcb> --net GND ...
    node scripts/add-fill.js <rect|poly> --dir <dir> --pcb <pcb> [--net N] ...
    node scripts/add-region.js <rect|poly> --dir <dir> --pcb <pcb>
    --prohibit "COMPONENT,TRACK" ...                        (keepout region)
11. node scripts/validate.js --dir <dir>            (always run this)
12. If validation reports errors, fix and re-run until clean.
13. node scripts/cleanup.js --dir <dir>             (remove <dir>/.tmp — run once validation passes)
14. node scripts/open.js open --dir <dir>           (launch the offline client)
```

Two library tiers: **preset templates** ship with the skill under `templates/library/{symbol,footprint}/` (committed with the skill, resolved FIRST on every placement) and **temp entries** generated during authoring under `<project>/.tmp/library/` (tooling metadata — the client never sees it). `load-library.js list` shows both tiers (`preset`/`tmp`), `show --name <entry>` dumps one, `remove --name <entry>` deletes a temp entry (presets are committed — not removable). Temp entry names must not shadow a preset name.

`generate-symbol.js` auto-layout mirrors the official example: two pin columns at x=±20, pin length 10, vertical pitch 10. Pass `num:name:x:y:rotation` entries for explicit placement.

Steps 12–13 are a loop: run, fix, run, fix — until the validator reports `0 errors, 0 warnings`.

### Launching the client — non-default install paths

The EasyEDA Pro / LCEDA Pro installer lets the user pick any directory. The documented Windows default locations are:

- `C:\Program Files\easyeda-pro\easyeda-pro.exe` (English brand)
- `C:\Program Files\lceda-pro\lceda-pro.exe` (Chinese brand)

On Windows the installer also supports `C:\Program Files (x86)\...` and the per-user `%LOCALAPPDATA%\Programs\...` layout — `open.js` probes those automatically. macOS and Linux install paths are not officially documented; the script probes the standard `Applications/` and `/usr/bin/` / `/opt/` locations but the user should pass `--client` or run `open.js set` once.

If the client is not in any of those locations, ask once and persist the path:

```bash
node scripts/open.js set --client "<absolute path to easyeda-pro.exe or lceda-pro.exe>" --dir <projectDir>
```

This writes `<projectDir>/.easyeda-pro-client.json`. Subsequent `open` / `where` / `install` commands pick it up.

If the user prefers a one-time override without saving, set `$EASYEDA_PRO_CLIENT` or pass `--client` on the command line.

## What every eprj3 project contains

```
<dir>/<name>.eprj3                       project index (pretty JSON, format:"folder")
<dir>/sch/<schematic>/<sheet>.esch2      sheet docs: frame SYMBOL + embedded SYMBOL/DEVICE docs + SCH_PAGE main
<dir>/sch/<schematic>/<schematic>.ecfg   4 records: DOCHEAD(META SCH)+META+RULE+RULE
<dir>/sch/<schematic>/<schematic>.evar   empty (variant data)
<dir>/pcb/<pcb>.epcb2                    PCB docs: embedded SYMBOL/FOOTPRINT/DEVICE docs + PCB main
<dir>/panel/Panel1.epan2                 panel document
<dir>/.tmp/library/                      temp library entries (generation-time only; cleanup.js deletes it)
```

Preset library templates (always consulted first when placing) live in the skill repo at `templates/library/{symbol,footprint}/` — see [templates/README.md](templates/README.md) for the entry catalog.

Key format invariants (enforced by `validate.js`):

- A placed component embeds its SYMBOL/DEVICE docs in the same file; `Symbol`/`Device` attrs reference those doc uuids. PCB components additionally embed the FOOTPRINT doc.
- Power symbols and net ports are special devices: the COMPONENT carries `DeviceName: null` and the net lives in `Name` / `Global Net Name` ATTR records. Port symbol docs use META `docType: 19` (NetPort), power uses `docType: 18` (NetFlag).
- PCB named NET records sit after the empty NET (`["NET",""]`) and before the first PAD_NET.
- Tickets are unique within each document (not globally monotonic).
- Named wires carry a NET attr (client-generated unnamed wires omit it); every LINE references its WIRE via `lineGroup`. Every ATTR head carries an id the client links through `parentId`; every doc DOCHEAD carries the project `client` id.

## Script reference

All scripts accept `--help` and follow the convention `<script> [subcommand] [options]`.

| Script | Purpose |
| --- | --- |
| `scripts/init.js` | Create the project skeleton (index, schematic container, sheet, PCB, panel). |
| `scripts/generate-symbol.js` | Build a schematic SYMBOL from a pin list → temp entry `<dir>/.tmp/library/symbol/<name>.json`. |
| `scripts/generate-footprint.js` | Build a FOOTPRINT from a pad list → temp entry `<dir>/.tmp/library/footprint/<name>.json`. |
| `scripts/load-library.js` | Stage power flags / net ports as temp entries; inspect the two-tier library (`power`/`port`/`list`/`show`/`remove`). |
| `scripts/add-symbol.js` | Unified schematic placement — resolves the entry preset-first and dispatches by kind (symbol/power/port/special); pairs a symbol with a footprint entry and composes the DEVICE doc on the fly. |
| `scripts/add-wire.js` | Draw wires (WIRE + LINE records, optional net). |
| `scripts/add-netlabel.js` | Label the wire under a point with a net name. |
| `scripts/add-text.js` | Place free text on a sheet (TEXT record). |
| `scripts/add-pcb-text.js` | Place text on the PCB (STRING record). |
| `scripts/add-shape.js` | Draw schematic annotation graphics (`rect`/`poly`/`circle`/`ellipse`/`arc`/`bezier`). |
| `scripts/add-footprint.js` | Place a symbol+footprint pair on the PCB, wiring pads to nets (DEVICE doc composed on the fly). |
| `scripts/add-track.js` | Draw a copper track segment on the PCB. |
| `scripts/add-via.js` | Place a via on the PCB. |
| `scripts/add-pcb-shape.js` | Draw PCB graphics (`rect`/`poly`/`circle` → POLY, `arc` → ARC). |
| `scripts/add-pour.js` | Add a copper pour region (POUR record) to the PCB. |
| `scripts/add-fill.js` | Add a static copper fill (FILL record) to the PCB — SOLID style only. |
| `scripts/add-region.js` | Add a keepout/constraint region (REGION record) with `--prohibit "COMPONENT,TRACK"` style rules. |
| `scripts/set-refdes.js` | Rename or auto-renumber reference designators (`set`/`renumber`). |
| `scripts/validate.js` | Check format invariants; exit 1 on errors. |
| `scripts/cleanup.js` | Remove the project's temp staging area (`<dir>/.tmp/`) — run after validation passes. |
| `scripts/open.js` | Launch / locate / register the offline client (`open`/`where`/`set`/`install`). |

The lower-level helpers live in `scripts/lib/` (`eprj3.js`, `frame-a4.js`, `pcb-preamble.js`, `utils.js`). `scripts/tools/split-elibu.js` splits a real-client `.elibu` library export into preset template entries under `templates/library/` (maintainer tool for growing the preset catalog). `scripts/tools/audit-format.js` cross-checks every generated record against the easyeda-pro-format-skill JSON Schemas — run it after changing any record builder:

```bash
node scripts/tools/audit-format.js --format-skill <path-to-easyeda-pro-format-skill>
```

## Output style

- Show only the script invocations and the validator summary.
- Do not narrate the format spec, JSON structure, or "what eprj3 is" to the user unless they ask.
- Use Markdown link syntax for any file references: `[init.js](scripts/init.js)`.
- After step 13, summarize the result as a single line: `<name>.eprj3 at <dir> — N components, M wires, validated, opened in EasyEDA Pro.`

## Known limitations

- The generated files follow the official example byte-pattern closely, but full fidelity is only provable in the real client. If the client refuses to open a project, run `node scripts/validate.js --dir <dir>` first, then compare against [`examples/blink`](examples/blink) (a complete, validated sample project).
- `add-pour` writes the pour region record only — the client recomputes the filled copper (POURED records) when the project is opened. Pour/fill styles are restricted to SOLID, the only mode backed by a real client record. Differential-pair routing, hierarchical multi-sheet navigation, and simulation documents are not authored by these scripts — finish those in the EasyEDA Pro client.
- Sheet TEXT/shape and PCB STRING/VIA record bodies follow the real samples in the easyeda-pro-format-skill repo (`examples/SCH_PAGE`, `examples/PCB`); everything else mirrors official example records. Known schema-vs-example conflicts (e.g. numeric `groupId`, `pourType` object, POUR/FILL `path` nesting) are documented in `scripts/tools/audit-format.js` — real records win in every case.
- The two-tier library: preset templates (`templates/library/`, mostly split from a real-client `.elibu` export) are committed with the skill; temp entries (`<project>/.tmp/library/`) exist only while authoring and are removed by `cleanup.js` — the finished project contains no library metadata. Placing the `special` entries (`DIFF_PAIR`, `SHORT`) and the `A4`/`A3` drawing-frame symbols has not yet been verified against the real client.
