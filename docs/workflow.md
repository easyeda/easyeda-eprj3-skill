# Workflow

A compact step-by-step for **incrementally editing an existing project** (record-level operations that preserve copper and placement you want to keep). For a full authored build from `design.json`, follow [`SKILL.md`](../SKILL.md) and [`ai-layout.md`](ai-layout.md) instead — this document does not describe that path.

Coordinate systems: schematic sheet records are **Y-up, 1 unit = 10 mil** (A4 frame 1170×825 units, origin bottom-left); PCB records are **mil, Y-up**. Do not mix the scales.

## 0. Format reference (recommended, not a gate)

When hand-editing or validating unusual records, consult the companion **easyeda-format** repo (https://github.com/easyeda/easyeda-format-skill — per-record field tables under `primitives/`, real samples under `examples/`, schemas under `schemas/`; ground truth: https://github.com/easyeda/easyeda-eprj3-format). Where this skill's docs, a schema, and a real record disagree, the real record wins. Cross-check mechanically when a copy is available:

```bash
node scripts/tools/audit-format.js --format-skill <path-to-easyeda-format-skill>
```

Unlike earlier versions this is NOT a hard stop: `validate.js` + the gates catch malformed records on their own.

## 1. Discover

Ask the user:

1. **Storage path** (absolute, no existing `.eprj3`).
2. **Project name** (defaults to folder basename).
3. **Schematic requirements**: components (pin numbers/names), nets, net labels, power symbols, net ports, free text, graphic annotations, sheet count.
4. **PCB requirements**: board outline, layer stack, mechanical keepouts, electrical and manufacturing constraints, and silkscreen. The AI authors exact placement, tracks, vias, and any requested copper-region boundaries; EasyEDA Pro fills the specified regions and verifies the resulting board.
5. **Component geometry**: pin/pad specs per part (from the datasheet). There is no `.elibz2` import — the scripts generate symbols/footprints from specs.

Refuse to start until the answers are concrete.

## 2. Bootstrap

```bash
node scripts/init.js --dir <dir> --name <name> \
  [--schematic Schematic1] [--sheet P1] [--pcb PCB1] [--panel] \
  [--board-w 4000] [--board-h 3000]
```

Creates the index, the schematic container (`.ecfg`/`.evar`), the first sheet document and the PCB document in one shot. The panel is optional — only add `--panel` when the user asks for one. `--board-w/--board-h` size the board outline in mil (default 4000×3000, covering `0..w × 0..h`).

## 3. Library: presets first, then temp staging

The skill ships a **preset template library** at `templates/library/{symbol,footprint}/` (committed with the skill — `RES` `CAP` `IND` `DIODE` `LED` `TEST_POINT`, power flags `GND` `5V` `VCC`, net ports `PORT_IN/OUT/BI`, footprints `R0402/R0603` `C0402/C0603` `L0402/L0603` `LED0603` `SMA` `TP0.5`). Every placement resolves presets FIRST, so common parts need no staging at all:

```bash
node scripts/load-library.js list        # preset catalog; add --dir to include project staging
node scripts/load-library.js show --name RES
```

No preset fits? Stage a **temp entry** under `<project>/.tmp/library/` (tooling metadata — the client never reads it; deleted by `cleanup.js` at the end). Temp names must not shadow a preset:

```bash
node scripts/generate-symbol.js from-pins --dir <dir> --name <sym> \
  --designator R --pins "1;2" [--pitch 10]
# pin spec, ';'-separated items — ALL auto ("num" | "num:name") or ALL
# explicit ("num:name:x:y:rotation", rotation 0 = left / 180 = right column):
# auto-layout gives two columns at x=±20, pin length 10; pitch defaults to
# 30 mil for 3+ pins (10 for 1–2), override with --pitch;
# the body rect always derives from the resulting pin geometry

node scripts/generate-footprint.js from-pads --dir <dir> --name <fp> \
  --designator R \
  --pads "1:-16.54:0:31.5:35.43;2:16.54:0:31.5:35.43" \
  --outline "R,-27.56,-19.69,55.12,39.37" \
  --silk "rect,-27.56,-19.69,27.56,19.69"    # or path,x1,y1,x2,y2,...
# pads spec item: num:x:y:w:h[:holeDiameter] — a drill diameter makes the pad
# through-hole: ROUND hole + ELLIPSE copper on the MULTI layer (official shape)

node scripts/load-library.js power --dir <dir> --net <NET> [--style up|down]
node scripts/load-library.js port  --dir <dir> --net SIG [--name <entry>]
```

Inspect or prune with `load-library.js list|show|remove` (`remove` only deletes temp entries — presets are committed with the skill).

## 4. Place on schematic

Before choosing any coordinate, partition the design into **functional module blocks** (power input, core IC, interface, …) laid out along the signal flow (inputs left/top → outputs right), and enclose every block with an annotation rect + title text (`add-shape rect`, `add-text`). Blocks stay coarse — 2–8 components each, decoupling caps with their IC — with ≥150 mil gutters between them.

`add-symbol.js` is the unified placement entry — it resolves the entry preset-first, then dispatches by kind (`symbol` → component block, `power` → power flag, `port` → net port):

```bash
node scripts/add-symbol.js --dir <dir> --sch Schematic1 --sheet P1 \
  --symbol RES --footprint R0603 --x 300 --y -440 --rotation 90 [--refdes R1] [--name <device title>]
node scripts/add-symbol.js --dir <dir> --sch Schematic1 --sheet P1 \
  --symbol VCC --x 300 --y -500
node scripts/add-symbol.js --dir <dir> --sch Schematic1 --sheet P1 \
  --symbol PORT_IN --x 460 --y -440
```

`--footprint` pairs the symbol with a footprint entry (preset or temp) and the DEVICE doc is composed on the fly — there is no device staging. Each placement embeds the needed SYMBOL/DEVICE docs into the sheet file, so the sheet is self-contained. Power symbols and ports are special devices: the placed COMPONENT carries `DeviceName: null` and the net name lives in `Name` / `Global Net Name` ATTR records.

Coordinates: sheet records are **Y-up, 1 unit = 10 mil** (the A4 frame is 1170×825 units; origin bottom-left — positive Y is UP the page), PCB is mil Y-up. A wire touches a pin only at **exact coordinate equality** — the pin record's `(x, y)` IS the connection point (the client's hotspot): RES/CAP/DIODE/LED presets connect at `(±20, 0)` in sheet units rotated by the placement rotation; power flags/ports at their origin. The pin's drawn line runs from the hotspot inward toward the body. Read exact tips with `node scripts/pins.js --dir <dir>` or `build.js --geometry` (`sheetAt`). Keep row pitch ≥200 mil so Designator/Name labels don't collide.

