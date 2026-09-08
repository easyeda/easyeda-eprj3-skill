# Workflow

A compact step-by-step the AI agent follows for each user request. The full machine-readable flow is in [`SKILL.md`](../SKILL.md).

## 1. Discover

Ask the user:

1. **Storage path** (absolute, no existing `.eprj3`).
2. **Project name** (defaults to folder basename).
3. **Schematic requirements**: components, nets, net labels, power symbols, sheet count.
4. **PCB?** — yes/no. If yes, ask for board outline, layer count, copper pours, traces.
5. **Library source**:
   - Path to a local `.elibz2` (file/dir)?
   - Path to a local KiCad library (`*.kicad_sym`)?
   - Or **auto-generate** from a pin/pad spec.

Refuse to start until all five answers are concrete.

## 2. Bootstrap

```bash
node scripts/init.js init --dir <dir> --name <name> \
  [--with-schematic <schName>] [--with-pcb]
```

The directory layout, project index, schematic config/variant files, and (if requested) the PCB document are all created in one shot.

## 3. Populate library

For each component the user mentioned, run either:

```bash
# From local EasyEDA library
node scripts/load-library.js import --dir <dir> \
  --format elibz2 --library <path> --component <name>

# From local KiCad library
node scripts/load-library.js import --dir <dir> \
  --format kicad --library <path> --component <name>

# Auto-generate
node scripts/generate-symbol.js from-pins --dir <dir> \
  --name <sym> --pins "1,A,2,B,3,VCC" --bbox-w 60 --bbox-h 30
node scripts/generate-footprint.js from-pads --dir <dir> \
  --name 0603 --pads "1,-31.5,0,rect,24,16;2,31.5,0,rect,24,16" \
  --silk "rect,-32,-8,32,8"
```

## 4. Place on schematic

```bash
node scripts/add-symbol.js add --dir <dir> --schematic <s> --sheet P1 \
  --symbol <sym> --refdes R1 --value "10k" --x 100 --y 100 --footprint 0603
```

Do this for every component. Use a 100-mil grid for the first prototype, then refine spacing.

## 5. Wire it up

```bash
node scripts/add-wire.js add --dir <dir> --schematic <s> --sheet P1 \
  --points "100,100;200,100;200,200"
node scripts/add-netlabel.js add --dir <dir> --schematic <s> --sheet P1 \
  --name VCC --x 100 --y 100
```

## 6. Renumber

```bash
node scripts/set-refdes.js renumber --dir <dir> --schematic <s> --sheet P1 --prefix R
node scripts/set-refdes.js renumber --dir <dir> --schematic <s> --sheet P1 --prefix C
node scripts/set-refdes.js renumber --dir <dir> --schematic <s> --sheet P1 --prefix U
```

## 7. PCB placement (only if --with-pcb)

```bash
node scripts/add-footprint.js add --dir <dir> --pcb <pcbName> \
  --footprint 0603 --refdes R1 --x 0 --y 0
```

Footprint placement follows the schematic refdes. Make a layout pass before generating copper.

## 8. Validate (loop)

```bash
node scripts/validate.js check --dir <dir> --strict
```

If the validator emits warnings or errors, **read them, fix the offending records with the appropriate `add-*` / `set-refdes` script, and re-run**. Do not move on until the result reads `0 errors, 0 warnings`.

The `--fix` flag auto-removes orphan `WIRE` records. Use it only after you have inspected the warnings — it does not understand intent.

## 9. Open

```bash
node scripts/open.js open --dir <dir>
```

If `open.js` cannot find the client, the script lists every location it searched. The user can either:

- Pass `--client <path-to-easyeda-pro.exe|lceda-pro.exe>` for a one-shot override, or
- `node scripts/open.js set --client <path> --dir <dir>` to persist the path in `<dir>/.easyeda-pro-client.json`, or
- Set `EASYEDA_PRO_CLIENT` env var (user-wide).

Both English (`easyeda-pro`) and Chinese (`lceda-pro`) brand executables are recognized.

## 10. Hand off

Tell the user:

```
<name>.eprj3 at <dir>
  - <N> schematic components
  - <M> wires / net labels
  - <K> PCB footprints
  - Validated (0 errors, 0 warnings)
  - Opened in EasyEDA Pro
```