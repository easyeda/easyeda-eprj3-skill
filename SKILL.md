---
name: easyeda-eprj3
description: Create, edit, and verify EasyEDA Pro / 嘉立创EDA专业版 .eprj3 projects. The AI designs schematic placement and wiring as a senior electronics engineer and PCB placement and routing as a senior PCB layout engineer; scripts resolve libraries, write exact geometry and validate the result.
---

# EasyEDA Pro eprj3

**AI 决定布局布线，脚本只负责写入与检查。** 原理图的符号坐标、旋转、连线、标号、电源符号和跨页端口，以及 PCB 的板框、器件位置、线宽、走线层、拐点和过孔，均由你明确指定。不要调用本地或客户端自动布局、自动布线，也不要用自写搜索、排版、路径生成程序来替代工程判断。

## 工作流程

1. 确认功能、电源、接口、器件、机械边界、锁定位置、制造约束、层数及交付范围。仅有功能需求时先用 `intake.js check` / `resolve`；生成的是电路定义，不是可直接构建的布局。已有项目默认保留未授权变更的部件、板框和布线；局部编辑优先用明确的记录操作，不要用重建清空整板铜线。
2. 用 `build.js --geometry` 查看实际符号引脚、封装焊盘及所属网络，再编写布局。系统库器件可通过 EasyEDA 客户端解析并实例化；客户端只按给定坐标操作，不参与布局或布线决策。
3. **作为资深电子工程师完成原理图。** 按功能和信号流分块，电源与地的方向一致；按真实脚位、极性及参考电路，优先安排去耦、时钟、反馈、保护器件和连接器。近端连接用明确的正交折线；跨块/跨页使用同名端口与清晰的短线。分支显式共用端点；避免不同网络触碰、导线穿过符号、遮挡文字和漏连引脚。逐脚对照设计网表；NC 不得连线。只在已声明有对应设计要求时标注明确的电气约束。
4. **作为资深 PCB Layout 工程师完成 PCB。** 先固定结构件、连接器、禁布和锁定位置，再按电源、模拟、数字和高频分区。布置去耦回路、关键回流路径及互扰隔离。先处理时钟、差分、敏感模拟和大电流网络，再完成普通信号；逐段指定铜层、宽度、路径和过孔。遵守用户给定的板框和制造能力，不擅自改板尺寸、层数、阻抗或安全距离。必须先核实叠层才能承诺阻抗；铺铜区域由 AI 规划，客户端仅执行明确区域的填充及验证。检查焊盘/层切换、回流连续性、过孔、板边、间距及可制造性。
5. `build.js --plan` 预检，`build.js --report` 产出工程及检查结果。按 ERC、版面检查、原理图/PCB 网表比对、设计意图、DRC 的反馈修改自己编写的几何，再重验。若仍有飞线，报告其网络和阻塞原因，不能用 `--allow-drc` 或 `placed-only` 伪装完成。系统库模式的 `--plan` 不实际导入客户端，最终构建后再做完整检查。
6. 在 EasyEDA Pro 复核原理图和 PCB（客户端网表、DRC、截图；需要时进一步核验铺铜、叠层、SI/PI 和制造资料）。未执行的检查如实标明；本地检查通过不等于可投产。除非用户只要原理图或明确只要布局，否则交付完整布线。

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