## 5. Annotate (text & graphics)

```bash
node scripts/add-text.js --dir <dir> --sch Schematic1 --sheet P1 \
  --value "5V rail" --x 300 --y -300 [--size 10] [--rotation 90]
node scripts/add-shape.js rect --dir <dir> --sch Schematic1 --sheet P1 \
  --x1 200 --y1 -200 --x2 400 --y2 -300 [--radius 0]
node scripts/add-shape.js poly --dir <dir> --sch Schematic1 --sheet P1 \
  --pts "200,-200,300,-100,400,-200" [--closed]
node scripts/add-shape.js circle   --dir <dir> --sch Schematic1 --sheet P1 --cx 300 --cy -250 --r 50
node scripts/add-shape.js ellipse  --dir <dir> --sch Schematic1 --sheet P1 --cx 300 --cy -250 --rx 80 --ry 40
node scripts/add-shape.js arc      --dir <dir> --sch Schematic1 --sheet P1 \
  --start 200,-200 --mid 300,-300 --end 400,-200
node scripts/add-shape.js bezier   --dir <dir> --sch Schematic1 --sheet P1 \
  --pts "200,-200,250,-100,350,-100,400,-200"
```

These are non-electrical annotations — they carry no connectivity (use wires for that). `arc` takes three points: start, a point the arc passes through, and end.

