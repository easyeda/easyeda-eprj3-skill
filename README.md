# easyeda-eprj3-skill

**English** · [中文](#中文) · **v1.29.0** · [Changelog](CHANGELOG.md)

---

## English

> Generate `.eprj3` projects that open directly in EasyEDA Pro (嘉立创 EDA 专业版) — from a one-sentence feature request via your AI assistant, or from a few Node commands.

An AI-agent skill that turns a feature request — or a single `design.json` — into a complete `.eprj3` folder project: a schematic laid out in signal-flow blocks with every net wired, a **placement-only PCB** (footprints + pad↔net links + board outline — this skill **never routes and never pours**; tracks, vias and copper are finished by you in the EasyEDA Pro client), and **five automated gates** proving the result before you ever open the client. The deliverable is the `.eprj3` project itself — **no manufacturing exports**: BOM, pick-and-place and Gerber/production archives come from the client.

All code is self-authored Node CommonJS. **Zero third-party dependencies** — enforced by `node scripts/depcheck.js`, not just promised.

### What makes it different

- **Requirement intake, not guesswork** — a fixed input spec ([`docs/intake.md`](docs/intake.md)): required fields (function, input supply) block the build until answered; ask-tier fields come back as one batch of questions, each with its documented fallback; defaults are applied silently but shown so you can veto them.
- **Keyword → recipe selection** — `usb`, `单片机/mcu`, `i2c`, `rs485`, `按键/button`… map onto 16 buildable sub-circuit templates (`recipe/`), merged in signal-flow order with de-duplicated ids.
- **Derived power tree** — a regulator's input lands on the nearest rail *above* its output (12V→buck→5V→LDO→3V3 chains correctly), and a big linear drop prints a heat estimate instead of silently changing your BOM.
- **Placement-only deliverables — copper is always yours** — the shipped board is footprints placed by block flow with every pad's net linked, plus the board outline; this skill never auto-routes and never pours. `build.js` prints a `rats:` handoff list (nets to connect by hand in the client); layout to the machine, copper to the human.
- **Human confirmation gates before anything is written** — `build.js --plan` rehearses the real build (true scores) into a throwaway dir; `autofix.js --diff` shows a line diff of every automatic edit first.
- **Five gates** — format / ERC (E001–E007) / layout lint (L001–L010) / DRC + **DFM** (D001–D012: pad spacing, board edge, min drill, annular ring, silk-on-pad, acute angles — connectivity `D004` and pour `D006` are never judged on a board this skill built; imported or client-saved boards with copper get the full copper rules) / design intent (I001–I006: polarity, decoupling, divider ratio, diff pairs). Every finding carries a concrete `fix:` line.
- **Measured, not hoped** — 21-case benchmark (`scripts/eval.js`) tracks seconds and token proxies in `eval/history.jsonl`; a 44-variant legal/illegal corpus (`test/corpus.js`) proves the gates actually catch corruption; `EPRJ3_DETERMINISTIC=1` rebuilds byte-identically for golden-file diffs.

### AI one-line install prompt

Paste this to your assistant:

> Please install https://github.com/easyeda/easyeda-eprj3-skill into your AI assistant's skill directory (e.g. `.claude/skills/easyeda-eprj3` for Claude Code), verify Node.js ≥ 18, and initialize a sample project.

### Install

- [Node.js](https://nodejs.org/) ≥ 18 (verified on Windows 11 + Node 24). **No npm dependencies.**
- EasyEDA Pro / LCEDA Pro **V4.1+** offline client — needed only for the final `open` step.

Clone the repo into your assistant's skill directory (Claude Code shown):

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill .claude/skills/easyeda-eprj3
cd .claude/skills/easyeda-eprj3
npm test        # optional full regression: smoke + pipeline + DFM + corpus + depcheck
```

> **Where should it live?** This skill belongs in your assistant's skill/rules directory so the agent auto-loads `SKILL.md`. Claude Code uses `.claude/skills/easyeda-eprj3`; every script writes where you point it with `--dir <your project path>` — replace `./myboard` in examples with a real path.

> Don't want to type commands? Hand this page to the AI and let it install, verify, and run the steps for you.

### Quick start

This skill is built for AI assistants. You do not memorize script names — describe the circuit in natural language and the agent runs the flow below ([`SKILL.md`](SKILL.md), Step 0 + Fast path).

#### 1. Install

See [Install](#install) above. One line: Node.js ≥ 18, clone anywhere.

#### 2. Describe your board

For example:

> I need an STM32F103C8T6 minimum system, 3.3 V supply, USB-serial, one LED, one button. Project at `D:\boards\stm32-blink`, board 50 mm × 40 mm.

The agent follows the fixed intake protocol ([`docs/intake.md`](docs/intake.md)): function, input supply, rails, current, interfaces, MCU, board size, layers, package preference… asked **all at once**; anything you leave unanswered uses a documented default and is listed in the plan for you to veto.

#### 3. What the agent runs internally

1. `node scripts/intake.js check/resolve --req req.json` — maps your words to `recipe/` sub-circuits, derives the power chain (12V→buck→5V→LDO→3V3), and annotates rail widths from the declared current (handoff info for your copper work in the client), then emits `design.json`.
2. **Confirmation gates** (mandatory before generation; every change is shown first): power scheme, MCU/part choices, interface names, board size/layers. `node scripts/build.js --plan` rehearses the real build without writing; `node scripts/autofix.js --diff` prints the diff of every automatic fix before applying it.
3. `node scripts/build.js --design design.json --dir <project>` in one shot:
   - schematic: auto layout (signal-flow blocks), auto wiring, power symbols
   - PCB: **placement only** — footprints auto-placed with engineering sense (connectors on the board edge, decoupling caps next to their IC, undeclared boards auto-fit), pad↔net links bound, board outline; **no routing, no pour, ever**. The build prints a `rats:` handoff list of nets to connect by hand in the client.
   - five gates: format / ERC / layout lint / DRC+DFM (pad spacing, board edge, min drill, annular ring, silk-on-pad, acute angles D009–D012; `D004`/`D006` are never judged on a board this skill built — imported or client-saved copper is reviewed in full) / design intent (polarity, decoupling, dividers)
4. On failure, the printed `fix:` lines say exactly what to change (usually: edit the design, re-run `build.js --force`); mechanical fixes go through `scripts/autofix.js`.
5. `node scripts/open.js` opens the project in the EasyEDA Pro client.

The agent runs all of this — you don't type it.

#### 4. What you get

After a build the agent reports:

- project path: `<dir>/<name>.eprj3`
- schematic: component / net / annotation counts
- PCB: footprint + pad-net counts (placement only — no tracks, vias or pours; the build prints the `rats:` list of nets you still have to connect in the client)
- verification: all five gates with 0 errors, e.g. `blink.eprj3 at /path — 4 components, 15 wire segments, lint 100/100, drc 100/100 (placed-only).`
- whether the client was opened

A clean `build.js` exit *is* the quality proof. Review and fine-tune in EasyEDA Pro.

> Full example: [`examples/blink/`](examples/blink); intake requirement forms: [`examples/intake/`](examples/intake).

### Documentation

| Need | Read |
| --- | --- |
| The AI entry point / workflow | [`SKILL.md`](SKILL.md) |
| Requirement spec, questions, confirmation gates | [`docs/intake.md`](docs/intake.md) |
| `design.json` contract, PCB rules, copper policy | [`docs/build.md`](docs/build.md) |
| Every check code and its fix | [`docs/checks.md`](docs/checks.md) |
| Record-level eprj3 format | [`docs/format-reference.md`](docs/format-reference.md) |
| Legal/illegal corpus maintenance | [`docs/corpus.md`](docs/corpus.md) |
| Manual step-by-step (no design file) | [`docs/workflow.md`](docs/workflow.md) |
| Extending the skill / iteration protocol | [`docs/development.md`](docs/development.md) |
| Launching the client, non-default install paths | `node scripts/open.js --help` |
| Regression / benchmark / compliance | `node test/pipeline.js`, `node test/dfm.js`, `node test/corpus.js`, `node scripts/eval.js [--diff] [--design <file>]`, `node scripts/depcheck.js` |

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

> 用 AI 或几条 Node 命令，生成可在 EasyEDA Pro（嘉立创 EDA 专业版）直接打开的 `.eprj3` 工程。
>
> **边界**：交付物就是 `.eprj3` 工程本身（原理图 + 布局好的 PCB）。自动布线、铺铜、制造文件导出（BOM / 坐标 / Gerber）都不归这个 skill 管——在客户端完成。

**当前版本：1.29.0** · [更新记录](CHANGELOG.md)

### AI 一键安装口令

把下面这句话直接发给你的 AI 助手即可开始：

> AI 助手，请帮我把 https://github.com/easyeda/easyeda-eprj3-skill 安装到我的 AI 助手的 skill 目录（例如 Claude Code 的 `.claude/skills/easyeda-eprj3`），确认 Node.js ≥ 18，并初始化一个示例工程。

### 安装

- 需要 [Node.js](https://nodejs.org/) ≥ 18（已在 Windows 11 + Node 24 验证），**无需 npm 依赖**。
- 需要 EasyEDA Pro / LCEDA Pro **V4.1+** 离线客户端，只在最后一步 `open` 用到。

把仓库克隆到你使用的 AI 助手的 skill 目录里（下面以 Claude Code 为例）：

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill .claude/skills/easyeda-eprj3
cd .claude/skills/easyeda-eprj3
npm test            # 可选：跑一遍完整回归测试，确认环境正常
```

> **放在哪里？** 这个 skill 应该放在 AI 助手的 skill 目录里，让 AI 能自动加载 `SKILL.md`。Claude Code 用 `.claude/skills/easyeda-eprj3`，所有脚本都通过 `--dir <你的工程目录>` 指定生成目标；示例中的 `./myboard` 请换成你的真实工程路径。

> 不想敲命令？把本页复制给 AI，让它按上面的指引帮你安装、初始化并执行后续步骤。

### 快速上手

这个 skill 是给 AI 助手用的。你不需要记下面的脚本名，只要用自然语言描述电路/PCB 需求，AI 会按 [`SKILL.md`](SKILL.md) 自动调用对应脚本并生成工程。

#### 1. 安装

见上方 [安装](#安装) 部分。一句话总结：Node.js ≥ 18，把仓库克隆到任意目录即可。

#### 2. 跟 AI 描述你的需求

例如：

> 我要画一个 STM32F103C8T6 最小系统，3.3V 供电，带一个 USB 转串口、一个 LED 和一个按键。工程放在 `D:\boards\stm32-blink`，板子 50mm x 40mm。

AI 会按固定输入规范追问（[`docs/intake.md`](docs/intake.md)：功能、输入电源、电源轨、电流、接口、主控、板框、层数、封装偏好等），**一次问完**；没答的字段用文档化默认值填充，并在方案里逐条标出供你否决。

#### 3. AI 内部执行流程

AI 会按下面顺序完成（声明式一键路径，[`SKILL.md`](SKILL.md) 的 Step 0 + Fast path）：

1. `node scripts/intake.js check/resolve --req req.json` → 需求映射到 `recipe/` 里的子电路模板，自动推导电源链（12V→buck→5V→ldo→3V3）、按电流把电源线宽**注记**进 design.json（交接信息，供你在客户端铺铜参考），产出 `design.json`
2. **确认点**（生成前必经，改动都先给你看）：电源方案、主控/器件选型、接口命名、板框/层数；`node scripts/build.js --plan` 真实预演但不写盘；`node scripts/autofix.js --diff` 打印修复差异后才写入
3. `node scripts/build.js --design design.json --dir <工程目录>` 一次完成：
   - 原理图：自动布局（信号流分块）、自动布线、电源符号
   - PCB：**只管布局**——自动放置封装、绑定焊盘网络、生成板框；**永不布线、永不铺铜**（铜皮由人在 EasyEDA 客户端完成；build 会打印 `rats:` 交接清单，列出还需手工连的网络）
   - 五道门禁：格式 / ERC / 布局 / DRC+DFM（焊盘间距、板边、最小钻孔、环宽、丝印压盘、锐角 D009–D012；本 skill 自建的板恒为 placed-only，不判 D004/D006；导入或客户端返存的铜皮仍完整判定） / 设计意图（极性、去耦、分压比等）
4. 失败时按错误信息里的 `fix:` 提示修改 design 后重跑（机械修复可交给 `scripts/autofix.js`）
5. `node scripts/open.js` 在 EasyEDA Pro 客户端打开

这些命令由 AI 自动运行；你不需要手动敲。

#### 4. 验收

生成完成后，AI 会汇报：

- 工程路径：`<你的目录>/<项目名>.eprj3`
- 原理图：多少元件、网络、标注
- PCB：多少封装与焊盘网络（只管布局；不含走线/过孔/铺铜——铜皮在客户端人工完成）
- 验证结果：五道门禁 0 错误
- 是否已自动打开客户端

你只需在 EasyEDA Pro 里检查、微调即可。

> 完整示例见 [`examples/blink/`](examples/blink)；需求表单示例见 [`examples/intake/`](examples/intake)。

### 开发/进阶参考

想手动调用脚本、了解仓库结构或扩展 skill 的用户，请查看 [`docs/development.md`](docs/development.md)。

## 许可

MIT — 见 [LICENSE](LICENSE)。
