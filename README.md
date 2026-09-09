# easyeda-eprj3-skill

An AI-agent skill that teaches any coding assistant (Claude Code, Codex, Cursor, Copilot, Continue, Cline, Roo, Windsurf, Trae, Qoder, etc.) to author **EasyEDA Pro** (嘉立创EDA专业版) projects in the folder-based `.eprj3` format.

The skill ships a complete set of cross-platform Node.js scripts so the AI can:

- Bootstrap a new `.eprj3` project
- Generate symbols / footprints from scratch
- Place components, wires, net labels, ports, text
- Renumber reference designators
- Import symbols and footprints from a local **EasyEDA library** (`.elibz2`)
- Validate the format and auto-fix common problems
- Open the finished project in the **EasyEDA Pro / LCEDA Pro offline client**

KiCad → eprj3 conversion is intentionally out of scope — it lives in the separate **kicad-to-easyeda-eprj3** project.

The format spec is documented in [`docs/format-reference.md`](docs/format-reference.md). The authoritative source is https://github.com/easyeda/easyeda-pro-eprj3-format.

## Repository layout

```
easyeda-eprj3-skill/
├── SKILL.md               ← AI agent entry point — read this first
├── README.md              ← You are here
├── package.json
├── scripts/
│   ├── init.js
│   ├── generate-symbol.js
│   ├── generate-footprint.js
│   ├── load-library.js
│   ├── add-symbol.js
│   ├── add-footprint.js
│   ├── add-wire.js
│   ├── add-netlabel.js
│   ├── add-port.js
│   ├── add-text.js
│   ├── set-refdes.js
│   ├── validate.js
│   ├── open.js
│   └── lib/               ← shared record parser / writer modules
├── install/               ← per-agent install guides
├── docs/
│   ├── format-reference.md
│   └── workflow.md
├── examples/
│   └── blink/             ← minimal LED + resistor project
└── templates/             ← minimal blank-project seed files
```

## Quick start (humans)

```bash
git clone https://github.com/easyeda/easyeda-eprj3-skill
cd easyeda-eprj3-skill

# 1) Bootstrap a project
node scripts/init.js init --dir ./myboard --name myboard \
  --with-schematic Schematic1 --with-pcb

# 2) Generate a 0603 resistor footprint and a basic symbol
node scripts/generate-symbol.js    from-pins   --dir ./myboard --name RES --pins "1,1,2,2"
node scripts/generate-footprint.js from-pads   --dir ./myboard --name 0603 \
  --pads "1,-31.5,0,rect,24,16;2,31.5,0,rect,24,16" --silk "rect,-32,-8,32,8"

# 3) Place components / wires / labels via add-*.js
node scripts/add-symbol.js  add --dir ./myboard --schematic Schematic1 --sheet P1 --symbol RES --refdes R1 --x 100 --y 100 --footprint 0603
node scripts/add-wire.js    add --dir ./myboard --schematic Schematic1 --sheet P1 --points "100,100;200,100"

# 4) Validate
node scripts/validate.js check --dir ./myboard --strict

# 5) Open in EasyEDA Pro
node scripts/open.js open --dir ./myboard
```

## Quick start (AI agents)

Read [`SKILL.md`](SKILL.md). It defines the workflow, the required user inputs, and which scripts to run in which order. The skill is also packaged with installation guides for every common agent — see [`install/`](install/README.md).

## Requirements

- Node.js ≥ 18 (tested on Node 24 on Windows 11).
- Run `npm install` in this directory once — it pulls in `yauzl` (optional dep, only needed for `.elibz2` zip archives).
- EasyEDA Pro or LCEDA Pro offline client (only required for the `open.js` step). Both clients share the same `.eprj3` format. The default Windows install puts `easyeda-pro.exe` under `C:\Program Files\easyeda-pro\` (English brand) and `lceda-pro.exe` under `C:\Program Files\lceda-pro\` (Chinese brand). The installer lets the user pick any other path — see [`scripts/open.js`](scripts/open.js) for the probe list and the `set --client <path>` override.

## License

MIT. See [`LICENSE`](LICENSE).