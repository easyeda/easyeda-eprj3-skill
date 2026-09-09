# Install for 通义灵码 (Tongyi Lingma)

通义灵码是阿里云推出的 AI 编码助手，覆盖 VS Code / JetBrains / Visual Studio 等 IDE，自定义提示词通过 IDE 的指令文件加载。指令会进入系统提示词，因此安装一个一行指针规则，把灵码指向完整 skill。

## 项目本地

```bash
mkdir -p .lingma/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .lingma/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

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

```bash
mkdir -p ~/.lingma/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.lingma/skills/easyeda-eprj3
cat > ~/.lingma/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.lingma/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

（Windows 把 `~/.lingma` 换成 `%USERPROFILE%\.lingma`，IDE 全局生效。）

## 验证

在通义灵码对话面板：

> 用 easyeda-eprj3 技能，在 `~/myboard` 创建一个工程，包含一个 1k 电阻和一个 LED。
