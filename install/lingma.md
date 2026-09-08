# Install for 通义灵码 (Tongyi Lingma)

通义灵码是阿里云推出的 AI 编码助手，覆盖 VS Code / JetBrains / Visual Studio 等 IDE，自定义提示词通过 IDE 的指令文件加载。

## 项目本地

```bash
mkdir -p .lingma/rules
cp SKILL.md .lingma/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

在 VS Code 工作区 `.vscode/settings.json` 中启用：

```json
{
  "lingma.customRules": [
    ".lingma/rules/easyeda-eprj3.md"
  ]
}
```

JetBrains 系列（IntelliJ IDEA / CLion 等）：**Settings → Plugins → 通义灵码 → Custom Rules**，把 `.lingma/rules/easyeda-eprj3.md` 加入列表。

## 用户级（推荐）

把规则放到 `~/.lingma/rules/easyeda-eprj3.md`（Linux/macOS）或 `%USERPROFILE%\.lingma\rules\easyeda-eprj3.md`（Windows），IDE 全局生效。

## 验证

在通义灵码对话面板：

> 用 easyeda-eprj3 技能，在 `~/myboard` 创建一个工程，包含一个 1k 电阻和一个 LED。