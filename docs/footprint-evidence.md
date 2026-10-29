# 封装 / 符号证据表（land-pattern & symbol evidence）

> **网络边界：** 构建/校验/渲染读取的是随仓库提交的固化数据（本表是出处
> 引用，不是抓取指令）。唯一的联网动作是**用户发起的按器件抓取**：
> `node scripts/fetch-lcsc.js --id C<LCSC> --install`（EasyEDA 官方库，许可
> 归属嘉立创EDA）——遇到库里没有的器件先抓官方库，抓不到再自建符号/封装
> 并声明 pinoutSource。批量校准/新增家族仍是维护会话流程，见
> [docs/development.md](development.md)。

要求：库数据必须**可溯源到外部来源**——不能是"照抄自家 recipe"（那种自证
闭环确实引入过错误：SOT-23 焊盘内缩 0.35 mm、SOIC 焊盘长轴装反、TSSOP 用错
pitch 标准）。已提交数据的来源按以下优先级记录：

1. **EasyEDA 官方库**（最高优先，维护期抓取后固化）：官方器件/封装数据
   （`packageDetail.dataStr.shape` 的 `PAD~` 记录，单位 10 mil，y 向下；换算
   到本 skill 的 mil/Y-up）。各表行中的 LCSC 编号即出处引用。
2. **JEDEC / IPC-7351B 标准推导**：无官方样例时按标准公式计算，并在表中标注
   "推导、官方样例待补"。
3. **随仓库提交的客户端实测工程**（`examples/easyeda-eprj3-project`，官方
   quick-start + H610 真机保存）作为格式基准。

规则：修改 [fp-auto.js](../scripts/lib/fp-auto.js) 家族尺寸或新增 IC 条目时，
必须同步更新本表与 [test/dfm.js](../test/dfm.js) 断言（同一提交内）——只改
测试不改实现（或反之）都不可接受。所有数值单位 mil（1 mil = 0.0254 mm）。

## auto 家族（`{auto: …}`）

| 家族 | 关键尺寸 (mil) | 来源 |
| --- | --- | --- |
| `SOT23` | 焊盘 39.4×25.6 @ x=±39.4，1/2 脚间距 74.8（**P1.90**） | 官方库 MMBT5551（C2145，SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR）。注意两同侧引脚间距是 1.9 mm，不是 0.95 |
| `SOT23-5` | 焊盘 45.6×19.3 @ x=±45.4，列内 pitch 37.4；右列与 1/3 脚行对齐 | 官方库 ME6211C33（C82942，SOT-23-5_L3.0-W1.7-P0.95-LS2.8-BL） |
| `SOT23-6` | 同 SOT23-5 几何 | 由 SOT-23-5 官方样例外推（同体类），独立样例待补 |
| `SOT223` | 行焊盘 43.3×98.4 @ y=-116.9，pitch 90.5；tab 141.7×92.1 @ y=+116.9 | 官方库 AMS1117-3.3（C6186，SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR） |
| `SOP<n>` | 焊盘 76.8(径向)×22.4(切向) @ x=±106.5，pitch 50 | 官方库 LM358DR2G（C7950，SOIC-8_L5.0-W4.0-P1.27-LS6.0-BL）。1.15 前长轴装反且相邻焊盘重叠 |
| `SSOP<n>` | 焊盘 38×12 @ x=±130，pitch 25.6 | IPC-7351B 推导，官方样例待补 |
| `TSSOP<n>` | 焊盘 58×16 @ x=±112.7，pitch 25.6 | IPC-7351B 推导（0.65 mm 类），官方样例待补 |
| `DFN<n>` | 焊盘 1.1×pitch（径向）× 0.5×pitch（切向），行距 = 引脚跨距半 + 1.3×pitch，pitch 默认 25.6 | IPC-7351B 推导（0.65 mm 无引脚双排类，SHT30/BMP280 量级），官方样例待补；**不含散热焊盘**，需要 EP 的用手写 inline 封装 |
| `LGA<n>` | 方形焊盘 0.8×pitch，行距 = 引脚跨距半 + 1.2×pitch，pitch 默认 25.6 | IPC-7351B 推导（LGA 双排类），官方样例待补 |
| `QFN<n>` | 焊盘 11×31.5（切向×径向），行距 ±79，pitch 19.7；编号自底边左起逆时针 | 官方库 MPU-6050（C24112，QFN-24_L4.0-W4.0-P0.50-BL-EP2.7）。**散热焊盘未建模**——需要 EP 的 QFN 请手写 inline 封装 |
| `QFP`/`LQFP<n>` | 焊盘 10.6×59.1 @ x=±167.3，pitch 19.7 | 官方库 STM32F103C8T6（C8734，LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL）。默认公式对 LQFP-48 精确；其他体尺寸请显式传 `span` |
| `DIP<n>` | 焊盘 60×60，孔 32，pitch 100，rowSpan 300 | 2.54 mm 栅格 + 0.9–1.0 mm 孔径（标准推导） |
| `HDR<n>` / `HDR2R<n>` | 焊盘 60×60，孔 32，pitch 100 | 2.54 mm 排针（标准推导） |
| `SW_4P` | 焊盘 60×50 @ x=±100, y=±70 | 6×6 mm 轻触开关类（推导，装配前请对照具体器件） |
| `XTAL` | 焊盘 50×60 @ x=±60 | HC-49S 贴片类（推导，请对照具体晶体） |
| `OSC` | 焊盘 40×40 @ x=±60, y=±40 | 3225 晶振类（推导） |
| `USB_C` | 6 个官方合并焊盘：A1B12/A4B9/A5/B5/B4A9/B1A12 @ 官方坐标 | 官方库 TYPE-C-31-M-12（C165948，USB-C_SMD-TYPE-C-31-M-12_1）。**仅电源脚**（VBUS/GND/CC，官方合并焊盘命名）；DP/DM/SBU/外壳未建模，需要完整 USB-C 请手写 inline 封装 |

