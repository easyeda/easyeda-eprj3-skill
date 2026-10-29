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
│   ├── add-pcb-text.js
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
| `node scripts/add-pcb-shape.js` | PCB 图形 |
| `node scripts/add-pcb-text.js` | PCB 文本 |
| `node scripts/add-region.js` | 禁止区域 |
| `node scripts/set-refdes.js` | 设置/重排位号 |
| `node scripts/generate-symbol.js` | 从引脚定义生成临时符号 |
| `node scripts/generate-footprint.js` | 从焊盘定义生成临时封装 |
| `node scripts/validate.js` | 验证工程格式 |
| `node scripts/erc.js` | 电气规则检查（E001–E007） |
| `node scripts/intent.js` | 设计意图门禁（极性/去耦/分压比，I001–I006） |
| `node scripts/lint-layout.js` | 原理图布局审查（L001–L010） |
| `node scripts/drc.js` | 铜皮审查（D001–D012，含 DFM；本 skill 自建的板恒为 placed-only，自动跳过 D004/D006，`--placed-only`/`--routed` 可强制；导入/客户端返存的板仍完整判铜） |
| `node scripts/autofix.js` | 机械修复：NC、补去耦电容 |
| `node scripts/build.js` | design.json 一键构建 + 全部门禁；**只布局**（本 skill 永不布线/铺铜，铜皮在客户端完成；构建输出含 `rats:` 交接清单）；`--plan` 只打印方案摘要并真实预演，不写盘（人工确认点） |
| `node scripts/intake.js` | 需求采集：`template`/`fields`/`check`（追问协议）/`resolve`（recipe 选型 + 电源链推导 + 线宽注记，选型结果缓存于 `.cache/`） |
| `node scripts/recipe.js` | 子电路模板 list/show/apply（与 intake 共用 `scripts/lib/merge.js` 合并引擎） |
| `node scripts/eval.js` | 回归基准（`--diff` 对比历史、`--design` 度量新设计；逐案记录 ~tokens 与秒数） |
| `node scripts/depcheck.js` | 自研合规扫描：全部 require/import 必须是 Node 内置或本仓库相对路径（`npm run depcheck`） |
| `node scripts/cleanup.js` | 清理临时生成的库文件 |
| `node scripts/render.js --dir <p> [--png]` | 预览：每个原理图页 + PCB 各一张 SVG；`--png [--scale 2]` 再栅格化成 PNG（无头浏览器：Windows 默认 Edge，`EPRJ3_BROWSER` 可覆盖。**注意**：某些机器上无头浏览器能启动却不产图，脚本会明确报错并提示手工打开 SVG） |
| `node scripts/open.js` | 打开工程：默认交给系统文件关联（等价双击 `.eprj3`），`--client` 可指定 exe |

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

### 6. PCB 布局（交付物就是布局）

`build.js` 只放置封装、绑定焊盘网络、生成板框——**永不布线、永不铺铜**。想精确控制某个元件的落位，用 `add-footprint.js` 显式落位或在 design 里写 `pcb.place`；走线/过孔/铺铜一律在 EasyEDA 客户端完成，`build.js` 打印的 `rats:` 行就是要手工连接的网络清单。

```bash
# 布局（交付内容）
node scripts/add-footprint.js --dir ./myboard --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:SIG"
# 禁布区不是铜皮，仍由脚本维护
node scripts/add-region.js rect --dir ./myboard --pcb PCB1 --prohibit "COMPONENT,TRACK" --x 200 --y 200 --w 300 --h 200
```

### 7. 验证并打开

```bash
node scripts/validate.js --dir ./myboard
node scripts/open.js open --dir ./myboard
```

完整 showcase 见 `examples/blink/`，它演示了如何放置所有内置预设模板。

## 测试

```bash
npm test        # smoke + pipeline + dfm + corpus + depcheck 全链
```

