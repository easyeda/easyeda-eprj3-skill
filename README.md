# EasyEDA Pro eprj3 Skill

从电路定义和 **AI 显式布局布线**生成、编辑和检查嘉立创 EDA 专业版（EasyEDA Pro）`.eprj3` 工程。

- **原理图**：AI 以资深电子工程师的角色设计符号位置、旋转、导线、电源符号及端口。
- **PCB**：AI 以资深 PCB Layout 工程师的角色决定板框、封装位置、铜层、走线宽度、拐点和过孔。
- **工具职责**：读取库几何、写入声明、校验格式、检查 ERC/DRC 和比对网表。不运行项目级自动布局。PCB 布线三选一：AI 显式声明 `pcb.tracks/vias`、EDA 客户端自动布线（`eda.js route`）、或 AI 生成布线脚本经 `eda.js run` 在客户端执行。可选 EasyEDA 客户端支持官方器件库、导入、截图、检查和已指定区域的铺铜填充。

## 快速开始

```bash
node scripts/build.js --design design.json --dir <project> --geometry
node scripts/build.js --design design.json --dir <project> --plan
node scripts/build.js --design design.json --dir <project> --report build.json
```

先用 `--geometry` 读取引脚和焊盘，再按 [几何字段与迁移指南](docs/ai-layout.md) 补全 `sch.place/wires`、`board` 和 `pcb.place/tracks/vias`。可参考 [双层走线示例](test/fixtures/ai-resistor-link.json)。旧设计、需求解析结果和电路模板不会自动生成布局布线。

- [AI 工作流程](SKILL.md)
- [电路与构建字段](docs/build.md)
- [检查说明](docs/checks.md)
- [客户端桥接](docs/cli.md)
- [增量编辑与工程交付](docs/workflow.md)

For English instructions see the [AI layout contract](docs/ai-layout.md), [build reference](docs/build.md), and [client CLI](docs/cli.md).

[MIT License](LICENSE)
