# Install for Kimi CLI (月之暗面)

Kimi CLI 是月之暗面（Moonshot AI）推出的命令行编程 Agent，配合 Kimi K2 模型使用。

## 项目本地安装 skill

Kimi CLI 沿用 Claude Code 风格的项目上下文约定，读取项目根目录的 `KIMI.md`（兼容 `CLAUDE.md`）：

```bash
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

在 `KIMI.md` 中加入：

```markdown
# Skills

本项目使用 EasyEDA Pro eprj3 技能，位于 `skills/easyeda-eprj3/SKILL.md`。
当用户提到 "EasyEDA"、"eprj3"、"嘉立创EDA"，或要求创建 / 转换 / 校验
原理图 PCB 工程时，先读取该文件并按其标准工作流执行。
```

## 用户级

`~/.kimi/KIMI.md` 全局生效。

## 验证

```
kimi
> 读取 skills/easyeda-eprj3/SKILL.md，列出工作流步骤
```

参考：[MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) | [platform.moonshot.cn](https://platform.moonshot.cn)
