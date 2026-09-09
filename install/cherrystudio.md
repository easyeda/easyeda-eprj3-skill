# Install for Cherry Studio

Cherry Studio 是开源的 AI 桌面客户端（Windows / macOS / Linux），支持多模型、自定义助手和 MCP 服务器。

- 仓库：[CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)
- 文档：[docs.cherry-ai.com](https://docs.cherry-ai.com)

## 方式 A：自定义助手（推荐）

Cherry Studio 的核心机制是「助手 + 系统提示词」：

1. **设置 → 助手 → 创建助手**，命名 `EasyEDA eprj3`。
2. 把本仓库 `SKILL.md` 全文粘贴到该助手的**系统提示词**中。
3. 在助手的**工具**里启用你配置的 MCP 服务器（见方式 B），让模型能真正执行脚本。
4. 对话时选择该助手即可。

建议在系统提示词末尾追加一段路径约定：

```markdown
工作目录约定：所有 eprj3 工程默认创建在 <用户指定的绝对路径> 下。
skill 脚本位于 <本仓库克隆位置>/scripts/，执行时用 `node <脚本>` 调用。
```

## 方式 B：MCP 服务器

Cherry Studio 从 v0.9.0 起支持 MCP（STDIO / SSE / Streamable HTTP），需本机装有 Node.js。

**设置 → MCP 服务器 → 添加**，类型选 STDIO，命令示例：

```json
{
  "mcpServers": {
    "easyeda-eprj3": {
      "command": "node",
      "args": ["<仓库路径>/scripts/mcp-server.js"],
      "env": {}
    }
  }
}
```

> 当前仓库尚未内置 `mcp-server.js`。在没有 MCP 包装的情况下，用方式 A 并让模型直接生成 `node scripts/xxx.js` 命令、由用户在终端执行，同样可以完成整个工作流。

## 验证

在 EasyEDA eprj3 助手中：

> 创建工程 `~/myboard`，包含一个 1k 电阻和一个 LED，最后运行校验。
