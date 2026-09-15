# easyeda-eprj3-skill

> 用 AI 或几条 Node 命令，生成可在 EasyEDA Pro（嘉立创 EDA 专业版）直接打开的 `.eprj3` 工程。

**当前版本：1.7.2** · [更新记录](CHANGELOG.md)

---

## AI 一键安装口令

把下面这句话直接发给你的 AI 助手即可开始：

> AI 助手，请帮我安装 easyeda-eprj3-skill，环境 Node.js ≥ 18，并初始化一个示例工程。

## 安装

- 需要 [Node.js](https://nodejs.org/) ≥ 18（已在 Windows 11 + Node 24 验证），**无需 npm 依赖**。
- 需要 EasyEDA Pro / LCEDA Pro 离线客户端，只在最后一步 `open` 用到。

```bash
git clone https://github.com/easyeda/easyeda-eprj3-skill
cd easyeda-eprj3-skill
npm test            # 可选：跑一遍完整回归测试，确认环境正常
```

> 不想敲命令？把本页复制给 AI，让它帮你安装、初始化并执行后续步骤。

## 快速上手（8 步）

每步都很短，按顺序执行即可。

1. **初始化工程**
   ```bash
   node scripts/init.js --dir ./myboard --name myboard
   ```
   可用 `--board-w 4000 --board-h 3000` 指定板框尺寸（单位 mil）。

2. **查看预设库**
   ```bash
   node scripts/load-library.js list
   ```
   内置了常用电阻、电容、电感、二极管、LED、测试点、电源符号、网络端口等。

3. **放置原理图符号、电源或端口**
   ```bash
   node scripts/add-symbol.js --dir ./myboard --sch Schematic1 --sheet P1 --symbol RES --footprint R0603 --x 300 --y -440
   ```

4. **连线并标注网络**
   ```bash
   node scripts/add-wire.js --dir ./myboard --sch Schematic1 --sheet P1 --segs "300,-420,300,-380" --net SIG
   node scripts/add-netlabel.js --dir ./myboard --sch Schematic1 --sheet P1 --net SIG --at 300,-400
   ```
   提示：`--segs` 是一串 `x,y` 坐标，相邻两点自动连成线段。

5. **整理位号**
   ```bash
   node scripts/set-refdes.js renumber --dir ./myboard --sch Schematic1 --sheet P1 --prefix R
   ```

6. **放置 PCB 封装并继续布线、过孔、铺铜**
   ```bash
   # 放置封装并绑定焊盘网络
   node scripts/add-footprint.js --dir ./myboard --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:SIG"
   # 再走线、打过孔、铺 GND 铜皮
   node scripts/add-track.js --dir ./myboard --pcb PCB1 --net SIG --x1 300 --y1 316.54 --x2 450 --y2 316.54
   node scripts/add-via.js --dir ./myboard --pcb PCB1 --x 700 --y 316.54 --net SIG
   node scripts/add-pour.js rect --dir ./myboard --pcb PCB1 --net GND --x 100 --y 100 --w 3800 --h 2800
   ```

7. **验证工程格式**
   ```bash
   node scripts/validate.js --dir ./myboard
   ```

8. **用 EasyEDA Pro 客户端打开**
   ```bash
   node scripts/open.js open --dir ./myboard
   ```

## 最小示例命令流

```bash
node scripts/init.js --dir ./myboard --name myboard
node scripts/load-library.js list
node scripts/add-symbol.js --dir ./myboard --sch Schematic1 --sheet P1 --symbol RES --footprint R0603 --x 300 --y -440
node scripts/add-symbol.js --dir ./myboard --sch Schematic1 --sheet P1 --symbol VCC --x 300 --y -500
node scripts/add-wire.js --dir ./myboard --sch Schematic1 --sheet P1 --segs "300,-460,300,-440" --net VCC
node scripts/add-footprint.js --dir ./myboard --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:GND"
node scripts/add-pour.js rect --dir ./myboard --pcb PCB1 --net GND --x 100 --y 100 --w 3800 --h 2800
node scripts/validate.js --dir ./myboard
node scripts/open.js open --dir ./myboard
```

> 完整 showcase 见 `examples/blink/`，它演示了如何放置所有内置预设模板。

## 开发/进阶参考

以下内容在你跑通上面的步骤之后再看。

### 仓库结构

```
easyeda-eprj3-skill/
├── SKILL.md               ← AI 助手入口
├── README.md              ← 本文件
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

### 脚本速查

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

### 测试

```bash
npm test
```

会生成一个临时工程并做 121+ 项断言检查，确认格式符合官方示例约定。

### 进阶文档

- `docs/format-reference.md`：`.eprj3` 内部格式参考。
- `SKILL.md`：给 AI 助手看的完整工作流。
- `CHANGELOG.md`：版本变更记录（当前 1.7.1）。

### 许可

MIT。详见 `LICENSE`。
