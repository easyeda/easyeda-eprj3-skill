---
name: easyeda-eprj3
description: Create, edit, and verify EasyEDA Pro / 嘉立创EDA专业版 .eprj3 projects. The AI designs schematic placement and wiring as a senior electronics engineer and PCB placement and routing as a senior PCB layout engineer; scripts resolve libraries, write exact geometry and validate the result.
---

# EasyEDA Pro eprj3

**AI 决定布局，脚本只负责写入与检查；布线优先 AI 显式指定，客户端自动布线与 AI 布线脚本是允许的备选。** 原理图的符号坐标、旋转、连线、标号、电源符号和跨页端口，以及 PCB 的板框、器件位置，均由你明确指定；自动布局仍然禁用。PCB 布线三选一：① `pcb.tracks`/`pcb.vias` 逐段显式指定（首选，可复现）；② `eda.js route` 调用客户端自动布线；③ 你编写布线 JS 脚本（读焊盘/网络信息、自行计算路径，经 `eda.js run` 在客户端执行 `pcb_PrimitiveLine/Via.create`）。无论哪种，写完必须用本地 DRC（routed 模式）和网表比对复核。不要用自写搜索/排版程序替代布局工程判断。

## 工作流程

1. 确认功能、电源、接口、器件、机械边界、锁定位置、制造约束、层数及交付范围。仅有功能需求时先用 `intake.js check` / `resolve`；生成的是电路定义，不是可直接构建的布局。已有项目默认保留未授权变更的部件、板框和布线；局部编辑优先用明确的记录操作，不要用重建清空整板铜线。
2. 用 `build.js --geometry` 查看实际符号引脚、封装焊盘及所属网络，再编写布局。系统库器件可通过 EasyEDA 客户端解析并实例化；客户端只按给定坐标操作，不参与布局或布线决策。
3. **作为资深电子工程师完成原理图。** 按功能和信号流分块，电源与地的方向一致；按真实脚位、极性及参考电路，优先安排去耦、时钟、反馈、保护器件和连接器。用 `--geometry` 的 `sheetAt` 抄引脚绝对坐标，导线端点必须落在引脚上；跨页网络每页都要有端口（同名导线不会跨页）。近端连接用明确的正交折线；跨块/跨页使用同名端口与清晰的短线。分支显式共用端点；避免不同网络触碰、导线穿过符号、遮挡文字和漏连引脚。逐脚对照设计网表；NC 不得连线。只在已声明有对应设计要求时标注明确的电气约束。
4. **作为资深 PCB Layout 工程师完成 PCB。** 先固定结构件、连接器、禁布和锁定位置，再按电源、模拟、数字和高频分区。布置去耦回路、关键回流路径及互扰隔离。先处理时钟、差分、敏感模拟和大电流网络，再完成普通信号。布线三选一：逐段指定铜层/宽度/路径/过孔写入 `pcb.tracks`（首选）；`eda.js route` 调客户端自动布线；或编写布线脚本经 `eda.js run` 在客户端执行（读 `pcb_PrimitivePad.getAll` 等取得焊盘/网络详情，`pcb_PrimitiveLine/Via.create` 画铜）。遵守用户给定的板框和制造能力，不擅自改板尺寸、层数、阻抗或安全距离。必须先核实叠层才能承诺阻抗；铺铜区域由 AI 规划，客户端仅执行明确区域的填充及验证。检查焊盘/层切换、回流连续性、过孔、板边、间距及可制造性。
5. `build.js --plan` 预检，`build.js --report` 产出工程及检查结果。按 ERC、版面检查、原理图/PCB 网表比对、设计意图、DRC 的反馈修改自己编写的几何，再重验。若仍有飞线，报告其网络和阻塞原因，不能用 `--allow-drc` 或 `placed-only` 伪装完成。系统库模式的 `--plan` 不实际导入客户端，最终构建后再做完整检查。
6. 在 EasyEDA Pro 复核原理图和 PCB（客户端网表、DRC、截图；需要时进一步核验铺铜、叠层、SI/PI 和制造资料）。未执行的检查如实标明；本地检查通过不等于可投产。除非用户只要原理图或明确只要布局，否则交付完整布线。

### 本地已验证 vs 客户端必须复核

| 本地脚本已证明（有工具证据） | 客户端必须复核（本地无证据，不得声称已验证） |
| --- | --- |
| 网表一致：设计 ↔ 原理图 ↔ PCB 逐脚比对（E001–E007、netcheck、audit） | 回流路径连续性、平面分割与回流密度 |
| 连通性：引脚落导线端点、跨页有端口、flag/port 落位（写盘前预检） | 铺铜结果：实际填充、孤岛、与走线的间距 |
| 间距/线宽/板边/钻孔/环宽/丝印压焊盘/锐角（D001–D014，AABB 近似） | 真实客户端 DRC（阻抗规则、差分规则、生产公差） |
| 过孔几何与跨层连通（D004/D008–D010） | 叠层与阻抗、SI/PI、EMC |
| 器件体重叠/出板框（D013/D014，AABB） | 3D 干涉、装配空间、结构禁布 |
| 设计意图：极性、分压比+vref、差分对存在性（I001–I008） | 差分对间距/等长/阻抗、载流能力、压降、功耗与热 |

**已知限制**（写进交付说明，不要隐瞒）：`pcb.place` 只能摆顶层（底层贴装需在客户端翻转）；`pcb.tracks` 只支持正交/折线，无圆弧与泪滴；D012 只拦 <45°（60°/75° 合法）；底面器件的焊盘坐标未做镜像换算——有底层件的板以客户端 DRC 为准；铺铜由 AI 规划区域、客户端填充并验证。

**布线路径**（三选一，写出的铜都过同一本地 DRC 复核）：① `pcb.tracks`/`pcb.vias` 显式声明（首选，可复现、可评审）；② `node scripts/eda.js route --dir <p>` 客户端自动布线；③ 自己编写布线脚本经 `node scripts/eda.js run --dir <p> --file route.js --pcb --save` 在客户端执行（`pcb_PrimitivePad.getAll` 读焊盘详情，`pcb_PrimitiveLine.create`/`pcb_PrimitiveVia.create` 画铜，`__CLI__.args` 传参）——注意 ②③ 写出的铜不在 `design.json` 里，`--force` 重建会丢失，交付前先跑 `drc.js`（routed 模式）确认连通与间距。

```bash
node scripts/build.js --design design.json --dir <project> --geometry
node scripts/build.js --design design.json --dir <project> --plan
node scripts/build.js --design design.json --dir <project> --report build.json
node scripts/netlist.js --dir <project> --design design.json --audit
node scripts/report.js --dir <project> --design design.json --report build.json
```

- 几何字段、坐标、迁移与例子：[docs/ai-layout.md](docs/ai-layout.md)
- 电路定义、库、符号/封装、生成器：[docs/build.md](docs/build.md)
- 规则与检查：[docs/checks.md](docs/checks.md)；记录格式：[docs/format-reference.md](docs/format-reference.md)
- 客户端库、网表、截图、铺铜：[docs/cli.md](docs/cli.md)
- 保留已有工程时的增量操作：[docs/workflow.md](docs/workflow.md)
