# Install for 豆包 MarsCode (ByteDance)

豆包 MarsCode 是字节跳动推出的 AI IDE / 插件产品，与 Trae 共享同一基础。自定义规则放入 `.marscode/rules/`，规则会进入系统提示词，因此安装一个一行指针规则，把 MarsCode 指向完整 skill。

## 项目本地

```bash
mkdir -p .marscode/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .marscode/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

clone 会把 `scripts/` 保留在 `SKILL.md` 旁边，skill 里的 `node scripts/...` 都是相对 SKILL.md 所在目录的路径，这样才能正确解析。

VS Code 工作区 `.vscode/settings.json`：

```json
{
  "marscode.customRules": [
    ".marscode/rules/easyeda-eprj3.md"
  ]
}
```

云端 IDE：把仓库导入 MarsCode 工作区后，执行上面的 clone 和 stub 命令，再把规则文件提交到仓库根目录的 `.marscode/rules/` 即可。

## 用户级

```bash
mkdir -p ~/.marscode/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.marscode/skills/easyeda-eprj3
cat > ~/.marscode/rules/easyeda-eprj3.md <<'EOF'
当用户提到 EasyEDA、嘉立创EDA、eprj3、原理图、PCB 时，阅读 ~/.marscode/skills/easyeda-eprj3/SKILL.md 并照做。
EOF
```

跨工程生效。

## 验证

> 用 easyeda-eprj3 规则帮我创建工程 `~/myboard`。
