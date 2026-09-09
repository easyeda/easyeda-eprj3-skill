# Install for CodeGeeX (智谱)

CodeGeeX 是智谱 AI 推出的多语言代码生成模型，作为插件覆盖 VS Code / JetBrains。规则文件放在 `.codegeex/rules/`，规则会进入系统提示词，因此安装一个一行指针规则，把 CodeGeeX 指向完整 skill。

## 项目本地

```bash
mkdir -p .codegeex/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .codegeex/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

VS Code 设置 `.vscode/settings.json`：

```json
{
  "codegeex.customRules": [
    ".codegeex/rules/easyeda-eprj3.md"
  ]
}
```

## 用户级

```bash
mkdir -p ~/.codegeex/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.codegeex/skills/easyeda-eprj3
cat > ~/.codegeex/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.codegeex/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

所有工程生效。

## 验证

在 CodeGeeX 对话框确认规则 `easyeda-eprj3` 已加载，然后问：

> 按 `.codegeex/rules/easyeda-eprj3.md` 创建 `~/myboard` 工程。
