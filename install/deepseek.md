# Install for DeepSeek-Coder

DeepSeek 通过 VS Code 扩展（continue-dev 桥接、CodeGPT、Cline 等）和 DeepSeek 自家网页/CLI 提供编码能力。

## 项目本地

把 `SKILL.md` 放到能被加载的位置。常见做法：

```bash
mkdir -p .deepseek/rules
cp SKILL.md .deepseek/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

如果你通过 Continue.dev 调用 DeepSeek，把规则文件加进 `.continue/config.json`：

```json
{
  "models": [{ "title": "DeepSeek Coder", "provider": "deepseek", "model": "deepseek-coder" }],
  "rules": [".deepseek/rules/easyeda-eprj3.md"]
}
```

## 用户级

`~/.deepseek/rules/easyeda-eprj3.md`，跨工程生效。

## 验证

> 读取 `.deepseek/rules/easyeda-eprj3.md`，创建工程 `~/myboard`。