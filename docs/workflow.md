# Workflow

A compact step-by-step the AI agent follows for each user request. The full machine-readable flow is in [`SKILL.md`](../SKILL.md).

All coordinates are **mil** unless a script's help says otherwise.

## 1. Discover

Ask the user:

1. **Storage path** (absolute, no existing `.eprj3`).
2. **Project name** (defaults to folder basename).
3. **Schematic requirements**: components (pin numbers/names), nets, net labels, power symbols, net ports, free text, graphic annotations, sheet count.
4. **PCB requirements**: board outline size, placement, pad-to-net map, tracks, vias, copper pours, silkscreen text.
5. **Component geometry**: pin/pad specs per part (from the datasheet). There is no `.elibz2` import — the scripts generate symbols/footprints from specs.

Refuse to start until the answers are concrete.

## 2. Bootstrap

```bash
node scripts/init.js --dir <dir> --name <name> \
  [--schematic Schematic1] [--sheet P1] [--pcb PCB1]
```

Creates the index, the schematic container (`.ecfg`/`.evar`), the first sheet document, the PCB document, and the panel in one shot.

## 3. Stage the library

Entries are staged as JSON under `<project>/library/<name>.json` (tooling metadata — the client never reads it). For each part:

```bash
node scripts/generate-symbol.js from-pins --dir <dir> --name RES \
  --title Resistor --designator R --tags "电阻,R" --pins "1;2"
# pin spec: "num" | "num:name" | "num:name:x:y:rotation" ; ';' separated
# auto-layout: two columns at x=±20, pin length 10, pitch 10

node scripts/generate-footprint.js from-pads --dir <dir> --name FP0402 \
  --title R0402 --designator R \
  --pads "1:-16.54:0:31.5:35.43;2:16.54:0:31.5:35.43" \
  --outline "R,-27.56,-19.69,55.12,39.37" \
  --silk "rect,-27.56,-19.69,27.56,19.69"    # or path,x1,y1,x2,y2,...

node scripts/load-library.js device --dir <dir> --symbol RES --footprint FP0402 \
  --name R0402 --title R0402
```

Power symbols are their own kind (special device without a designator):

```bash
node scripts/load-library.js power --dir <dir> --net VCC            # arrow up
node scripts/load-library.js power --dir <dir> --net GND --style down
node scripts/load-library.js port  --dir <dir> --net SIG            # net port flag
```

Inspect or prune the staging area with `load-library.js list|show|remove`.

## 4. Place on schematic

```bash
node scripts/add-symbol.js --dir <dir> --sch Schematic1 --sheet P1 \
  --lib R0402 --x 300 --y -440 --rotation 90 [--refdes R1]
node scripts/add-power.js  --dir <dir> --sch Schematic1 --sheet P1 \
  --lib VCC --x 300 --y -500
node scripts/add-port.js   --dir <dir> --sch Schematic1 --sheet P1 \
  --lib PORT_SIG --x 460 --y -440
```

Each placement embeds the needed SYMBOL/DEVICE docs into the sheet file, so the sheet is self-contained. Power symbols and ports are special devices: the placed COMPONENT carries `DeviceName: null` and the net name lives in `Name` / `Global Net Name` ATTR records.

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

```bash
node scripts/add-wire.js --dir <dir> --sch Schematic1 --sheet P1 \
  --segs "300,-420,300,-380" [--net SIG]
node scripts/add-netlabel.js --dir <dir> --sch Schematic1 --sheet P1 \
  --net SIG --at 300,-400
```

`--net` both names the wire and creates the net. `add-netlabel` finds the wire under the point (must match exactly one) and writes its NET attr.

## 7. Renumber

```bash
node scripts/set-refdes.js renumber --dir <dir> --sch Schematic1 --sheet P1 --prefix R
node scripts/set-refdes.js set --dir <dir> --sch Schematic1 --sheet P1 \
  --designator R1 --value R5
```

## 8. PCB placement and routing

