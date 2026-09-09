# Install for MiniMax Code

MiniMax Code 是 MiniMax 官方推出的命令行 AI 编程助手，基于 MiniMax M2 模型（MIT 开源）。

- 官方页面：[minimax.io/platform/minimax-code](https://www.minimax.io/platform/minimax-code)
- 开放平台（国内）：[platform.minimaxi.com](https://platform.minimaxi.com) | 国际：[minimax.io](https://www.minimax.io)

## 项目本地安装 skill

MiniMax Code 兼容 Claude Code 的工作方式（能读文件、执行 shell 命令），沿用项目根目录 `CLAUDE.md` / `AGENTS.md` 作为上下文入口：

```bash
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

在项目根目录的 `CLAUDE.md`（或 `AGENTS.md`）中加入：

```markdown
# Skills

本项目使用 EasyEDA Pro eprj3 技能，位于 `skills/easyeda-eprj3/SKILL.md`。
当用户提到 "EasyEDA"、"eprj3"、"嘉立创EDA"，
或要求创建 / 转换 / 校验原理图 PCB 工程时，先读取该文件并严格按其工作流执行。
```

## 用户级

全局生效可在 `~/.claude/CLAUDE.md`（MiniMax Code 兼容读取）中加入同样的 Skills 段落。

## 验证

```
> 用 easyeda-eprj3 技能创建工程 ~/myboard，含 1k 电阻 + LED，跑 validate 校验
```