- `node test/smoke.js`：生成临时工程做断言，确认格式符合官方示例约定（条数以 `npm test` 输出为准）。
- `node test/pipeline.js`：声明式构建链路（design.json → build → 五门禁）回归（条数以 `npm test` 输出为准）。
- `node test/dfm.js`：DFM 规则 D009–D012 的触发/不触发/边界断言（阈值 override、score 扣减、真实产物零新增）。
- `node test/corpus.js`：**合法/非法语料**——真实构建链产出合法基线，再对副本做最小篡改（`test/corpus/*.json` 声明清单），断言 validate/erc/lint/drc 必须按 `expect` 报出对应 code；检查器抓不到的变体标 `expect:{leak:true}` 记为已知盲区（`--probe` 重新观察实际输出以维护清单）。
- `node scripts/depcheck.js`：全仓 `.js` 的 require/import 只允许 Node 内置与本仓库相对路径；`package.json` 依赖字段必须为空；无 `node_modules/`。

## 迭代协议：让每次失败都让 skill 变好

本 skill 的改进是闭环的：**失败案例 → 最小复现 → 规则/参数沉淀 → 回归保护**。发现新的失败模式时按下面三步走：

### 1. 新错误模式 → 新检查规则 + 最小复现 case

1. 把触发问题的 design.json 缩到最小，放进 `examples/designs/`（或直接写进 test 断言）。
2. 在 `scripts/lib/{erc,intent,lint,drc}.js` 加一条能抓住它的规则（每个 finding 必须带 `fix` 字段——告诉 agent 怎么改 design）。
3. 跑 `node scripts/eval.js`：确认新 case 从 FAIL 变 PASS，且 20+ 个旧 case 无回归（`--diff` 对比上次，token/秒数回归同样可见）。

### 2. 可复用电路 → recipe（带 params）

一段电路被第二次手写时，就应该变成 recipe：

1. 从最接近的现有 recipe 复制，改成新电路；把阻容、频率、电压这些每次会变的值提为 `params`（见 `recipe/ldo-3v3.json` 的写法）。
2. `node scripts/recipe.js list` 确认能列出；`recipe.js show <name>` 能看到 parts/nets。
3. `eval.js` 会自动把 `recipe/*.json` 当 case 构建——保持它 lint/drc 满分。

### 3. 每次改脚本 → eval 对比基线

```bash
node scripts/eval.js --all --diff   # 跑全部 case 并与上一次历史对比
node scripts/eval.js --diff --since 2 # 只对比：最近一次 vs 倒数第二次
node scripts/eval.js --diff         # 只对比最近两次，不重新构建
node scripts/eval.js --design my-new-design.json   # 用同一把尺子度量新设计
```

`eval/history.jsonl` 是唯一的真相来源：分数回归（lint/drc 下降、用例从 PASS 变 FAIL）必须先修复再提交。版本号与 CHANGELOG 按 `CHANGELOG.md` 顶部约定同步。

### 决策速查（写给 agent 的"少思考"表）