## 预设封装（`templates/library/footprint/`）

| 预设 | 关键尺寸 (mil) | 来源 |
| --- | --- | --- |
| `R0603`/`C0603`/`L0603` | 焊盘 31.8×34 @ ±29.7 | 官方库 0603WAF1001T5E（C21190，R0603）——数值与预设一致 |
| `R0402`/`C0402`/`L0402` | 焊盘 23×25 @ ±19 | IPC-7351B 1005M nominal 推导（官方 0402 样例待补）；1.14 前是 0603 尺寸焊盘 |
| `LED0603` | 同 0603 + 极性丝印 | 官方库 LED0603 类（如 C192316 TJ-S1608SW6TGLC2G-A5） |
| `SMA` | 焊盘 98.4×70.9 @ ±78.74 | DO-214AC datasheet 推导（官方样例待补） |
| `TP0.5` | 焊盘 19.685×19.685 @ 原点 | ≈0.5 mm 测试点 |

## 预设符号（`templates/library/symbol/`）

| 预设 | 约定 | 来源 |
| --- | --- | --- |
| `DIODE`、`LED` | **pin 1 = A（阳极）、pin 2 = K（阴极）**，designator `D?`，均带二极管图形（三角+阴极杠，LED 另有发光箭头） | 1.14.0 统一（此前 DIODE 是 1=K + `U?`，与 LED 矛盾） |
| `RES` `CAP` `IND` | 1/2 脚对称 | 经典无源符号 |
| 电源标志 `GND` `AGND` `PGND` `VCC` `5V` | 以原点为连接点（引线长 0） | 真机客户端样例捕获 |
| `PORT_IN/OUT/BI`、`OFFPAGE_*` | 以原点为连接点 | 真机客户端样例捕获 |
| `TEST_POINT` | 单引脚 | — |

Pin Type 属性取值：客户端实测样例中只出现过 `IN` 与 `Undefined`。ERC E008
使用的电气方向存放在 design 上下文（`"num:name:dir"` 引脚 spec / IC 条目），
**不写入记录**——没有真机样例前不得发明新的 Pin Type 枚举值。

## IC 引脚库（`templates/library/ic/`）

人工维护的数据（不是生成的）——每条必须注明来源：

| 条目 | 引脚 | 来源 |
| --- | --- | --- |
| `STM32F103C8T6` | 48（24 L / 24 R，符号 pitch 100 mil；封装为官方 LQFP-48 焊盘逐字坐标） | 符号+封装：EasyEDA 官方库 C8734（`https://easyeda.com/api/products/C8734/components`，pin 号/名称/列位与焊盘坐标逐字；电源类引脚名按确定性命名规则标 W 方向）；datasheet：[ST STM32F103C8](https://www.st.com/resource/en/datasheet/stm32f103c8.pdf) |
| `AMS1117-3.3` | 4（1=GND 2=VOUT 3=VIN 4=VOUT/tab，官方符号逐字；封装 `{auto:SOT223}` 按官方 SOT-223 坐标生成） | EasyEDA 官方库 C6186（`https://easyeda.com/api/products/C6186/components`）；datasheet：[AMS1117](https://www.advanced-monolithic.com/Pdf/ds1117.pdf) |

新增条目：先 `node scripts/fetch-lcsc.js --id C<LCSC> --install` 抓官方库
（输出即条目格式）；官方库没有的器件再按 datasheet 自建并由用户确认引脚
（流程见 [docs/development.md](development.md)）。

## 未经真机客户端验证

`DIFF_PAIR`、`SHORT`、`A3`、`A4` 图框符号——SKILL.md 已知限制里有记录；在真
机打开验证过一次之前不要在交付物里依赖它们。
