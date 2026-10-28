# 嘉立创EDA专业版文件夹化工程格式 `.eprj3` / EasyEDA Pro Folder-Based Project Format `.eprj3`

**[English](#en)** | **[中文](#zh)** 

---

<a id="en"></a>

## English

### What is `.eprj3`?

`.eprj3` is the folder-based project format for **EasyEDA Pro** (嘉立创EDA专业版). Where the legacy `eprj`/`.eprj2` format packs an entire project into a single SQLite database file, `.eprj3` splits it into a directory of JSON and plain-text files — Git-friendly, easy for scripts and AI tools to read and edit, and transparent by structure.

### Project Folder Layout

```
MyProject/                          # Project root (project name = folder name & .eprj3 file name)
├── MyProject.eprj3                 # Project index and metadata: the only file created up front
├── sch/                            # Schematics, one folder per schematic
│   └── <schematic title>/
│       ├── <sheet title>.esch2     # Schematic sheet source
│       ├── <schematic title>.ecfg  # Design rules & configuration for this schematic
│       └── <schematic title>.evar  # Assembly variant data
├── pcb/
│   └── <pcb title>.epcb2           # PCB source
└── panel/
    └── <panel title>.epan2         # Panel source
```

Sheet, PCB, and panel names are taken from their file names.

### Data Records

Each source file (`.esch2`, `.epcb2`, `.epan2`) is simply a sequence of JSON records — one object per line, with its role determined by the `"type"` field. There are no special delimiter lines. Common types: `DOCHEAD` (document header, starts a document), `META` (document metadata), `COMPONENT`, `ATTR`, `WIRE`, `NETLABEL`, `PORT`, `TEXT`, and `OBJ` (generic graphical object).

```
{"type":"DOCHEAD","ticket":534}||{"docType":"SCH_PAGE",...}|
{"type":"META","ticket":536,"id":"META"}||{"title":"CEM_GoldFinger",...}|
{"type":"COMPONENT","ticket":2,"id":"e1"}||{"locked":false,...}|
{"type":"ATTR","ticket":100,"id":"attr-1"}||{"key":"Footprint",...}|
{"type":"WIRE","ticket":1858,"id":"e3715"}||{"groupId":"",...}|
```

### Notes

- There is no separate project library: devices, symbols, and footprints live as individual files inside the project.
- On import, loose library data not referenced by placed components is ignored.
- Images (BLOB) and fonts are not standalone files — they travel with the document that references them. Thumbnails and project preview trees are not stored.

### References

For the complete specification:

- **Format specification**: [easyeda/easyeda-pro-file-format](https://github.com/easyeda/easyeda-pro-file-format)
- **Format skill (primitive / document data generation)**: [easyeda/easyeda-pro-format-skill](https://github.com/easyeda/easyeda-pro-format-skill)
- **Project skill (AI generates `.eprj3` projects directly)**: [easyeda/easyeda-eprj3-skill](https://github.com/easyeda/easyeda-eprj3-skill)
- **Online docs**: [English](https://prodocs.easyeda.com/en/format/index/) · [中文](https://prodocs.lceda.cn/cn/format/index/)



<a id="zh"></a>

## 中文

### `.eprj3` 是什么

`.eprj3` 是 **嘉立创EDA专业版 / EasyEDA Pro** 的文件夹化工程存储格式。旧版 `eprj`/`.eprj2` 把整个工程塞进一个 SQLite 数据库文件，`.eprj3` 则把工程拆成一个由 JSON 与纯文本文件组成的目录，因此对 Git 版本控制、脚本与 AI 工具都友好，结构一目了然。

### 工程目录结构

```
MyProject/                          # 工程根目录（工程名取自文件夹名与 .eprj3 文件名）
├── MyProject.eprj3                 # 工程索引与元数据：创建工程时唯一生成的文件
├── sch/                            # 原理图，每张原理图独立成文件夹
│   └── <原理图名称>/
│       ├── <图页标题>.esch2        # 原理图图页源码
│       ├── <原理图名称>.ecfg       # 该原理图的设计规则与配置
│       └── <原理图名称>.evar       # 装配变量数据
├── pcb/
│   └── <PCB 名称>.epcb2            # PCB 源码
└── panel/
    └── <面板名称>.epan2            # 面板（拼板）源码
```

原理图图页、PCB、面板的名称均以文件名为准。

### 数据记录

源码文件（`.esch2`、`.epcb2`、`.epan2`）就是一串 JSON 记录，每行一条对象，对象类型由 `"type"` 字段决定，文件中没有特殊的分隔符行。常见类型：`DOCHEAD`（文档头，标识文档开始）、`META`（文档元数据）、`COMPONENT`（元件）、`ATTR`（属性）、`WIRE`（导线）、`NETLABEL`（网络标签）、`PORT`（端口）、`TEXT`（文本）、`OBJ`（通用图形对象）。

```
{"type":"DOCHEAD","ticket":534}||{"docType":"SCH_PAGE",...}|
{"type":"META","ticket":536,"id":"META"}||{"title":"CEM_GoldFinger",...}|
{"type":"COMPONENT","ticket":2,"id":"e1"}||{"locked":false,...}|
{"type":"ATTR","ticket":100,"id":"attr-1"}||{"key":"Footprint",...}|
{"type":"WIRE","ticket":1858,"id":"e3715"}||{"groupId":"",...}|
```

### 注意事项

- 没有独立的工程库：器件、符号、封装都以独立文件形式存放在工程内。
- 导入工程时，未关联到已放置元件的游离库数据会被忽略。
- 真彩图（BLOB）与字体不单独存文件，随引用它们的文档一起保存；文档缩略图与工程预览结构树不存储。

### 参考资料

完整格式说明请查看：

- **格式规范仓库**：[easyeda/easyeda-pro-file-format](https://github.com/easyeda/easyeda-pro-file-format)
- **格式 Skill（图元/文档数据生成）**：[easyeda/easyeda-pro-format-skill](https://github.com/easyeda/easyeda-pro-format-skill)
- **工程 Skill（AI 直接生成 `.eprj3` 工程）**：[easyeda/easyeda-eprj3-skill](https://github.com/easyeda/easyeda-eprj3-skill)
- **在线文档**：[英文](https://prodocs.easyeda.com/en/format/index/) · [中文](https://prodocs.lceda.cn/cn/format/index/)

---
