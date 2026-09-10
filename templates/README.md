# Templates

最小合法 `.eprj3` 工程骨架的参考文件。由 `scripts/init.js` 实际生成（同一套记录构造代码），当 Agent 不便执行脚本时，可直接复制这些文件作为手工起点。

| File | 用途 |
| --- | --- |
| `project-index.eprj3` | 工程索引文件。放入工程根目录并重命名为 `<工程名>.eprj3`，改掉其中的 `name` 字段（uuid 可保持原样） |
| `sheet.esch2` | 空白原理图图页容器（图框 SYMBOL/DEVICE docs + SCH_PAGE 主文档）。放入 `sch/<原理图名>/` 并重命名为 `<图页名>.esch2` |
| `schematic.ecfg` | 原理图配置（4 条记录：DOCHEAD+META+RULE+RULE），随原理图同名放置：`sch/<原理图名>/<原理图名>.ecfg` |
| `schematic.evar` | 原理图变量文件（保持为空），同目录放置 |
| `pcb.epcb2` | 空白 PCB（LAYER 前导 + 空 NET + 板框）。放入 `pcb/` 并重命名为 `<PCB名>.epcb2` |
| `panel.epan2` | 拼板文件（可选，仅用户要求拼板时才需要）。放入 `panel/<拼板名>.epan2` |

目录约定与记录格式见 [docs/format-reference.md](../docs/format-reference.md)；完整可打开的示例工程见 [examples/blink](../examples/blink)。

## Library（预置元件模板）

`library/{symbol,footprint}/` 是随 skill 分发的**预置模板库**。放置元件时**优先**在这里解析（add-symbol/add-footprint 预置优先���；预置没有的才用 generate-*/load-library 生成工程临时条目（写 `<project>/.tmp/library/`，完工后 cleanup.js 删除）。

约定：

- **文件名 = 条目 name = title**（文档内 META title 一致）；自定义条目不得与预置同名（generate-*/load-library 会拒绝，放置时预置优先）
- `symbol/` 条目 kind：`symbol`（普通元件，symbolDoc+placement）、`power`（电源/地标志，net+style）、`port`（网络端口，net）、`special`（差分对/短路等特殊标志）
- `footprint/` 条目 kind `footprint`：footprintDoc + footprintElems（PAD elemId 与 Footprint/Designator ATTR id）+ attrZ
- 普通元件不暂存 DEVICE 文档：add-symbol/add-footprint 放置时现场合成；power/port/special 条目内嵌的 DEVICE doc 在嵌入前改写为工程 client
- 来源：elibu 为真实客户端导出（`scripts/tools/split-elibu.js` 拆解），blink 为 examples/blink 派生

symbol 预置：

| Name | kind | 说明 |
| --- | --- | --- |
| `RES` `CAP` `IND` `DIODE` `TEST_POINT` | symbol | 常用元件（designator R?/C?/L?/D?/TP?） |
| `LED` | symbol | 发光二极管（designator D?，blink 派生） |
| `GND` `AGND` `PGND` | power | 地标志（style down，net 同名） |
| `5V` `VCC` | power | 电源标志（style up，net 同名） |
| `PORT_IN` `PORT_OUT` `PORT_BI` | port | NetPort（net IN/OUT/BI） |
| `OFFPAGE_IN` `OFFPAGE_OUT` `OFFPAGE_BI` | port | 离图连接器（net IN/OUT/BI） |
| `DIFF_PAIR` `SHORT` | special | 差分对标志 / 短路标志（放置未经真机验证） |
| `A4` `A3` | symbol | 图框符号（仅作参考，图页框架由 init.js 自动放置） |

footprint 预置：

| Name | pads | designator | 说明 |
| --- | --- | --- | --- |
| `R0402` `R0603` | 2 | R? | 电阻封装 |
| `C0402` `C0603` | 2 | C? | 电容封装（0402 为 R0402 几何派生） |
| `L0402` `L0603` | 2 | L? | 电感封装（0402 为 R0402 几何派生） |
| `LED0603` | 2 | D? | LED 封装（blink 派生） |
| `SMA` | 2 | U? | SMA 二极管封装（1N4007 配套） |
| `TP0.5` | 1 | U? | 测试点 0.5mm |

查看与检索：`node scripts/load-library.js list`（加 `--dir` 同时列出工程临时条目）、`show --name <条目>`。

验证手工搭建的工程：

```bash
node scripts/validate.js --dir <工程目录>
```

注意：索引文件 `profile` 里登记的 schematic/sheet/pcb uuid 必须与对应文档 DOCHEAD 里的 uuid 一致，重命名文件后不要改动 uuid。
