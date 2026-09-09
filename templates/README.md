# Templates

最小合法 `.eprj3` 工程骨架的参考文件。`scripts/init.js` 生成的工程与此同构（同一套记录构造代码）；当 Agent 不便执行脚本时，可直接复制这些文件作为手工起点。

| File | 用途 |
| --- | --- |
| `project-index.eprj3` | 工程索引文件。重命名为 `<工程名>.eprj3`，改掉其中的 `name` 字段 |
| `sheet.esch2` | 空白原理图图页（DOCHEAD + META + CANVAS）。放入 `sch/<原理图名>/` 并重命名为 `<图页名>.esch2` |
| `pcb.epcb2` | 空白 PCB（含默认 LAYER 定义）。放入 `pcb/` 并重命名 |
| `schematic.ecfg` | 原理图配置文件，随图页同名放置 |
| `schematic.evar` | 原理图变量文件，随图页同名放置 |

验证手工搭建的工程：

```bash
node scripts/validate.js check --dir <工程目录> --strict
```

各记录类型的字段说明见 [docs/format-reference.md](../docs/format-reference.md)。
