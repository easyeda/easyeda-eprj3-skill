# 输入规范与追问协议（需求采集 → 方案确认）

本文档回答三个问题：**用户要提供什么**、**信息不全时怎么追问**、**哪些默认值会自动生效并需要人工确认**。
对应工具：`node scripts/intake.js`（模板/字段/检查/解析一体）。

## 为什么需要这一层

AI Agent 拿到"帮我做个传感器板"就直接生成，错误通常不在格式，而在**假设**：默认了 USB 供电、默认了 3V3、默认了没有 RS-485。假设不可见，错误就要到板上板下才暴露。
intake 层把假设变成三档数据：**必填（缺了不许开工）→ 建议问（一次问完，带默认值）→ 静默默认（生成后在确认点展示，可否决）**。追问是固定文案，Agent 不需要思考"该问什么"。

## 快速流程

```bash
node scripts/intake.js template --out req.json      # 1. 取固定输入模板
# 2. 用户填 req.json（只填知道的，其余留空/null）
node scripts/intake.js check  --req req.json        # 3. 缺必填 → exit 1 + 逐条追问文案
node scripts/intake.js resolve --req req.json --out design.json   # 4. 方案摘要 + design.json
node scripts/build.js --design design.json --dir <proj> --plan    # 5. 人工确认点（不写盘）
node scripts/build.js --design design.json --dir <proj>           # 6. 正式构建 + 五道门禁
```

`check` 的输出就是可以直接贴给用户的追问清单，例如：

```
必填（缺了不能开始）：
  function: 这块板子要实现什么功能？（一句话，含输入与输出…）
  power.input: 输入电源是什么？（电压 + 来源，例如 "5V USB-C" / "12V DC 端子"）
```

**一次问完，不要串行追问。** `resolve` 会把"建议问"档里用户没答的字段按文档默认值填上，并把它们保留在 `openQuestions` 里——方案摘要会逐条标注"不回答则用 X"。

## 字段表（与 `intake.js fields` 同源）

| 档 | 字段 | 默认/推断 | 说明 |
|---|---|---|---|
| 必填 | `function` | — | 一句话功能，含输入输出 |
| 必填 | `power.input` | — | 电压+来源："5V USB-C" / "12V DC 端子" |
| 建议问 | `power.rails` | 由功能推断（MCU→3V3，USB→5V） | 内部电源轨 |
| 建议问 | `power.current_mA` | 200 | **注记**：按电流推线宽（≤500mA→16mil，<1A→20，<2A→30，≥2A→40），写入 `nets.{net}.width` 作为交接信息与导入铜的 DRC 每网下限；本 skill 不布线 |
| 建议问 | `interfaces` | [] | USB-C/UART/I2C/RS-485/按键/LED… |
| 建议问 | `mcu` | null | 有 MCU 则自动拉 mcu-min + crystal |
| 建议问 | `board.width/height` | null=自动扩板 | 有结构限制才填 |
| 建议问 | `board.layers` | 2 | >2 会提示人工复核 |
| 建议问 | `schematic.sheets` | 1 | **单页/多页询问**：全部模块放同一页还是分页；块 >8 个建议分页，跨页网络用网络端口连接 |
| 建议问 | `constraints.crystal` | 有 MCU 即需要 | 8MHz 等 |
| 默认 | `name` | board | 工程名 |
| 默认 | `package` | 0603 | 0402 可切换；0805 提示后仍按 0603 |
| 默认 | `constraints.differential` | [] | 写入 `expect.pairs`，意图门禁核查 |
| 默认 | `cost.*` `environment.*` | 10pcs / −20…70℃ | 只做记录与工艺提示 |
| 默认 | `output.schematic_only` | false | true → `pcb:false` |
| 默认 | `recipes` | [] | 显式指定 recipe 列表，绕过关键词匹配 |

## 关键词 → recipe 匹配表

`resolve` 按信号流顺序合并模块（`at` 越小越靠前）：

| at | recipe | 触发词（function/interfaces/mcu 文本） |
|---|---|---|
| 0 | usb-c-power | usb, type-c |
| 1 | buck-5v | 输入>6V 且 rails 含 5V |
| 2 | ldo-3v3 | rails 含 3V3 |
| 3 | power-tree | rails>2 轨 |
| 4 | mcu-min | mcu, stm32, esp32, arduino, 单片机, 最小系统, 主控 |
| 5 | crystal | constraints.crystal 或有 mcu |
| 6 | i2c-sensor | i2c, sensor, 传感器, 温湿度, bme280 |
| 7 | uart-bridge | uart, serial, 串口, ttl, ch340, cp2102 |
| 8 | rs485 | rs485, 485, modbus |
| 9 | mosfet-switch | mosfet, relay, 继电器, 电机, 负载, 开关管, 驱动 |
| 10 | divider | divider, 分压, 电压采样, adc 量程 |
| 11/12 | rc-lowpass / rc-highpass | 滤波/低通 / 高通 |
| 13 | led-indicator | led, 指示, 状态灯, blink |
| 14 | button-debounce | button, 按键, push, 消抖 |

