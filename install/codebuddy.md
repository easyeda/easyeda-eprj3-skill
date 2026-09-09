# Install for CodeBuddy (腾讯云 AI 代码助手)

CodeBuddy 是腾讯云自研的智能开发助手，内置 Craft 智能体，支持 MCP。规则文件格式与 Cursor 兼容。

- 插件版：[copilot.tencent.com](https://copilot.tencent.com)（VS Code / JetBrains）
- IDE 版：[codebuddy.ai](https://www.codebuddy.ai)（独立 AI 全栈开发平台）

## 项目本地安装 skill

CodeBuddy 兼容 Cursor 的 `.cursor/rules` 规则语法。规则会进入系统提示词，因此安装一个指针 stub，把 CodeBuddy 指向完整 skill：

```bash
mkdir -p .codebuddy/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .codebuddy/rules/easyeda-eprj3.mdc <<'EOF'
---
description: 创作 / 转换 / 校验 EasyEDA Pro .eprj3 工程（skill 位于 ./skills/easyeda-eprj3）
globs:
  - "*.eprj3"
  - "**/*.esch2"
  - "**/*.epcb2"
alwaysApply: false
---

当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

或直接放进 Cursor 兼容目录（复用同一份 stub）：

```bash
mkdir -p .cursor/rules
cp .codebuddy/rules/easyeda-eprj3.mdc .cursor/rules/easyeda-eprj3.mdc
```

`.mdc` 头部 frontmatter 与 Cursor 完全兼容，上面 stub 中已包含。

## Craft 智能体 + MCP

Craft 支持自定义 MCP 服务。若需要把 eprj3 脚本暴露为 MCP 工具，在 CodeBuddy 的 MCP 设置中注册一个 STDIO server，把 `scripts/*.js` 包装成 tool 即可（参考 [generic.md](generic.md)）。

## 用户级

CodeBuddy IDE：先把仓库 clone 到固定位置，再在 **Settings → Rules** 添加全局规则，粘贴下面的指针内容：

```bash
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.codebuddy/skills/easyeda-eprj3
```

```markdown
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.codebuddy/skills/easyeda-eprj3/SKILL.md 并照做。
```

## 验证

> 按 `.codebuddy/rules/easyeda-eprj3.mdc` 创建工程 `~/myboard`，含一个 1k 电阻和一个 LED。

参考：[腾讯云 CodeBuddy 文档](https://cloud.tencent.com/document/product/1739)
