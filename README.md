# easyeda-eprj3-skill

> 用 AI 或几条 Node 命令，生成可在 EasyEDA Pro（嘉立创 EDA 专业版）直接打开的 `.eprj3` 工程。

[English version](README_en.md) · **当前版本：1.7.3** · [更新记录](CHANGELOG.md)

---

## AI 一键安装口令

把下面这句话直接发给你的 AI 助手即可开始：

> AI 助手，请帮我把 https://github.com/easyeda/easyeda-eprj3-skill 和 https://github.com/easyeda/easyeda-pro-format-skill 安装到我的 AI 助手的 skill 目录（例如 Claude Code 的 `.claude/skills/easyeda-eprj3`），确认 Node.js ≥ 18，并初始化一个示例工程。

## 安装

- 需要 [Node.js](https://nodejs.org/) ≥ 18（已在 Windows 11 + Node 24 验证），**无需 npm 依赖**。
- 需要 EasyEDA Pro / LCEDA Pro **V4.1+** 离线客户端，只在最后一步 `open` 用到。

把仓库克隆到你使用的 AI 助手的 skill 目录里（下面以 Claude Code 为例）：

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill .claude/skills/easyeda-eprj3
cd .claude/skills/easyeda-eprj3
npm test            # 可选：跑一遍完整回归测试，确认环境正常
```

> **放在哪里？** 这个 skill 应该放在 AI 助手的 skill 目录里，让 AI 能自动加载 `SKILL.md`。Claude Code 用 `.claude/skills/easyeda-eprj3`，Cursor、Copilot 等其他工具的具体路径见 [`install/`](install/README.md)。所有脚本都通过 `--dir <你的工程目录>` 指定生成目标；示例中的 `./myboard` 请换成你的真实工程路径。

> 不想敲命令？把本页复制给 AI，让它按上面的指引帮你安装、初始化并执行后续步骤。

## 快速上手

这个 skill 是给 AI 助手用的。你不需要记下面的脚本名，只要用自然语言描述电路/PCB 需求，AI 会按 [`SKILL.md`](SKILL.md) 自动调用对应脚本并生成工程。

### 1. 安装

见上方 [安装](#安装) 部分。一句话总结：Node.js ≥ 18，把仓库克隆到任意目录即可。

### 2. 跟 AI 描述你的需求

例如：

> 我要画一个 STM32F103C8T6 最小系统，3.3V 供电，带一个 USB 转串口、一个 LED 和一个按键。工程放在 `D:\boards\stm32-blink`，板子 50mm x 40mm。

AI 会追问缺的信息（元件型号、引脚、网络名、连接关系等），然后自动开始生成。

### 3. AI 内部执行流程

AI 会按下面顺序完成：

1. `init.js` 创建 `.eprj3` 工程（原理图 + PCB）
2. `load-library.js list` 查看内置预设库
3. `add-symbol.js` 放置原理图符号、电源、端口
4. `add-wire.js` / `add-netlabel.js` 连线并标注网络
5. `set-refdes.js` 整理位号
6. `add-footprint.js` / `add-track.js` / `add-via.js` / `add-pour.js` 做 PCB 布局布线
7. `validate.js` 验证工程格式
8. `open.js` 在 EasyEDA Pro 客户端打开

这些命令由 AI 自动运行；你不需要手动敲。

### 4. 验收

生成完成后，AI 会汇报：

- 工程路径：`<你的目录>/<项目名>.eprj3`
- 原理图：多少元件、网络、标注
- PCB：多少封装、走线、过孔、铺铜
- 验证结果：0 错误
- 是否已自动打开客户端

你只需在 EasyEDA Pro 里检查、微调即可。

> 完整示例见 [`examples/blink/`](examples/blink)；各 AI 助手的 skill 接入方式见 [`install/`](install/README.md)。

## 开发/进阶参考

想手动调用脚本、了解仓库结构或扩展 skill 的用户，请查看 [`docs/development.md`](docs/development.md)。
