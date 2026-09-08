# Install for 腾讯元宝 / AI 代码助手

腾讯云 AI 代码助手（基于混元大模型）作为 VS Code / JetBrains 插件提供，规则放在 `.tencent-cloud/rules/`。

## 项目本地

```bash
mkdir -p .tencent-cloud/rules
cp SKILL.md .tencent-cloud/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

VS Code 工作区 `.vscode/settings.json`：

```json
{
  "tencentCloud.customRules": [
    ".tencent-cloud/rules/easyeda-eprj3.md"
  ]
}
```

## 用户级

`~/.tencent-cloud/rules/easyeda-eprj3.md`。

## 网页端元宝

元宝（hunyuan.tencent.com）支持上传文档作为长期记忆，把 `SKILL.md` 上传即可在对话中引用。

## 验证

> 按 `.tencent-cloud/rules/easyeda-eprj3.md` 创建工程 `~/myboard`。