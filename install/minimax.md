# Install for MiniMax M2（作为 Agent 后端）

MiniMax M2 是 MiniMax 开源的编码 / Agent 模型（MIT 协议），本身不是独立 IDE 或 CLI，而是接入到现有 Agent 工具中作为后端模型使用。本 skill 与具体后端无关——只要 Agent 能读文件、执行 shell 命令，就能跑通整个 eprj3 工作流。

- 模型仓库：[MiniMax-AI/MiniMax-M2](https://github.com/MiniMax-AI/MiniMax-M2)
- 平台文档：[minimax.io/platform](https://www.minimax.io/platform/document/M2)

## 接入 Claude Code

MiniMax 提供 Anthropic 兼容端点：

```bash
export ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic"   # 国内: https://api.minimaxi.com/anthropic
export ANTHROPIC_AUTH_TOKEN="${MINIMAX_API_KEY}"
claude
```

然后按 [claude-code.md](claude-code.md) 正常安装本 skill 即可，工作流不变。

## 接入 Cline / Roo Code / Kilo Code

在插件设置中选 Anthropic 兼容 provider：

- Base URL: `https://api.minimax.io/anthropic`
- API Key: 你的 MiniMax key
- Model: `MiniMax-M2`

然后按 [cline.md](cline.md) 或 [roo-cline.md](roo-cline.md) 安装 skill。

## 项目上下文文件

无论接哪个 Agent，都在项目根目录放一个指向本 skill 的入口：

```markdown
# AGENTS.md / CLAUDE.md 追加

当用户提到 EasyEDA / eprj3 / 嘉立创EDA / KiCad 转换时，
读取 skills/easyeda-eprj3/SKILL.md 并按其工作流执行。
```

## 验证

```
> 用 easyeda-eprj3 技能创建工程 ~/myboard，含 1k 电阻 + LED，跑 validate 校验
```
