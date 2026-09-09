# Install for 腾讯元宝 / AI 代码助手

腾讯云 AI 代码助手（基于混元大模型）作为 VS Code / JetBrains 插件提供，规则放在 `.tencent-cloud/rules/`，规则会进入系统提示词，因此安装一个一行指针规则，把助手指向完整 skill。

## 项目本地

```bash
mkdir -p .tencent-cloud/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .tencent-cloud/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

VS Code 工作区 `.vscode/settings.json`：

```json
{
  "tencentCloud.customRules": [
    ".tencent-cloud/rules/easyeda-eprj3.md"
  ]
}
```

## 用户级

```bash
mkdir -p ~/.tencent-cloud/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.tencent-cloud/skills/easyeda-eprj3
cat > ~/.tencent-cloud/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.tencent-cloud/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

## 网页端元宝

元宝（hunyuan.tencent.com）支持上传文档作为长期记忆。把 `SKILL.md` 上传即可在对话中引用；同时在本地把仓库 clone 到 `skills/easyeda-eprj3`，让 skill 里的 `node scripts/...` 路径能真实执行。

## 验证

> 按 `.tencent-cloud/rules/easyeda-eprj3.md` 创建工程 `~/myboard`。