| 问题 | 答案 |
| --- | --- |
| `board` 尺寸不确定？ | 可省略——build 会按元件数自动扩板并打印一行提示 |
| 什么时候降 `pcb.rules`？ | 0.5mm pitch（QFN/QFP/USB-C）→ `clearance 6, trackWidth 6`；常规 0603 → 默认（这些值是 DRC 判放置与导入铜的下限，不再有路由器参数） |
| 电源线多宽？ | `nets: { "<电源网>": { "width": 30 } }`——**仅注记**（按电流推导线宽的交接信息，并在 DRC 判导入铜时作为该网下限）；本 skill 不布线 |
| 未用引脚怎么接？ | 全部映射到 `"NC"`——ERC 会放行 |
| IC 没去耦电容？ | `node scripts/autofix.js --design <file> --diff` 先看差异（自动补 100nF），确认后再去掉 `--diff` 写入 |
| 封装库里没有？ | `"footprint": { "auto": "LQFP48" }`（SOP/QFN/DIP/HDR/SOT23-5/USB-C 等都支持）或手写 inline pads |
| 电路原理怎么保证？ | `parts[].polarity` + `expect` 块（decoupling/pairs/valueRange/divider），第五道门禁查 |
| 用户只给了一句话需求？ | 走 intake：`intake.js check --req`（缺必填→一次问完）→ `resolve`（选型+电源链+规则推导）→ `build.js --plan`（确认）→ `build.js` |
| 交付板要布线/铺铜怎么办？ | 超出本 skill 范围——永不布线、永不铺铜，铜皮在 EasyEDA 客户端人工完成；`build.js` 打印 `rats:` 交接清单（待手工连接的网络与焊盘数） |
| 导入/客户端返存的板 DRC 一片 D001？ | 那是文件里已有的铜（本 skill 自建的板没有铜）——在客户端调整或删除相应铜线；根因若是焊盘太近，改 `pcb.place`/`pcb.rules.clearance` 后 `build.js --force` 重放布局，再做铜 |
| LDO 该接输入轨还是上一级的 5V？ | 接"高于自身输出的最近轨"（12V→buck→5V→ldo→3V3）；intake 的 upstream 推导已处理，压差过大只告警不改 BOM |
| 构建前想给用户过目？ | `build.js --plan`：真实预演（lint/drc 分数是真的），目标目录零写入 |
| 怎么证明零第三方依赖？ | `node scripts/depcheck.js`（`npm run depcheck`，已串进 `npm test`） |

## 库数据维护（需联网，仅限维护会话）

> **运行时（build/validate/render 等一切使用场景）零联网**——skill 只读随仓
> 库提交的固化数据。本章节是**维护者新增/校准库数据**的流程，由维护会话执行，
> 不属于 skill 的日常使用。

新增 IC 条目（`templates/library/ic/`）优先用现成脚本抓取并转换（输出即条目
格式，evidence 三来源自动填写）：

```bash
node scripts/fetch-lcsc.js --id C8734 --install   # 官方库逐字 → IC 条目
node scripts/fetch-lcsc.js --id C8734             # 仅打印转换结果
```

脚本不可达（器件不在官方库/网络受限）时再按以下手动流程从官方库抓取样例器件数据：

```
https://easyeda.com/api/products/{LCSC}/components
```

- 返回 `result.packageDetail.dataStr`（封装）与 `result.dataStr`（符号），
  `shape` 数组内是 `PAD~…` / `P~…` 记录（单位 10 mil，y 向下；换算到本 skill
  的 mil/Y-up）。
- 符号引脚记录 `P~show~<electric>~<num>~<dotX>~<dotY>~<rot>~…`：官方库
  electric 字段恒为 Unspecified，**方向由确定性命名规则标注**（VDD/VSS/GND/
  VIN/VOUT/VBAT/VDDA/VSSA → W；其余不标）。
- 封装焊盘逐字转换（IC 条目），或回填 `fp-auto.js` 家族公式常数；引用块
  （evidence）必须同时给出：官方库 part id + API URL、封装出处、datasheet
  URL，三项缺一不可。
- 同一提交内：更新 [footprint-evidence.md](footprint-evidence.md) 出处表 +
  `test/dfm.js` 断言（引脚数/关键尺寸）。

已按此流程固化的样例：C2145（SOT-23）、C82942（SOT-23-5）、C7950（SOIC-8）、
C6186（SOT-223 + AMS1117 条目）、C8734（LQFP-48 + STM32 条目）、C24112
（QFN-24）、C165948（USB-C）、C21190（R0603）。

## 进阶文档

- `docs/format-reference.md`：`.eprj3` 内部格式参考。
- `SKILL.md`：给 AI 助手看的完整工作流。
- `CHANGELOG.md`：版本变更记录。

## 许可

MIT。详见 `LICENSE`。