合并时做两件保证正确性的事：

1. **电源链推导**：`buck-5v`/`ldo-3v3` 的 `VIN` 自动接"低于自身输出、且高于输出的最近轨"。12V→5V→3V3 就是 `12V→buck→5V→ldo→3V3`，而不是把 LDO 直接挂在 12V 上。
2. **LDO 压差告警**：线性稳压压差 >6V 且电流 ≥150mA 时，方案摘要会打印热耗散估算并建议加一级 buck——**但不自动加**（改 BOM 属于人工确认点）。

布线/铺铜相关的参数（路由器网格、密集板预置细规则）随 1.13 一起移除：本 skill 不布线也不铺铜，`nets.{net}.width` 只是给客户端施工用的注记。

匹配不上任何 recipe 时，`resolve` 不编造电路，方案摘要里直接写"需要手写 parts/blocks（docs/build.md）"。

## 人机确认点（必须展示给用户、得到"可以"再构建）

1. **电源方案**：输入轨、内部轨、电流（决定线宽与拓扑）。
2. **主控与关键器件选型**（含晶振/存储）。
3. **对外接口定义与命名**（网络名会进板子文件，改一次全网）。
4. **层数与结构约束**：板框不问了——构建时自动取封装 bbox 面积 ×1.25（`design.json` 里的 `board.width/height` 会被忽略）。
5. **自动修复将写入的内容**：`node scripts/autofix.js --design design.json --diff` 打印 before/after 行级差异 + 变更行数，**不写盘**；确认后才去掉 `--diff` 应用。
6. **构建前预演**：`build.js --plan` 在一次性目录里真实跑完整构建（lint/drc 分数是真的），但目标目录一个字节都不写；用户确认后再正式 `build.js`。
7. **铜皮不在本 skill 范围**：永不布线、永不铺铜——布局交给机器，铜皮交给人。`build.js` 打印 `rats:` 交接清单（待手工连接的网络与焊盘数），走线/过孔/铺铜在 EasyEDA 客户端完成。

`resolve` 的输出格式就是为确认点设计的——电源/板框/模块/规模/网络/规则/待确认逐行可读：

```
方案 sensor-board
  电源  输入 VBUS → 轨 3V3（120 mA）
  板框  自动（封装 bbox 面积 ×1.25）· 2 层 · 封装 0603 · 只布局（本 skill 不做布线/铺铜，铜皮在客户端完成）
  模块  usb-c-power(4) + ldo-3v3(4) + mcu-min(8) + crystal(5) + i2c-sensor(5) + uart-bridge(7)
  规模  33 parts · 20 nets
  规则  电源轨 16 mil（注记，DRC 判导入铜时的每网下限）· clearance/track 用默认
  待确认
    · 板框有硬性限制吗？→ 本版自动按封装 bbox 面积 ×1.25 生成，不接受指定尺寸（只给层数即可）
```

## 缓存与速度

`resolve` 的"需求 → recipe 参数/网络映射"结果写入 `.cache/intake.json`（键=requirement+params+netmap 的 sha256）。同一需求再解析只查一次表；`--no-cache` 强制重算。缓存**只是加速器**：删掉 `.cache/` 不改变任何输出。

## 常见错误

| 症状 | 原因 | 处置 |
|---|---|---|
| `requirement file is not valid JSON: Unexpected token '﻿'` | 记事本/VS Code 存成了带 BOM 的 UTF-8 | 已内建 BOM 容错；若仍出现，确认文件未被二次加密 |
| `没有匹配到任何 recipe` | function/interfaces 用词太抽象（"控制板"） | 补具体接口词，或 `--recipe ldo-3v3,mcu-min` 显式指定 |
| drc D001 成片 | 导入的/客户端返存的板：铜皮间距低于 `clearance`（本 skill 自建的板没有铜，不会触发） | 在客户端调整或删除相应铜线；若根因是焊盘太近，改 `pcb.rules.clearance` / `pcb.place` 后 `build.js --force` 重放布局，再回到客户端做铜 |
| `check` exit 1 | 必填缺失 | 把输出的追问文案**一次**发给用户 |