```bash
node scripts/add-footprint.js --dir <dir> --pcb PCB1 --lib R0402 \
  --x 300 --y 300 --angle 90 --refdes R1 --nets "1:VCC,2:SIG"
node scripts/add-track.js --dir <dir> --pcb PCB1 --net SIG \
  --x1 300 --y1 316.54 --x2 450 --y2 316.54 --layer 1 --width 10
node scripts/add-via.js --dir <dir> --pcb PCB1 --x 700 --y 316.54 [--net SIG]
```

PCB graphics and pours:

```bash
node scripts/add-pcb-shape.js rect   --dir <dir> --pcb PCB1 --x 500 --y 500 --w 400 --h 300 [--layer 1]
node scripts/add-pcb-shape.js poly   --dir <dir> --pcb PCB1 --pts "500,500,900,500,700,800" [--closed]
node scripts/add-pcb-shape.js circle --dir <dir> --pcb PCB1 --cx 700 --cy 650 --r 100
node scripts/add-pcb-shape.js arc    --dir <dir> --pcb PCB1 \
  --x1 500 --y1 500 --x2 900 --y2 500 --angle 90
node scripts/add-pour.js rect --dir <dir> --pcb PCB1 --net GND \
  --x 100 --y 100 --w 3800 --h 2800 [--layer 1] [--style SOLID|GRID]
node scripts/add-pour.js poly --dir <dir> --pcb PCB1 --net GND \
  --pts "100,100,3900,100,3900,2900,100,2900" [--name POUR1]
node scripts/add-pcb-text.js --dir <dir> --pcb PCB1 --value "REV A" \
  --x 2000 --y 2800 [--layer 1] [--origin 4] [--angle 0]
```

Static fill, keepout region and primitive properties:

```bash
node scripts/add-fill.js rect --dir <dir> --pcb PCB1 [--net GND] \
  --x 100 --y 100 --w 400 --h 300            # or: poly --pts "..."
node scripts/add-region.js rect --dir <dir> --pcb PCB1 --prohibit "2,5" \
  --x 200 --y 200 --w 300 --h 200 [--name KEEP1]   # or: poly --pts "..."
node scripts/add-prop.js --dir <dir> --pcb PCB1 (--target <record-id>|--last) --color "#FF0000"
```

`--prohibit` ids: 2 component, 3 via, 5 track, 6 fill, 7 pour, 8 inner plane (1/4 deprecated and rejected). PROP's record id is the target primitive's id; the body currently carries only color.

`add-pour` writes the POUR region record; the client recomputes the filled copper when the file opens. PCB shape arcs use a signed sweep angle (CCW positive).

`--nets num:NAME` maps pad numbers to net names and creates the NET records. Keep the pad geometry in mind when routing: a 0402 pad at footprint x=-16.54 lands at page x = `300 + (-16.54)·cos(90°) - 0·sin(90°)` style transforms — the blink example routes pad 1 of R1 (x=300, pad row y=316.54) to D1 pad 2 (y=283.46).

## 9. Validate (loop)

```bash
node scripts/validate.js --dir <dir>
```

Exit code 0 = clean. The validator checks index shape, container structure, doc uuid/ticket uniqueness, Device/Symbol/Footprint reference integrity, wire/net linkage, and PCB pad/net references. Fix the reported records with the appropriate script and re-run — do not hand-edit records unless you have read [`format-reference.md`](format-reference.md).

## 10. Open

```bash
node scripts/open.js open --dir <dir>
```

If `open.js` cannot find the client, the script lists every location it searched. The user can either:

- Pass `--client <path-to-easyeda-pro.exe|lceda-pro.exe>` for a one-shot override, or
- `node scripts/open.js set --client <path> --dir <dir>` to persist the path in `<dir>/.easyeda-pro-client.json`, or
- Set `EASYEDA_PRO_CLIENT` env var (user-wide).

Both English (`easyeda-pro`) and Chinese (`lceda-pro`) brand executables are recognized.

## 11. Hand off

Tell the user:

```
<name>.eprj3 at <dir>
  - <N> schematic components + power symbols / ports
  - <M> wires / net labels, annotations
  - <K> PCB footprints, <T> tracks, vias, pours
  - Validated (0 errors, 0 warnings)
  - Opened in EasyEDA Pro
```
