# Install for 豆包 MarsCode (ByteDance)

豆包 MarsCode 是字节跳动推出的 AI IDE / 插件产品，与 Trae 共享同一基础。自定义规则放入 `.marscode/rules/`。

## 项目本地

```bash
mkdir -p .marscode/rules
cp SKILL.md .marscode/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

VS Code 工作区 `.vscode/settings.json`：

```json
{
  "marscode.customRules": [
    ".marscode/rules/easyeda-eprj3.md"
  ]
}
```

云端 IDE：把仓库导入 MarsCode 工作区后，把规则文件提交到仓库根目录的 `.marscode/rules/` 即可。

## 用户级

`~/.marscode/rules/easyeda-eprj3.md`，跨工程生效。

## 验证

> 用 easyeda-eprj3 规则帮我创建工程 `~/myboard`。