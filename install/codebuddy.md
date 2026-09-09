# Install for CodeBuddy (腾讯云 AI 代码助手)

CodeBuddy 是腾讯云自研的智能开发助手，内置 Craft 智能体，支持 MCP。规则文件格式与 Cursor 兼容。

- 插件版：[copilot.tencent.com](https://copilot.tencent.com)（VS Code / JetBrains）
- IDE 版：[codebuddy.ai](https://www.codebuddy.ai)（独立 AI 全栈开发平台）

## 项目本地安装 skill

CodeBuddy 兼容 Cursor 的 `.cursor/rules` 规则语法，直接复用：

```bash
mkdir -p .codebuddy/rules
cp SKILL.md .codebuddy/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

或直接放进 Cursor 兼容目录：

```bash
mkdir -p .cursor/rules
cp SKILL.md .cursor/rules/easyeda-eprj3.mdc
```

`.mdc` 头部（Cursor / CodeBuddy 通用）：

```markdown
---
description: 创作 / 转换 / 校验 EasyEDA Pro .eprj3 工程（skill 位于 ./skills/easyeda-eprj3）
globs:
  - "*.eprj3"
  - "**/*.esch2"
  - "**/*.epcb2"
alwaysApply: false
---
```

## Craft 智能体 + MCP

Craft 支持自定义 MCP 服务。若需要把 eprj3 脚本暴露为 MCP 工具，在 CodeBuddy 的 MCP 设置中注册一个 STDIO server，把 `scripts/*.js` 包装成 tool 即可（参考 [generic.md](generic.md)）。

## 用户级

CodeBuddy IDE：**Settings → Rules** 添加全局规则，粘贴 `SKILL.md` 内容。

## 验证

> 按 `.codebuddy/rules/easyeda-eprj3.md` 创建工程 `~/myboard`，含一个 1k 电阻和一个 LED。

参考：[腾讯云 CodeBuddy 文档](https://cloud.tencent.com/document/product/1739)
