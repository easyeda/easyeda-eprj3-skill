# easyeda-eprj3-skill

[中文](README.md#中文) · bilingual home: [README.md](README.md) · standalone English page · **v1.12.1** · [Changelog](CHANGELOG.md)

An AI-agent skill that turns a one-sentence feature request — or a single `design.json` — into a complete `.eprj3` folder project for **EasyEDA Pro (嘉立创 EDA 专业版)**: a schematic laid out in signal-flow blocks, a **placement-only PCB** (footprints + pad-net links + outline — routing and copper pour are explicit opt-ins via `--route` / `--pour`), and **five automated gates** proving the result before you ever open the client.

All code is self-authored Node CommonJS. **Zero third-party dependencies** — enforced by `node scripts/depcheck.js`, not just promised.

## What makes it different

- **Requirement intake, not guesswork** — a fixed input spec (`docs/intake.md`): required fields (function, input supply) block the build until answered; ask-tier fields come back as one batch of questions, each with its documented fallback; defaults are applied silently but shown so you can veto them.
- **Keyword → recipe selection** — `usb`, `单片机/mcu`, `i2c`, `rs485`, `按键/button`… map onto 15 buildable sub-circuit templates (`recipe/`); merged in signal-flow order with de-duplicated ids.
- **Derived power tree** — a regulator's input lands on the nearest rail *above* its output (12V→buck→5V→LDO→3V3 chains correctly), track widths follow declared current, and a big linear drop prints a heat estimate instead of silently changing your BOM.
- **Human confirmation gates before anything is written** — `build.js --plan` rehearses the real build (true scores) into a throwaway dir; `autofix.js --diff` shows a line diff of every automatic edit first.
- **Placement-first deliverables** — the shipped board is footprints placed by block flow with every pad's net linked; no tracks, no pours. Copper is explicit opt-in: `build.js --route` (2-layer maze router), `--pour` (ground plane + stitching fence), or manual `add-track` / `pour-auto` scripts.
- **Five gates** — format / ERC (E001–E007) / layout lint (L001–L010) / DRC + **DFM** (D001–D012: pad spacing, board edge, min drill, annular ring, silk-on-pad, acute angles — connectivity `D004` and pour `D006` only judged on boards that were actually routed) / design intent (I001–I006: polarity, decoupling, divider ratio, diff pairs). Every finding carries a concrete `fix:` line.
- **Measured, not hoped** — 20-case benchmark (`scripts/eval.js`) tracks seconds and token proxies in `eval/history.jsonl`; a 46-variant legal/illegal corpus (`test/corpus.js`) proves the gates actually catch corruption; `EPRJ3_DETERMINISTIC=1` rebuilds byte-identically for golden-file diffs.

## Install

- [Node.js](https://nodejs.org/) ≥ 18 (verified on Windows 11 + Node 24). **No npm dependencies.**
- EasyEDA Pro / LCEDA Pro **V4.1+** offline client — needed only for the final `open` step.

Clone the repo into your assistant's skill directory (Claude Code shown):

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill .claude/skills/easyeda-eprj3
cd .claude/skills/easyeda-eprj3
npm test        # optional: smoke + pipeline + DFM + corpus + depcheck
```

## AI one-line install prompt

Paste this to your assistant:

> Please install https://github.com/easyeda/easyeda-eprj3-skill into your skill directory (e.g. `.claude/skills/easyeda-eprj3` for Claude Code), verify Node.js ≥ 18, and initialize a sample project.

## How the agent works

Say what the board must do — e.g. *"STM32F103C8T6 minimum system, 3.3 V, USB-serial, one LED, one button, board 50×40 mm, at `D:\boards\stm32-blink`"* — and the agent runs (see [`SKILL.md`](SKILL.md), Step 0 + Fast path):

1. **Intake** — `node scripts/intake.js check --req req.json` (missing required fields come back as exact questions, asked **once**) → `resolve --req req.json --out design.json` (recipe selection, power chain, rail widths, dense boards pre-armed with fine rules for later `--route`).
2. **Confirm** — power scheme, part choices, interface names, board size/layers; `build.js --plan` shows the real rehearsal without writing.
3. **Build** — `node scripts/build.js --design design.json --dir <project>`: schematic auto-layout + auto-wiring + power flags; PCB auto-placement of every footprint with pad↔net links and the board outline; then all five gates. A clean exit *is* the proof. Add `--route` / `--pour` only if the user explicitly wants copper laid down.
4. **Repair loop** — failing codes come with `fix:` lines; mechanical fixes go through `autofix.js --diff` (diff first, then apply).
5. **Preview / open** — `node scripts/render.js` writes SVG previews; `node scripts/open.js` launches the client.

## Report after a build

```
blink.eprj3 at /path — 4 components, 15 wire segments, lint 100/100, drc 100/100 (placed-only).
```

## Documentation

| Need | Read |
| --- | --- |
| The AI entry point / workflow | [`SKILL.md`](SKILL.md) |
| Requirement spec, questions, confirmation gates | [`docs/intake.md`](docs/intake.md) |
| `design.json` contract, PCB rules, router limits | [`docs/build.md`](docs/build.md) |
| Every check code and its fix | [`docs/checks.md`](docs/checks.md) |
| Record-level eprj3 format | [`docs/format-reference.md`](docs/format-reference.md) |
| Legal/illegal corpus maintenance | [`docs/corpus.md`](docs/corpus.md) |
| Manual step-by-step (no design file) | [`docs/workflow.md`](docs/workflow.md) |
| Extending the skill / iteration protocol | [`docs/development.md`](docs/development.md) |
| Per-assistant install guides (20+ tools) | [`install/`](install) |

Examples: [`examples/blink/`](examples/blink) (full project), [`examples/designs/`](examples/designs) (design files), [`examples/intake/`](examples/intake) (requirement forms).

## License

MIT — see [LICENSE](LICENSE).
