# 嘉立创EDA专业版文件夹化工程格式（`.eprj3`）

本文档介绍 **嘉立创EDA专业版 / EasyEDA Pro** 的文件夹化工程格式，面向需要阅读、编辑或进行版本控制的普通用户和 AI 工具。

## `.eprj3` 是什么？

`.eprj3` 是 嘉立创EDA专业版 新的工程文件夹化存储格式。与旧的 `eprj`/`.eprj2` 格式（将整个工程存放在单一 SQLite 数据库文件中）不同，`.eprj3` 将工程拆分为一个由 JSON 和纯文本文件组成的目录。

这使得工程：

- **适合版本控制** — 可使用 Git 等工具追踪变更、查看差异。
- **适合工具处理** — 文本编辑器、脚本和 AI 助手可直接读取和修改文件。
- **结构透明** — 工程结构与数据一目了然。

### 格式对比

| 特性         | 旧版 `eprj`/`.eprj2`    | 新版 `.eprj3`       |
| ------------ | ---------------- | ------------------- |
| 存储形式     | 单文件           | 文件夹 + 多文件     |
| 数据格式     | SQLite 数据库    | JSON + 纯文本       |
| 版本控制     | 困难             | 容易 / 对 Git 友好  |
| 直接访问     | 不支持           | 支持                |

## 工程目录结构

一个典型的 `.eprj3` 工程如下：

```
MyProject/                                  # 工程根目录
├── MyProject.eprj3                         # 工程索引与元数据
├── sch/                                    # 原理图
│   └── <原理图名称>/                        # 单个原理图文件夹
│       ├── <图页标题>.esch2                 # 图页源码
│       ├── <原理图名称>.ecfg               # 该原理图的设计规则
│       └── <原理图名称>.evar               # 装配变量数据
├── pcb/                                    # PCB
│   └── <PCB 名称>.epcb2                    # PCB 源码
└── panel/                                  # 面板
    └── <面板名称>.epan2                    # 面板源码
```

### 各部分含义

- **`MyProject.eprj3`** — 工程索引与元数据文件，是创建工程时唯一生成的文件。
- **`sch/`** — 存放所有原理图。每个原理图有独立的文件夹，可包含一个或多个 `.esch2` 图页文件。
- **`pcb/`** — 存放所有 PCB 设计，文件格式为 `.epcb2`。
- **`panel/`** — 存放面板数据，文件格式为 `.epan2`。
- **`.ecfg` 文件** — 存放原理图级别的设计规则和配置。
- **`.evar` 文件** — 存放装配变量数据。

## 文件后缀说明

| 后缀      | 文件类型                         |
| --------- | -------------------------------- |
| `.eprj3`  | 工程索引与元数据                 |
| `.esch2`  | 原理图图页源码                   |
| `.ecfg`   | 原理图 / 工程设计规则与配置      |
| `.evar`   | 装配变量数据                     |
| `.epcb2`  | PCB 源码                         |
| `.epan2`  | 面板源码                         |

## 数据记录

每个源码文件（`.esch2`、`.epcb2`、`.epan2`）由一系列 JSON 记录组成。每条记录都是一个 JSON 对象，其类型由 `"type"` 字段决定。文件中没有特殊的分隔符行。

### 常见的 `type` 值

| `type`      | 含义                                                 |
| ----------- | ---------------------------------------------------- |
| `DOCHEAD`   | 文档头部，标识一个新文档的开始                       |
| `META`      | 当前文档的元数据                                     |
| `COMPONENT` | 已放置的元件 / 部件                                  |
| `ATTR`      | 其他对象的属性                                       |
| `WIRE`      | 导线线段                                             |
| `NETLABEL`  | 网络标签                                             |
| `PORT`      | 端口 / 连接器                                        |
| `TEXT`      | 文本对象                                             |
| `OBJ`       | 通用图形对象                                         |

### 文件片段示例

```
{"type":"DOCHEAD","ticket":534}||{"docType":"SCH_PAGE",...}|
{"type":"META","ticket":536,"id":"META"}||{"title":"CEM_GoldFinger",...}|
{"type":"COMPONENT","ticket":2,"id":"e1"}||{"locked":false,...}|
{"type":"ATTR","ticket":100,"id":"attr-1"}||{"key":"Footprint",...}|
{"type":"WIRE","ticket":1858,"id":"e3715"}||{"groupId":"",...}|
{"type":"DOCHEAD","ticket":10}||{"docType":"SYMBOL",...}|
```

> **注意：**文件就是一系列 JSON 记录，每条对象的作用由其 `"type"` 字段决定。

## 重要说明

- 工程名称由文件夹名和 `.eprj3` 文件名决定。
- 原理图图页、PCB、面板的名称以文件名为准。
- 该格式没有独立的工程库，器件、符号、封装均以独立文件形式存放在工程内。
- 导入工程时，未关联到已放置元件的游离库数据将被忽略。
- 真彩图（BLOB）和字体不单独存储，而是随引用它们的文档一起保存。
- 文档缩略图和工程预览结构树在该格式下不存储。

## 参考资料

如需了解完整的 嘉立创EDA专业版 / EasyEDA Pro 文件格式说明，请查看：

- **GitHub 仓库**: [easyeda/easyeda-pro-file-format](https://github.com/easyeda/easyeda-pro-file-format)
- **在线文档（英文）**: [https://prodocs.easyeda.com/en/format/index/](https://prodocs.easyeda.com/en/format/index/)
- **在线文档（中文）**: [https://prodocs.lceda.cn/cn/format/index/](https://prodocs.lceda.cn/cn/format/index/)
