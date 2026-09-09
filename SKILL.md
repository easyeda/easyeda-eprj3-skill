---
name: easyeda-eprj3
description: Create and edit EasyEDA Pro folder-based .eprj3 PCB projects. Use this skill whenever the user wants to author a schematic/PCB in EasyEDA Pro offline-client format from AI prompts, ingest an EasyEDA library (.elibz2), or run validation. Drives the Node.js scripts under scripts/.
---

# EasyEDA Pro eprj3 Project Skill

This skill teaches any coding agent to author **EasyEDA Pro** (嘉立创EDA专业版) projects in the folder-based `.eprj3` format. The format spec is documented in [`docs/format-reference.md`](docs/format-reference.md) and tracked at https://github.com/easyeda/easyeda-pro-eprj3-format.

## When to invoke

Trigger this skill when the user wants any of the following:

- Create a new `.eprj3` project (schematic + optional PCB) from scratch.
- Import symbols / footprints from a local **EasyEDA library** (`.elibz2`).
- Validate the format of an existing `.eprj3` directory.
- Open the resulting project in the EasyEDA Pro (or LCEDA Pro / 嘉立创EDA专业版) offline client.

KiCad → eprj3 conversion is out of scope for this skill — it lives in the separate **kicad-to-easyeda-eprj3** project. Do not invoke this skill for it.

Do not invoke it for the legacy single-file `.eprj`/`.eprj2` SQLite format — that is not supported.

## Required user inputs

Ask the user the following before writing any file. Stop and ask again if a key piece is missing — do not invent values.

1. **Project storage path** (absolute, must be writable, no existing `.eprj3` there).
2. **Project name** (defaults to the folder basename).
3. **Schematic requirements** — components, nets, net labels, power symbols, sheet count.
4. **Whether to create a PCB** (`--with-pcb`). If yes, ask for board outline, layer count, copper pours, traces.
5. **Library source**:
   - If the user provides a path to a `.elibz2` file/directory, **use it**.
   - If the user does not, **auto-generate** minimal symbols / footprints via `generate-symbol.js` / `generate-footprint.js`.

Always confirm the resolved path/name before running `init.js`.

## Standard workflow

**Path note:** every `node scripts/...` invocation below is relative to **this skill's repository root** (the directory containing SKILL.md) — not the user's project directory. `cd` into the skill directory or use absolute paths. The `docs/` links are relative to the same directory.

Run these steps in order. The first three are mandatory; the rest depend on what the user wants.

```
1.  Resolve paths & project name              (AskUserQuestion)
2.  node scripts/init.js init --dir <dir> --name <name> [--with-schematic <s> --with-pcb]
3.  Decide on library source                  (AskUserQuestion)
4a. (Local lib)  node scripts/load-library.js import --dir <dir> --format elibz2 --library <path> --component <name>
4b. (Auto gen)   node scripts/generate-symbol.js from-pins --dir <dir> --name <sym> --pins "1,A,2,B" ...
                 node scripts/generate-footprint.js from-pads --dir <dir> --name 0603 --pads "1,-31.5,0,rect,24,16;2,31.5,0,rect,24,16" --silk "rect,-32,-8,32,8"
5.  node scripts/add-symbol.js add ...        (place each component)
6.  node scripts/add-wire.js add ...          (wire segments)
7.  node scripts/add-netlabel.js add ...      (VCC/GND labels)
8.  node scripts/set-refdes.js renumber ...   (auto number R*, C*, U*, D*)
9.  node scripts/validate.js check --dir <dir> [--fix]   (always run this)
10. If validation warns/errors, fix and re-run until clean.
11. node scripts/open.js open --dir <dir>     (launch EasyEDA Pro / LCEDA Pro offline client)
```

Steps 9–10 are a loop: run, fix, run, fix — until the validator reports `0 errors, 0 warnings` (or the user accepts the warnings in `--strict` mode).

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

## What every eprj3 project must contain

- `<dir>/<name>.eprj3`            — project index (JSON)
- `<dir>/sch/<schematic>/<sheet>.esch2` — schematic source
- `<dir>/sch/<schematic>/<schematic>.ecfg` — empty file is fine
- `<dir>/sch/<schematic>/<schematic>.evar` — empty file is fine
- `<dir>/pcb/<pcb>.epcb2`         — PCB source (only when --with-pcb)
- `<dir>/sch/__symbols__/*.esch2` — embedded symbol definitions (auto-managed)
- `<dir>/sch/__footprints__/*.esch2` — embedded footprint definitions (auto-managed)

## Script reference

All scripts accept `--help` and follow the convention `<command> [options]`. The full list is also wired up in `package.json` (`npm run add-symbol`, etc.).

| Script | Purpose |
| --- | --- |
| `scripts/init.js` | Create an empty project skeleton. |
| `scripts/generate-symbol.js` | Build a symbol from a pin list. |
| `scripts/generate-footprint.js` | Build a footprint from a pad list. |
| `scripts/load-library.js` | Pull a component out of an `.elibz2` library. |
| `scripts/add-symbol.js` | Place a COMPONENT on a schematic sheet. |
| `scripts/add-footprint.js` | Place a footprint on a PCB document. |
| `scripts/add-wire.js` | Draw a polyline wire (WIRE + LINEs). |
| `scripts/add-netlabel.js` | Drop a NETLABEL. |
| `scripts/add-port.js` | Drop a PORT (sheet connector). |
| `scripts/add-text.js` | Free TEXT annotation. |
| `scripts/set-refdes.js` | Rename a single refdes, or auto-renumber by prefix. |
| `scripts/validate.js` | Check format integrity, optionally auto-fix. |
| `scripts/open.js` | Launch the EasyEDA Pro (`C:\Program Files\easyeda-pro\easyeda-pro.exe`) or LCEDA Pro (`C:\Program Files\lceda-pro\lceda-pro.exe`) offline client. |

The lower-level helpers live in `scripts/lib/` (`eprj3.js`, `elibz2.js`, `utils.js`).

## Output style

- Show only the script invocations and the validator summary.
- Do not narrate the format spec, JSON structure, or "what eprj3 is" to the user unless they ask.
- Use Markdown link syntax for any file references: `[init.js](scripts/init.js)`.
- After step 11, summarize the result as a single line: `<name>.eprj3 at <dir> — N components, M wires, validated, opened in EasyEDA Pro.`

## Known limitations

- eprj3 is still evolving. Anything the validator cannot guarantee (copper pours, differential-pair routing, hierarchical sheet navigation) needs the EasyEDA Pro client to finalize.
- `load-library.js` needs the `yauzl` package for zip-based `.elibz2` archives. It is declared as an `optionalDependency` — running `npm install` inside the skill directory pulls it in automatically. If zip support is still missing, run `npm install yauzl --no-save`.