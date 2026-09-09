# Install for 文心快码 (Baidu Comate)

文心快码是百度推出的 AI 编码助手，覆盖 VS Code / JetBrains / Visual Studio。自定义规则写入 `.comate/rules/`，规则会进入系统提示词，因此安装一个一行指针规则，把 Comate 指向完整 skill。

## 项目本地

```bash
mkdir -p .comate/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .comate/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

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
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.comate/skills/easyeda-eprj3
cat > ~/.comate/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.comate/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

所有工程生效。

## 验证

在 Comate 对话框输入：

> 参考 `.comate/rules/easyeda-eprj3.md` 帮我创建 `~/myboard` 工程。
