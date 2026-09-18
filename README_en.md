# easyeda-eprj3-skill

> Generate `.eprj3` projects for EasyEDA Pro with AI or a few Node commands.

[中文版](README.md) · **Current version: 1.7.3** · [Changelog](CHANGELOG.md)

---

## One-line AI install prompt

Send this to your AI agent:

> AI agent, please install easyeda-eprj3-skill from https://github.com/easyeda/easyeda-eprj3-skill and https://github.com/easyeda/easyeda-pro-format-skill into my AI agent's skill directory (e.g. `.claude/skills/easyeda-eprj3`), make sure Node.js ≥ 18, and initialize a sample project.

## Install

- [Node.js](https://nodejs.org/) ≥ 18 (tested on Windows 11 + Node 24). **No npm dependencies**.
- EasyEDA Pro / LCEDA Pro offline client **V4.1+** (only needed for the final `open` step).

Clone the repo into your AI agent's skill directory (Claude Code example below):

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill .claude/skills/easyeda-eprj3
cd .claude/skills/easyeda-eprj3
npm test            # optional: run the full regression suite
```

> **Where to put it?** This skill should live in your AI agent's skill directory so it can auto-load `SKILL.md`. For Claude Code use `.claude/skills/easyeda-eprj3`; for Cursor, Copilot, and others see [`install/`](install/README.md). All scripts use `--dir <your-project-dir>` to specify the target project; replace `./myboard` in the examples with your real project path.

> Rather not type commands? Copy this page to your AI and let it install, initialize, and run the next steps for you.

## Quick start

This skill is meant to be used through your AI agent. You don't need to remember the script names — just describe your schematic/PCB needs in natural language and the AI will call the right scripts following [`SKILL.md`](SKILL.md).

### 1. Install

See [Install](#install) above. In short: Node.js ≥ 18, clone into your AI agent's skill directory.

### 2. Describe your needs to the AI

For example:

> I want to design a minimal STM32F103C8T6 system, 3.3V supply, with a USB-to-UART, one LED, and one button. Put the project in `D:\boards\stm32-blink`, board size 50mm x 40mm.

The AI will ask for missing details (part numbers, pin names, net names, connections) and then generate the project.

### 3. AI internal workflow

The AI runs these steps automatically:

1. `init.js` creates the `.eprj3` project (schematic + PCB)
2. `load-library.js list` checks the preset library
3. `add-symbol.js` places symbols, power flags, and ports
4. `add-wire.js` / `add-netlabel.js` wires and labels nets
5. `set-refdes.js` renumbers reference designators
6. `add-footprint.js` / `add-track.js` / `add-via.js` / `add-pour.js` does PCB layout and routing
7. `validate.js` checks the format
8. `open.js` opens the project in the EasyEDA Pro client

You don't run these commands yourself.

### 4. Review

When done, the AI reports:

- Project path: `<your-dir>/<name>.eprj3`
- Schematic: component / net / label counts
- PCB: footprint / track / via / pour counts
- Validation result: 0 errors
- Whether the client was opened

Just inspect and tweak in EasyEDA Pro.

> Full examples are in [`examples/blink/`](examples/blink); per-agent skill setup is in [`install/`](install/README.md).

## Development / advanced reference

Developers or users who want to run scripts manually, see the repository layout, or extend the skill should read [`docs/development.md`](docs/development.md).