## 6. Wire it up

Inspect the exact pin tips with `node scripts/pins.js --dir <dir>` and author each segment. The wire command does not compute a path between pins.

```bash
node scripts/add-wire.js --dir <dir> --sch Schematic1 --sheet P1 \
  --segs "300,-420,300,-380" [--net SIG]
node scripts/add-netlabel.js --dir <dir> --sch Schematic1 --sheet P1 \
  --net SIG --at 300,-400
```

`--net` both names the wire and creates the net. `add-netlabel` finds the wire under the point (must match exactly one) and writes its NET attr — creating one if the wire was drawn unlabeled.

Wiring rules (readability): nearby pins are joined by **visible wires**, not labels — a pin fanning directly into net labels is the anti-pattern. Use a label only for far-apart same-sheet links, and then only after a wire stub (≥30 mil) out of the pin; cross-sheet links go through ports/off-page connectors; power rails through power flags. Segments stay orthogonal, endpoints on the 10 mil grid, and if a route would cross another block, fix the placement instead of the wire. Net names are meaningful UPPERCASE (`SPI_CLK`), never `N$1`.

## 7. Renumber

```bash
node scripts/set-refdes.js renumber --dir <dir> --sch Schematic1 --sheet P1 --prefix R
node scripts/set-refdes.js set --dir <dir> --sch Schematic1 --sheet P1 \
  --designator R1 --value R5
```

Both commands act on the single sheet or PCB document passed (`--sch/--sheet` or `--pcb`); with multiple sheets, renumber each one and keep prefixes globally unique yourself.

## 8. PCB placement and routing

Determine mechanical and electrical constraints, then author explicit coordinates, tracks and vias as described in [AI layout](ai-layout.md). On an existing board, use targeted editor operations when untouched tracks or positions must be preserved. Verify the resulting copper and fill in EasyEDA Pro.

## 9. Validate (loop)

```bash
node scripts/validate.js --dir <dir>
```

Exit code 0 = clean. The validator checks index shape, container structure, doc uuid/ticket uniqueness, Device/Symbol/Footprint reference integrity, wire/net linkage, and PCB pad/net references. Fix the reported records with the appropriate script and re-run — do not hand-edit records unless you have read [`format-reference.md`](format-reference.md).

## 10. Clean up

```bash
node scripts/cleanup.js --dir <dir>
```

Deletes `<dir>/.tmp/` — the temp library entries staged during authoring. The finished project is self-contained (docs are embedded in the containers) and the preset templates stay in the skill, so nothing references `.tmp/` afterwards. Silent when there is nothing to remove.

## 11. Open

```bash
node scripts/open.js open --dir <dir>
```

By default this hands the `.eprj3` file to the **OS file association** — exactly
what double-clicking the project file does, so it works whenever the client is
installed and registered. No client-path search is involved.

To launch a specific executable instead (skipping the association), the user can:

- Pass `--client <path-to-easyeda-pro.exe|lceda-pro.exe>` (when given, the
  script launches that exe directly and reports the search list if it is missing), or
- `node scripts/open.js set --client <path> --dir <dir>` to persist the path in `<dir>/.easyeda-pro-client.json`, or
- Set `EASYEDA_PRO_CLIENT` env var (user-wide).

Both English (`easyeda-pro`) and Chinese (`lceda-pro`) brand executables are recognized.

## 12. Hand off

Tell the user:

```
<name>.eprj3 at <dir>
  - <N> schematic components + power symbols / ports
  - <M> wires / net labels, annotations
  - <K> PCB footprints, explicit tracks and vias, and routed DRC findings
  - Validated (0 errors, 0 warnings)
  - Opened in EasyEDA Pro
```
