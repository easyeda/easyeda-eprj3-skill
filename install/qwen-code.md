# Install for Qwen Code (通义千问)

Qwen Code 是阿里 Qwen 团队基于 gemini-cli 二次开发的命令行 AI 工作流工具，针对 Qwen3-Coder 优化。

## 项目本地安装 skill

Qwen Code 读取项目根目录的 `QWEN.md` 作为上下文（继承自 gemini-cli 的 `GEMINI.md` 约定）：

```bash
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

在 `QWEN.md` 中加入：

```markdown
# Skills

本项目使用 EasyEDA Pro eprj3 技能，位于 `skills/easyeda-eprj3/SKILL.md`。
当用户提到 "EasyEDA"、"eprj3"、"嘉立创EDA"，
或要求从零创建原理图 / PCB 工程时，先读取该文件并严格按其工作流执行。
```

## 用户级

`~/.qwen/QWEN.md` 对所有工程生效。

## 验证

```
qwen
> 读取 skills/easyeda-eprj3/SKILL.md，列出可用脚本
```

参考：[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | [Qwen3-Coder 发布博客](https://qwenlm.github.io/blog/qwen3-coder)
