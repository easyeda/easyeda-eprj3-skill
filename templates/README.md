# Templates

最小合法 `.eprj3` 工程骨架的参考文件。由 `scripts/init.js` 实际生成（同一套记录构造代码），当 Agent 不便执行脚本时，可直接复制这些文件作为手工起点。

| File | 用途 |
| --- | --- |
| `project-index.eprj3` | 工程索引文件。放入工程根目录并重命名为 `<工程名>.eprj3`，改掉其中的 `name` 字段（uuid 可保持原样） |
| `sheet.esch2` | 空白原理图图页容器（图框 SYMBOL/DEVICE docs + SCH_PAGE 主文档）。放入 `sch/<原理图名>/` 并重命名为 `<图页名>.esch2` |
| `schematic.ecfg` | 原理图配置（4 条记录：DOCHEAD+META+RULE+RULE），随原理图同名放置：`sch/<原理图名>/<原理图名>.ecfg` |
| `schematic.evar` | 原理图变量文件（保持为空），同目录放置 |
| `pcb.epcb2` | 空白 PCB（LAYER 前导 + 空 NET + 板框）。放入 `pcb/` 并重命名为 `<PCB名>.epcb2` |
| `panel.epan2` | 拼板文件。放入 `panel/Panel1.epan2` |

目录约定与记录格式见 [docs/format-reference.md](../docs/format-reference.md)；完整可打开的示例工程见 [examples/blink](../examples/blink)。

验证手工搭建的工程：

```bash
node scripts/validate.js --dir <工程目录>
```

注意：索引文件 `profile` 里登记的 schematic/sheet/pcb uuid 必须与对应文档 DOCHEAD 里的 uuid 一致，重命名文件后不要改动 uuid。
