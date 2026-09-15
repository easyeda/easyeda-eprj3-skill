# 开发/进阶参考

普通用户只需按 [`README.md`](../README.md) 的描述与 AI 对话即可，无需阅读本文档。本文档面向想手动调用脚本、扩展 skill 或了解工程结构的开发者。

## 仓库结构

```
easyeda-eprj3-skill/
├── SKILL.md               ← AI 助手入口
├── README.md              ← 用户入口
├── CHANGELOG.md           ← 版本记录
├── package.json
├── scripts/               ← 所有脚本
│   ├── init.js
│   ├── add-symbol.js
│   ├── add-footprint.js
│   ├── add-wire.js
│   ├── add-netlabel.js
│   ├── add-text.js
│   ├── add-shape.js
│   ├── add-pcb-text.js
│   ├── add-pcb-shape.js
│   ├── add-track.js
│   ├── add-via.js
│   ├── add-pour.js
│   ├── add-fill.js
│   ├── add-region.js
│   ├── set-refdes.js
│   ├── load-library.js
│   ├── generate-symbol.js
│   ├── generate-footprint.js
│   ├── validate.js
│   ├── cleanup.js
│   ├── open.js
│   └── lib/               ← 共享读写模块
├── templates/library/     ← 内置预设符号/封装库
├── examples/              ← 示例工程
├── docs/                  ← 格式说明
└── test/                  ← 回归测试
```

## 脚本速查

| 命令 | 作用 |
|---|---|
| `node scripts/init.js` | 新建 `.eprj3` 工程（原理图 + PCB） |
| `node scripts/load-library.js list/show/remove` | 查看/管理内置库 |
| `node scripts/add-symbol.js` | 放置原理图符号、电源、端口 |
| `node scripts/add-footprint.js` | 放置 PCB 封装并绑定焊盘网络 |
| `node scripts/add-wire.js` | 画原理图导线 |
| `node scripts/add-netlabel.js` | 放置网络标签 |
| `node scripts/add-text.js` | 原理图文本 |
| `node scripts/add-shape.js` | 原理图图形（矩形/多边形/圆等） |
| `node scripts/add-track.js` | PCB 走线 |
| `node scripts/add-via.js` | PCB 过孔 |
| `node scripts/add-pcb-shape.js` | PCB 图形 |
| `node scripts/add-pcb-text.js` | PCB 文本 |
| `node scripts/add-pour.js` | 铺铜 |
| `node scripts/add-fill.js` | 静态铜填充 |
| `node scripts/add-region.js` | 禁止区域 |
| `node scripts/set-refdes.js` | 设置/重排位号 |
| `node scripts/generate-symbol.js` | 从引脚定义生成临时符号 |
| `node scripts/generate-footprint.js` | 从焊盘定义生成临时封装 |
| `node scripts/validate.js` | 验证工程格式 |
| `node scripts/cleanup.js` | 清理临时生成的库文件 |
| `node scripts/open.js` | 在 EasyEDA Pro 客户端打开工程 |

## 脚本用法示例

如果你不想通过 AI，也可以手动按下面流程执行。所有坐标单位为 mil。

### 1. 初始化工程

```bash
node scripts/init.js --dir ./myboard --name myboard
```

可用 `--board-w 4000 --board-h 3000` 指定板框尺寸。

### 2. 查看预设库

```bash
node scripts/load-library.js list
```

### 3. 放置原理图符号、电源或端口

```bash
node scripts/add-symbol.js --dir ./myboard --sch Schematic1 --sheet P1 --symbol RES --footprint R0603 --x 300 --y -440
node scripts/add-symbol.js --dir ./myboard --sch Schematic1 --sheet P1 --symbol VCC --x 300 --y -500
```

### 4. 连线并标注网络

```bash
node scripts/add-wire.js --dir ./myboard --sch Schematic1 --sheet P1 --segs "300,-420,300,-380" --net SIG
node scripts/add-netlabel.js --dir ./myboard --sch Schematic1 --sheet P1 --net SIG --at 300,-400
```

### 5. 整理位号

```bash
node scripts/set-refdes.js renumber --dir ./myboard --sch Schematic1 --sheet P1 --prefix R
```

### 6. PCB 布局布线

```bash
node scripts/add-footprint.js --dir ./myboard --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:SIG"
node scripts/add-track.js --dir ./myboard --pcb PCB1 --net SIG --x1 300 --y1 316.54 --x2 450 --y2 316.54
node scripts/add-via.js --dir ./myboard --pcb PCB1 --x 700 --y 316.54 --net SIG
node scripts/add-pour.js rect --dir ./myboard --pcb PCB1 --net GND --x 100 --y 100 --w 3800 --h 2800
```

### 7. 验证并打开

```bash
node scripts/validate.js --dir ./myboard
node scripts/open.js open --dir ./myboard
```

完整 showcase 见 `examples/blink/`，它演示了如何放置所有内置预设模板。

## 测试

```bash
npm test
```

会生成一个临时工程并做 121+ 项断言检查，确认格式符合官方示例约定。

## 进阶文档

- `docs/format-reference.md`：`.eprj3` 内部格式参考。
- `SKILL.md`：给 AI 助手看的完整工作流。
- `CHANGELOG.md`：版本变更记录。

## 许可

MIT。详见 `LICENSE`。
