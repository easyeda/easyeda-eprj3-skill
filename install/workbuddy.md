# Install for WorkBuddy（腾讯云 AI Agent 办公工具）

WorkBuddy 是腾讯云代码助手（CodeBuddy）团队推出的 AI Agent 办公工具，官网 [workbuddy.cn](https://www.workbuddy.cn)。定位是「AI Agent 办公新范式」：自主规划并交付多模态复杂任务，支持多 Agent 并行工作，可对接腾讯系生态并支持 MCP 协议。

与 CodeBuddy 的关系：同一团队的两个产品——CodeBuddy 面向编码场景（IDE 插件 / CodeBuddy IDE，见 [codebuddy.md](codebuddy.md)），WorkBuddy 面向通用办公 Agent 场景（桌面应用）。WorkBuddy 没有公开的专用规则目录（如 `.cursor/rules`），接入本 skill 用通用项目上下文约定即可。

## 项目上下文文件

在项目根目录放置 `AGENTS.md`（兼容 `CLAUDE.md`），作为 Agent 读取本 skill 的入口：

```markdown
# AGENTS.md

当用户提到 EasyEDA / eprj3 / 嘉立创EDA，或要求创建、
转换、校验原理图 / PCB 工程时：

1. 读取 skills/easyeda-eprj3/SKILL.md
2. 严格按其中的标准工作流执行
3. 脚本一律用 `node scripts/<脚本名>` 调用，路径相对于本文件所在目录
```

克隆 skill 到项目内：

```bash
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

## 通过 MCP 暴露脚本

WorkBuddy 支持 MCP 协议。若有 MCP 配置入口，可将 skill 脚本包装为 STDIO server（参考 [generic.md](generic.md) 的 MCP 章节）。未配置 MCP 时，直接让 Agent 在工作台里执行 `node scripts/xxx.js` 命令同样能跑通整个工作流。

## 注意事项

- WorkBuddy 部分能力处于公测 / 邀测阶段，具体以官网为准
- 办公场景 Agent 对 shell 的访问可能受限；若无法执行命令，按 SKILL.md 的记录语法直接生成 `.eprj3` 文本文件，再由用户运行 `node scripts/validate.js` 校验

## 验证

> 读取 AGENTS.md 指向的 skill，创建工程 ~/myboard，含 1k 电阻 + LED，并运行校验。

参考：[WorkBuddy 官网](https://www.workbuddy.cn) | [腾讯云 CodeBuddy](https://copilot.tencent.com)
