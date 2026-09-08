# Install for 文心快码 (Baidu Comate)

文心快码是百度推出的 AI 编码助手，覆盖 VS Code / JetBrains / Visual Studio。自定义规则写入 `.comate/rules/`。

## 项目本地

```bash
mkdir -p .comate/rules
cp SKILL.md .comate/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

VS Code 工作区 `.vscode/settings.json`：

```json
{
  "comate.customRules": [
    ".comate/rules/easyeda-eprj3.md"
  ]
}
```

JetBrains：**Settings → Tools → Baidu Comate → Custom Instructions**，把 `.comate/rules/easyeda-eprj3.md` 加入。

## 用户级

```bash
mkdir -p ~/.comate/rules
cp SKILL.md ~/.comate/rules/easyeda-eprj3.md
```

## 验证

在 Comate 对话框输入：

> 参考 `.comate/rules/easyeda-eprj3.md` 帮我创建 `~/myboard` 工程。