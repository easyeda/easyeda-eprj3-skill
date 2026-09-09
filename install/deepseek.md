# Install for DeepSeek-Coder

DeepSeek 通过 VS Code 扩展（continue-dev 桥接、CodeGPT、Cline 等）和 DeepSeek 自家网页/CLI 提供编码能力。

## 项目本地

把一个指针规则放到能被加载的位置，让它指向完整 skill。常见做法：

```bash
mkdir -p .deepseek/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .deepseek/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

如果你通过 Continue.dev 调用 DeepSeek，把规则文件加进 `.continue/config.json`：

```json
{
  "models": [{ "title": "DeepSeek Coder", "provider": "deepseek", "model": "deepseek-coder" }],
  "rules": [".deepseek/rules/easyeda-eprj3.md"]
}
```

## 用户级

```bash
mkdir -p ~/.deepseek/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.deepseek/skills/easyeda-eprj3
cat > ~/.deepseek/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.deepseek/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

跨工程生效。

## 验证

> 读取 `.deepseek/rules/easyeda-eprj3.md` 指向的 `skills/easyeda-eprj3/SKILL.md`，创建工程 `~/myboard`。
