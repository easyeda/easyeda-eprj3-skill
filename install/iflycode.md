# Install for iFlyCode (科大讯飞)

iFlyCode 是科大讯飞推出的 AI 编程助手，VS Code / JetBrains 插件。规则文件放在 `.iflycode/rules/`。

## 项目本地

```bash
mkdir -p .iflycode/rules
cp SKILL.md .iflycode/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

VS Code 工作区 `.vscode/settings.json`：

```json
{
  "iflycode.customRules": [
    ".iflycode/rules/easyeda-eprj3.md"
  ]
}
```

JetBrains：**Settings → iFlyCode → Custom Rules**。

## 用户级

`~/.iflycode/rules/easyeda-eprj3.md`。

## 验证

> 按 `.iflycode/rules/easyeda-eprj3.md` 创建 `~/myboard` 工程。