# Install for iFlyCode (科大讯飞)

iFlyCode 是科大讯飞推出的 AI 编程助手，VS Code / JetBrains 插件。规则文件放在 `.iflycode/rules/`，规则会进入系统提示词，因此安装一个一行指针规则，把 iFlyCode 指向完整 skill。

## 项目本地

```bash
mkdir -p .iflycode/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .iflycode/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

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

```bash
mkdir -p ~/.iflycode/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.iflycode/skills/easyeda-eprj3
cat > ~/.iflycode/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.iflycode/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

## 验证

> 按 `.iflycode/rules/easyeda-eprj3.md` 创建 `~/myboard` 工程。
