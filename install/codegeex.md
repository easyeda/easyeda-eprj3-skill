# Install for CodeGeeX (智谱)

CodeGeeX 是智谱 AI 推出的多语言代码生成模型，作为插件覆盖 VS Code / JetBrains。规则文件放在 `.codegeex/rules/`。

## 项目本地

```bash
mkdir -p .codegeex/rules
cp SKILL.md .codegeex/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

VS Code 设置 `.vscode/settings.json`：

```json
{
  "codegeex.customRules": [
    ".codegeex/rules/easyeda-eprj3.md"
  ]
}
```

## 用户级

`~/.codegeex/rules/easyeda-eprj3.md`，所有工程生效。

## 验证

在 CodeGeeX 对话框：

> 按 `.codegeex/rules/easyeda-eprj3.md` 创建 `~/myboard` 工程。