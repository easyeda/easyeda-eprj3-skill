---
name: easyeda-eprj3
description: Build EasyEDA Pro / 嘉立创EDA专业版 .eprj3 projects (schematic + PCB) from one design.json — offline schematic layout + wiring, PCB placement, four gates, plus a 2.x CLI bridge (client V4.1.94+) for library search, PCB auto layout/route, copper pour + fill, netlist export/compare and screenshots. Use whenever the user wants to create or edit an eprj3 project, generate symbols/footprints, or validate/repair one.
---

# EasyEDA Pro eprj3 Skill

Author **EasyEDA Pro** (嘉立创EDA专业版) folder-format `.eprj3` projects. One design
file in, one validated project out: schematic laid out in signal-flow blocks,
every net wired, **PCB placed** — then four independent gates.

**Strategy: the skill places, the client finishes the copper.** 2.x drives the
desktop client through its CLI for everything the client does best (library
search, auto layout/route, pour, netlist extraction, screenshots). The skill
itself still **never implements a router or a pour engine** — it prepares the
project and the scripts, then lets the client execute. Without the client the
offline pipeline still produces a placement-only board and prints a **rats
handoff list**; `D004` (unrouted) and `D006` (missing pour) are never judged on
a board this skill built.

Format ground truth: [`docs/format-reference.md`](docs/format-reference.md). Deep
details are load-on-demand — see [Where to read next](#where-to-read-next) instead
of reading everything up front.

## 运行时任务进度

动手前先打印任务清单，让用户一眼看到「共几项、现在做哪项」；每完成一项立即更新，
不要闷头跑完才汇报。

标准流程共 5 个关键任务：

```
- [ ] 0. 环境检查 doctor（用到 2.x CLI 功能时必做：客户端 4.1.94+）
- [ ] 1. 需求采集 intake（设计文件已给出则跳过）
- [ ] 2. 生成工程 build（含五道门禁 + netcheck）
- [ ] 3. 网表审计 audit（全新子 agent 复核；2.x 可用 eda.js netlist 导出）
- [ ] 4. 报告 report（project-report.md + ai-report.md）
- [ ] 5. 打开客户端 open（可选）
```

运行时约定：

- 开场打印清单，并写一句 `开始：共 N 项任务`（N 按实际执行项计，跳过的步骤先划掉）。
- 每完成一项把该项勾上，再打印 `✅ [i/N] <任务名> 完成`。
- 全部完成后打印汇总：`✅ 完成 N/N —— <一句话结果>`。
- 失败即停在当前项：打印 `❌ [i/N] <任务名> 失败` 和原因，报给用户后不要静默继续。

## Step 0 — intake: ask once, then never again

When the request is a *feature* ("做一个温湿度采集板") rather than a design file,
run the intake protocol before writing anything:

```bash
node scripts/intake.js check --req req.json    # exit 1 = required fields missing
node scripts/intake.js resolve --req req.json --out design.json
node scripts/build.js --design design.json --dir <proj> --plan    # confirm gate
node scripts/build.js --design design.json --dir <proj>           # after the user says ok
```

- `check` prints the exact questions (zh) for missing fields — send them **all at
  once**, never serially. Ask-tier fields carry their fallback default.
- `resolve` maps keywords to recipes (`usb`→usb-c-power, `3V3`→ldo-3v3,
  `单片机/mcu`→mcu-min+crystal…), chains the power tree
  (12V→buck→5V→ldo→3V3) and derives rail widths from the declared current.
  Selections are cached (`.cache/`) — a repeated requirement resolves in one
  lookup.
- **Confirmation gates before you build or fix:** power scheme, MCU/critical part
  choice, interface names, board size/layers, and `autofix.js --diff` output
  (a diff summary before any automatic edit). Full protocol + field table:
  [`docs/intake.md`](docs/intake.md).

If the user supplied a complete design already, skip to the fast path.

## Fast path (use this unless the user asks otherwise)

```bash
# 1. write a design file (see below), then:
node scripts/build.js --design design.json --dir <absolute project dir>
#    ... builds schematic + PCB PLACEMENT, runs validate + ERC + lint + DRC
#    the PCB is placement-only; the run prints the rats list of nets to
#    connect by hand in the EasyEDA client (this skill never routes or pours)
#    placement: one cluster per schematic block (caps beside the pads they
#    decouple), connectors (J/CN/USB) on the board edge, board auto-fits
node scripts/netlist.js --dir <project dir> --design design.json --audit <project dir>/.tmp/netlist-audit.json
#    netlist audit package → a FRESH sub-agent reviews it (mandatory; see the
#    "Netlist audit" section below, not an optional nicety)
node scripts/netcheck.js --dir <project dir>    # schematic ↔ PCB netlist diff (build already ran it; re-run after client edits)
node scripts/report.js --dir <project dir> --design design.json --report <dir>/build.json
#    project-report.md (概述/功能特性/信号框架图/电路框架图/网络/门禁/遗留/建议)
#    then write ai-report.md yourself — model/tokens/times, see "Reports" below
node scripts/make-board.js --design design.json --dir <dir> --force   # one-shot: build → digest + audit package + project-report.md
node scripts/floorplan.js --design design.json                        # preview the PCB placement map (no build; --write pins it into pcb.place)
node scripts/open.js open --dir <project dir>   # open the .eprj3 via the OS file association (same as double-clicking it)
```

## 2.x — CLI-first workspace (client V4.1.94+)

2.x hands the work the desktop client does best to the client, through its
command line. **Check the environment first** — every 2.x script refuses to run
on an older client:

```bash
node scripts/eda.js doctor        # version / endpoint; non-zero below 4.1.94
```

Then call a script instead of hand-writing JavaScript:

| Need | Script | Client API |
| --- | --- | --- |
| find a device (keyword / LCSC) | `eda.js search --q …` / `--lcsc …` | `lib_Device.search` / `searchByProperties` |
| netlist for review | `eda.js netlist --dir <p> --out review/netlist.json` | `sch_ManufactureData.getNetlistFile` |
| schematic ↔ PCB agreement | `eda.js check-net --dir <p>` | sch + pcb `getNetlistFile` |
| visual check | `eda.js screenshot --dir <p> --out shots` | `getPngFile` / `getCurrentRenderedAreaImage` |
| PCB auto layout/route | `eda.js pcb --layout/--route` | `pcb_Document` |
| copper pour + fill | `eda.js pour --net GND --outline x1,y1,x2,y2` (data units = mil) | `pcb_PrimitivePour.create` + `rebuildCopperRegion` |

Rules:

- **Source APIs first.** The `sch_Source*` family edits project source data with
  no open page and is the fastest route (`sch_SourcePrimitiveComponent.add`,
  `sch_SourcePrimitiveWire`, …). Document-level APIs are for auto layout /
  auto route / rendering, which need an open document.
- **Scripts, not snippets.** The model runs these scripts; it does not write
  editor JS itself. A new capability means a new `eda.js` subcommand.
- **Close sessions.** Every command opens a headless session and destroys it;
  batch loops must not leak editor windows (`--keep` only for debugging).
- **Schematic layout and wiring always use the skill's own engine.** The
  client's schematic auto engine ignores module frames and reads worse; do not
  delegate schematic placement/routing to it. The client does PCB copper
  (auto route / pour) and the review/screenshot/netlist work.
- Full flags, API mapping and limitations: [`docs/cli.md`](docs/cli.md).

## Netlist audit — a fresh reviewer, not you

A green build proves the files are well formed and every gate ran — including
`E003`, which compares the built netlist with design.json **inside the build**.
That is not an independent check: the agent that wrote design.json is the agent
reading the verdict, and a mistake shared by both sides (a wrong pin number in
the design, a net the layout silently merged) is invisible to it. So every
build gets one read of the netlist by a reviewer that has **none of your
context**:

```bash
node scripts/netlist.js --dir <project> --design design.json \
     --audit <project>/.tmp/netlist-audit.json
# generator-authored board? --gen board.gen.js replaces --design (the same
# design the build used — there is no design.json to read)
```

`make-board.js` already writes this package to `<project>/.tmp/netlist-audit.json`
and lists it in the digest as `audit: {ok, file}` — hand that `file` straight to
the reviewer, no extra command.

**2.x variant — review the client's own netlist.** With the desktop client
openable (V4.1.94+), export the netlist the client itself computed and reduce it
to the fields the reviewer needs:

```bash
node scripts/eda.js netlist --dir <project> --out <project>/.tmp/netlist.json
node scripts/eda.js check-net --dir <project> --out <project>/.tmp/netcheck.json
```

`netlist.json` is `{ parts:[{ref,name,device,footprint,pins:{num:net}}],
nets:{name:[ref.pin]} }` — refdes, connections and model names only, no
geometry. Hand **that** file to the same fresh-subagent review (ask it to check
each net against the PRD and flag wrong pin numbers / missing parts / shorted
nets); `check-net.json` proves the schematic and PCB netlists agree. Use this
path when the client is available; the package path above stays the offline
fallback.

The package is self-contained (schema `eprj3-netlist-audit/1`):

| Field | Meaning |
| --- | --- |
| `spec` | what the design asked for — every part's pin→net map, `powers`, `expect` |
| `built` | what the schematic actually connects — nets, pins, power-flag counts, unconnected pins, PCB pad nets |
| `mechanical` | the tool's own diff, `mechanical.ok`, netcheck verdict, plus advisory `suspicions` |
| `rubric` | the checklist the reviewer must perform |
| `verdictSchema` | the exact JSON the reviewer must return |

Hand the **file path** (absolute), never your notes or reasoning, to a **fresh**
sub-agent. Copy this task verbatim:

> You are an independent netlist auditor. You have no prior context and need none.
> Read `<absolute path to netlist-audit.json>`. It is a self-contained audit
> package (`schema: eprj3-netlist-audit/1`): `spec` is the required pin→net map
> from design.json, `built` is the netlist recovered from the generated
> schematic, `mechanical` is the tool's diff — **do not trust it**, recompute
> every net group from `spec.parts` and `built.nets` yourself — `rubric` lists
> the checks you must perform, `verdictSchema` is the required output shape.
> Follow the rubric, then output ONE JSON object and nothing else: no prose, no
> markdown fence. `ok` is true only when no finding has severity "error".

Then loop, **max 3 rounds**:

1. `mechanical.ok === false` — a hard floor that applies **even if the reviewer
   said ok** — or the reviewer returns `ok: false` → apply each finding's `fix:`
   to design.json (or to the gen/recipe that produced it), rebuild with
   `--force`, regenerate the package, and spawn a **new** reviewer. If the
   reviewer missed a mechanical failure, repair straight from
   `mechanical.diff` / `missingPins` / `pinTwice`. Never follow up with the
   previous reviewer: it has seen the old netlist and would be grading its own
   earlier answer.
2. `ok: true` → go on with `netcheck`, `open`. Put the reviewer's `summary` in
   your final report, so the user knows the netlist was independently read.
3. Still failing after 3 rounds → **stop** and show the findings to the user
   verbatim. Do not accept them silently and do not loop forever.

A finding with no concrete `fix:` is not actionable — ask that reviewer for the
design.json line in the same round; never guess a repair. After a green audit,
`node scripts/cleanup.js --dir <project>` removes `.tmp/` (the audit package
lives there; a rebuild wipes it too).

If the host has no sub-agent capability, run `rubric` yourself against the
package — and say plainly in your report that the audit was **not independent**.

## Reports — project-report.md + ai-report.md

Every finished build ends with two human-readable reports next to the project:

- **`project-report.md`** — auto-generated by [`scripts/report.js`](scripts/report.js)
  (`make-board.js` writes it for free): 工程概述 / 功能特性 / 信号框架图 /
  电路（电源）框架图（mermaid）/ 网络概览 / 验证结果 / 遗留问题 / 建议. Every
  fact comes from design.json + the built project, never invented; the judgement
  sections (一句话功能, 建议) are yours to top up.
- **`ai-report.md`** — written **by you**, because only the host knows the model,
  token usage and wall-clock. Record timestamps as you go (start at intake, then
  build → audit → report → open), and fill this template at the end:

```markdown
# ai-report — <project name>

| 项 | 值 |
| --- | --- |
| 工程目录 | `<dir>` |
| 使用的模型 | `<model id / 名称，宿主提供>` |
| 主 agent | easyeda-eprj3（本 skill） |
| 子 agent | 网表审计 auditor ×N（每轮一个全新实例）；其它如有请列出 |
| token 使用量 | 输入 / 输出 / 总（读宿主会话状态；无则写 N/A） |
| 开始时间 | `YYYY-MM-DD HH:MM:SS` |
| 结束时间 | `YYYY-MM-DD HH:MM:SS` |
| 总耗时 | `<duration>` |

## 关键步骤时间线

| 步骤 | 开始 | 结束 | 耗时 |
| --- | --- | --- | --- |
| intake（需求采集） | | | |
| build（生成 + 门禁） | | | |
| netlist audit（子 agent 复核） | | | |
| report（两份报告） | | | |
| open（打开客户端，如执行） | | | |
```

If the host exposes no token counter, write `N/A` — never invent a number.

## 大型设计：写 gen 生成器，不手写 JSON

50+ 器件的板子不要手写 design.json（token 不可承受），也不要自造临时脚本。
写一个短的生成器文件（~25 行），交给官方管道：

```js
// board.gen.js — module.exports = (A) => { ...; return A.design(); }
module.exports = (A) => {
  A.name('esp32s31-hmi');
  A.power('3V3', 'up'); A.power('GND', 'down');
  A.block('POWER', { desc: '电源输入与保护' });
  A.cap('VBUS', 'GND', '10uF');
  A.chip({ id: 'U9', name: 'TG28', pins: { 1: 'VSYS', 2: 'GND' },
           footprint: { auto: 'QFN', pins: 20 }, autoNC: true,
           pinoutSource: '按 datasheet 手工绘制（用户已确认）' });
  A.block('MCU', { desc: '主控' });
  A.ic({ id: 'U1', ic: 'STM32F103C8T6', pins: { 1: '3V3' }, autoNC: true });
  A.place('J1', [300, 150, 0]);
  return A.design();
};
```

```bash
node scripts/build.js --gen board.gen.js --dir <proj> --force --report build.json
node scripts/make-board.js --gen board.gen.js --dir <proj>   # 一站式：build + digest（含网表审计包）
```

助手 API：`A.cap/res/ind/led/diode`（自动位号）、`A.ic`（IC 条目，autoNC
默认开）、`A.chip`（内联符号+封装；`pinNames` 让引脚名与网络名分开：
`{ pins: {1:'PUMP_EN'}, pinNames: {1:'G'} }`）、`A.conn`（连接器，W003 豁免）、
`A.block`（模块 + 功能描述）、`A.place/power/net/pair/expect/frame`、
`A.recipe('ldo-typed', { device?, set?, net? })`（类型化 recipe：按 class+角色
自动选型，见下）。
位号：自动编号与显式 id 共用计数器，重复 id 在调用处立即报错。
完整列表见 [scripts/lib/authoring.js](scripts/lib/authoring.js)。

**类型化 recipe（换器件不改模板）**：`recipe/*.json` 里的 `"bind": { "device":
{ "class": … } }` 表示“这里要一个某类器件”，具体型号由 `lib/select.js` 按
`class + 角色` 从 IC 库挑（`node scripts/recipe.js devices` 看可用器件）。
`--device <名称>` 可强制指定；选不到会明确报“缺哪个能力”，绝不编造引脚。

Rebuild loops (fix → rebuild → read gates) should pass `--quiet --report
build.json`: one summary line on stdout, the full machine-readable report
(scores, rats, netcheck issues) in the JSON — don't re-read verbose output
every iteration. Add `--digest` to print a one-page snapshot (counts, gates,
rats) — enough to resume a session without re-reading logs.

**Context discipline (costs real tokens):** never read a whole log file or
datasheet into context — read `--report` JSON fields, and have a sub-agent
extract datasheet pin tables (return only the table + source URL).

`build.js` exits non-zero if any gate has an error, so a clean exit *is* the
quality proof. It prints one summary line:

```
blink.eprj3 at /path — 4 components, 15 wire segments, lint 100/100, drc 100/100 (placed-only).
```

`--force` rebuilds an existing directory (deletes only skill-owned files:
index, `sch/`, `pcb/`, `panel/`, `.tmp/`). `--dry-run` rehearses into a throwaway
directory and deletes it. `--schematic-only` skips the PCB.
`--report <file>` writes the machine-readable report (validate/erc/lint/drc +
netcheck + stats; its `pcb` section is `{parts, mode: 'placed-only', rats}`).
`--no-tidy` keeps declared rotations — by default the build runs **sch-tidy**,
a two-pass orientation optimizer that turns every symbol onto its signal axis
(2-pin parts onto their connection axis, ICs toward their partner mass; the
AI only supplies rough positions).

## design.json — the whole contract

All lengths are **mil** (1000 mil = 1 inch). Schematic sheet coordinates are the
client's native **Y-down** (the builder lays blocks out downward from y=0, like
hand-drawn sheets); PCB coordinates are Y-up. Only `parts` is required.

```json
{
  "name": "blink",
  "board": { "width": 1600, "height": 1000 },
  "sheet": { "schematic": "Schematic1", "name": "P1" },
  "powers": { "VCC": "up", "GND": "down" },
  "blocks": [
    { "title": "POWER INPUT", "parts": ["D1", "C1"] },
    { "title": "LED DRIVER", "parts": ["R1", "D2"] }
  ],
  "parts": [
    { "id": "R1", "symbol": "RES", "footprint": "R0603", "value": "330R",
      "pins": { "1": "V_LED", "2": "LED_A" } }
  ],
  "pcb": { "place": { "R1": [400, 400, 0] } }
}
```

| Field | Meaning |
| --- | --- |
| `name` | project/index name (does not have to match the directory) |
| `board.width/height` | board outline size in mil; **optional** — the board auto-grows to fit the parts |
| `powers` | net → `"up"` (supply) or `"down"` (ground): these get **power flags** instead of wires |
| `nets` | per-net **annotations**: `{ "width": 30 }` records the intended track width (derived from current) — it never lays copper; the DRC uses it as a per-net floor when reviewing imported tracks. `{ "class": "POWER" }` groups via `netClasses` |
| `netClasses` | `{ "POWER": { "width": 30 } }` — named width groups referenced from `nets` (annotation only) |
| `blocks` | titled boxes in signal-flow order; parts left out join the last block; keep **2–8 related parts** per block. `blocks[].desc` = one-line functional description rendered under the title (ask the user for one per module); `blocks[].sheet` = 1-based page override |
| `sheets` | schematic pagination (intake asks 单页/多页): 1 = all blocks on one sheet (default); N = blocks fill N sheets in declaration order. Cross-sheet nets join through net ports (merged by name globally) |
| `parts[].id` | reference designator **and** the part key used by `blocks` / `pcb.place` |
| `parts[].symbol` | preset name (`RES`, `CAP`, `IND`, `DIODE`, `LED`, `TEST_POINT`, `PORT_IN`…) **or** an inline spec |
| `parts[].ic` | evidence-sourced IC entry (`STM32F103C8T6`…) — replaces `symbol`+`footprint`, pins map by pin number, unused pins `"NC"` |
| `parts[].footprint` | preset name (`R0603`, `C0603`, `SMA`, `TP0.5`…) **or** inline spec **or** `{ "auto": "LQFP48" }` |
| `parts[].pins` | pin **number** → net name. Unconnected pins map to `"NC"` (ERC accepts the NC convention). Every other unlisted pin is an ERC error |
| `parts[].polarity` | optional `{ "1": "+", "2": "-" }` — checked by the intent gate (I001 catches an LED/diode wired backwards); TVS/clamp parts declare `"role": "shunt"` and are exempt |
| `parts[].rotation` | 0 / 90 / 180 / 270 |
| `expect` | optional intent block for the fifth gate — see below |
| `frame` | `{ titleBlock: true }` re-enables the 明细表 (default: hidden); the drawing frame is AUTO-SIZED around the packed blocks (Size reports the nearest A-series, Width/Height are authoritative) |
| `pcb.place` | optional explicit placement `[x, y, angle]`; everything else is auto-placed |
| `pcb.rules` | DRC floors only: `clearance`, `trackWidth` (→ min track), `edgeClearance`, `minDrill`, `minRing`, `minAngle`. 0.5 mm-pitch parts want `clearance 6, trackWidth 6` |
| `pcb.pour` / `pcb.route` | **removed (1.13)** — this skill never pours or routes; writing these keys has no effect |

Inline parts (no library file needed) — use for any IC, connector or module:

```json
{ "id": "U1",
  "symbol":    { "name": "LDO", "designator": "U", "pitch": 30, "pins": ["1:GND", "2:VOUT", "3:VIN"] },
  "footprint": { "auto": "SOT23-5" },
  "pins": { "1": "GND", "2": "3V3", "3": "VIN" } }
```

`"auto"` footprints are generated from real land-pattern formulas with
**external evidence** (JEDEC / IPC-7351B / real LCSC parts — table:
[`docs/footprint-evidence.md`](docs/footprint-evidence.md); dimensions are
asserted by `test/dfm.js`): `SOT23`/`SOT23-5`/`SOT23-6`/`SOT223`,
`SOP8`/`SOP16`…, `SSOP`, `TSSOP`, `QFN32`, `LQFP48`/`LQFP64`…, `QFP`, `DIP8`…,
`HDR6`, `HDR2R8`, `SW_4P`, `XTAL`, `OSC`, `USB_C` (power-only: VBUS/GND/CC —
map DP/DM on a hand-written footprint). Knobs: `pins`, `pitch`, `span`, `hole`
(`"auto": "LQFP", "pins": 48, "pitch": 19.7`). Use them instead of hand-writing
pads — fewer tokens, no invented coordinates.

Hand-written inline pads are still accepted (`[num, x, y, width, height,
drillDiameter?]` in mil; a drill makes the pad through-hole). Stick to real
land-pattern numbers (0603 pads ≈ 32×34 at ±29.7, 0402 ≈ 23×25 at ±19, SOT-23
pads ≈ 24×30, rows at ±47, 0.1" header ≈ 60×60 at 100 pitch — evidence table
above). Inline symbols raise their pin pitch automatically (30 mil for 3+ pins;
override with `"pitch"`).

### expect — declare the circuit's intent (fifth gate)

The other gates prove the files match design.json; `expect` catches mistakes
INSIDE design.json (an LED wired backwards, a missing decoupling cap, a
mis-wired divider):

```json
"parts": [
  { "id": "D2", "symbol": "LED", "footprint": "LED0603",
    "pins": { "1": "3V3", "2": "LED_A" }, "polarity": { "1": "+", "2": "-" } }
],
"expect": {
  "decoupling": true,
  "pairs": [["USB_DP", "USB_DM"]],
  "valueRange": [{ "ref": "R1", "min": "100R", "max": "1k" }],
  "divider": [{ "input": "VIN", "output": "FB", "top": "R1", "bottom": "R2", "ratio": 0.5 }]
}
```

Rule table: `node scripts/intent.js --rules`; codes I001–I006 in
[docs/checks.md](docs/checks.md). Mark `polarity` on every LED, diode and
electrolytic capacitor — it is the one check that catches reverse polarity.
A diode whose anode belongs on ground (TVS, flyback clamp) declares
`"role": "shunt"` instead of being exempted by hand.

Reusable complete examples live in [`recipe/`](recipe) and
[`examples/designs/`](examples/designs). Copy the closest one and edit it —
that is faster and safer than writing a design from a blank page.

```bash
node scripts/recipe.js list                       # 16 sub-circuits
node scripts/recipe.js show rc-lowpass             # parts, nets, params
node scripts/recipe.js apply ldo-3v3 --to design.json \
     --set cout=22uF --net VOUT=3V3_RAIL           # merge, rename, de-duplicate ids
```

Recipes declare `params` and may use `${name}` placeholders, so `--set` is a
real override rather than a find-and-replace in your head.

## Checks — run them, read the codes

| Gate | Command | Fails on |
| --- | --- | --- |
| format | `node scripts/validate.js --dir <p>` | structural/reference corruption |
| electric | `node scripts/erc.js --dir <p> [--design design.json]` | floating pins, dead-end nets, netlist≠design, PCB↔schematic mismatch |
| layout | `node scripts/lint-layout.js --dir <p>` | overlapping symbols, wires through bodies, parts outside their block, off-grid |
| copper | `node scripts/drc.js --dir <p>` | spacing, edge clearance + DFM: min drill / annular ring / silk-on-pad / acute track angle (D009–D012). A board this skill built is always `placed-only` — `D004` (unrouted) and `D006` (no pour) are never judged on it; imported or client-saved boards that carry tracks/pours get the full copper rules |
| intent | `node scripts/intent.js --design design.json` | polarity reversed, decoupling/pair/divider/value-range violations, **unverified pinouts** (I007: a multi-pin inline symbol for a real device without `pinoutSource`) — mistakes *inside* design.json |
| netlist | `node scripts/netcheck.js --dir <p>` | schematic ↔ PCB netlist mismatch, pin by pin (missing pads, retagged nets, floating pins). `build.js` runs it every build; re-run it standalone after hand edits in the client |
| netlist audit | `node scripts/netlist.js --dir <p> --design design.json --audit <out>` | spec ↔ built disagreement, floating pins, NC violations, PCB mismatch — judged by a fresh sub-agent against the package's `rubric`, not by you (see [Netlist audit](#netlist-audit--a-fresh-reviewer-not-you)) |

`--json` on any of them gives machine-readable output (every finding carries a
`fix` field — do what it says). lint and DRC also print a 0–100 score. Rule
tables: `node scripts/lint-layout.js --rules`, `node scripts/drc.js --rules`,
`node scripts/intent.js --rules`, and [`docs/checks.md`](docs/checks.md).

**Repair loop:** read the failing code, apply its `fix:` line (usually: edit
the design, re-run `build.js --force`). Mechanical fixes — NC for unconnected
pins, decoupling caps — are automated, but **show the diff before writing**:
`node scripts/autofix.js --design design.json --diff` prints the exact
before/after lines and writes nothing; drop `--diff` only after the user has
seen it. Netlist-audit findings join the same loop: each round ends with a
rebuild **and** a fresh audit of the new netlist. Never hand-edit project files unless you have read
[`docs/format-reference.md`](docs/format-reference.md).

## Incremental editing (when a design file is overkill)

Copper primitives are out of the skill since 1.13 — `add-track.js`,
`add-via.js`, `add-pour.js`, `add-fill.js` and `pour-auto.js` were removed;
tracks, vias and pours are drawn in the EasyEDA client. Keep-out regions
(`add-region.js`) stay, because a keepout is not copper.

```bash
node scripts/pins.js --dir <p>                       # every pin + exact tip + net
node scripts/add-wire.js --dir <p> --sch S --sheet P \
     --from R1.2 --to C1.1 [--net SIG]               # wire BY PIN REFERENCE
node scripts/netlist.js --dir <p>                    # what is actually connected
node scripts/add-symbol.js  --dir <p> --sch S --sheet P --symbol RES --footprint R0603 --x 300 --y -440 --refdes R1
node scripts/add-footprint.js --dir <p> --pcb PCB1 --symbol RES --footprint R0603 --x 300 --y 300 --refdes R1 --nets "1:VCC,2:SIG"
node scripts/add-text.js / add-shape.js / add-pcb-shape.js / add-pcb-text.js / add-region.js
node scripts/recipe.js list | show <name> | apply <name> --to <design.json>  # parameterised sub-circuits
node scripts/generate-symbol.js from-pins --dir <p> --name <sym> --pins "1:A;2:B"
node scripts/generate-footprint.js from-pads --dir <p> --name <fp> --pads "1:-16,0,31,35;2:16,0,31,35"
node scripts/set-refdes.js renumber --dir <p> --sch S --sheet P --prefix R
node scripts/cleanup.js --dir <p>                    # drop .tmp staging (build does this itself)
```

**Never hand-compute a pin coordinate.** `scripts/pins.js` lists exact tips;
`add-wire --from/--to` (or `--link "R1.2>C1.1;R1.1>U1.3"`) resolves them and
routes orthogonally. Hand arithmetic is how a schematic silently loses a net.

Coordinates are mil, 10 mil grid; schematic records are Y-down (client native,
blocks laid out downward from y=0), PCB is Y-up. Connectivity is exact coordinate equality
on the pin tip; that is why the helpers above exist.

## Layout rules the builder already enforces

Blocks are grid-packed in declaration order (signal flow left→right), symbols are
ordered by connectivity inside each block, every block gets a frame + title, nets
are encoded weakest-to-strongest: straight wire → L/Z → trunk bus → stub+label,
and power nets become flags. The layout lint verifies the result. If you hand-place
parts, keep these invariants:

- one block = 2–8 related parts (tight blocks keep signals wired instead of
  falling back to labels — that fallback is how nets have shorted before);
  decoupling caps stay with their IC;
- wires orthogonal only, endpoints on pin tips;
- nearby pins get **visible wires**, not labels — a pin fanning into labels is the
  anti-pattern; labels are for far/cross-block links and need a ≥30 mil stub;
- net names UPPERCASE and meaningful (`SPI_CLK`), never `N$1`;
- rows ≥200 mil apart so designator/name labels don't collide.

What the builder does on top of that (and what to keep when editing by hand):

- **Symbols come from the library verbatim.** A real device uses `"ic": "<name>"`
  (official cache, original symbol/footprint geometry and names). An inline
  `symbol: {pins:[...]}` is a last resort for parts that have no official entry;
  the builder draws it in the official IC style — 100 mil pitch, pin names
  inside the body, numbers outside, both visible, body widened to the longest
  name — and keeps the original name on the symbol/footprint documents (the
  `SYM_`/`FP_` prefix is only the staging key).
- **ICs stay upright**: a symbol with more than four pins only flips 0/180.
- **Module = one functional unit, read left→right / top→bottom.** Caption at the
  top-left; the frame is grown after routing so port names, flag names and
  stub labels stay inside it.
- **Wires inside a module, ports between modules.** Same-block nets are wired
  (L/Z through horizontal or vertical channels); stub + label is the fallback
  only when no clean orthogonal path exists. Do not turn local nets into
  global labels to save wiring. A net that leaves the block gets ONE port per
  module side — but a pin in a dense 100-mil column takes a stub + **global net
  label** instead, because stacked port bodies/names overlap each other (the
  label joins the same net by name just the same).
- **Pages carry functional names**: `sheetNames: ["电源与充电","主控",…]`; a
  multi-page design without it names each page after its first block. A
  single-page design keeps `sheet.name` (usually `P1`).
- **Symbol and package names are datasheet names.** An auto footprint is named
  from its land pattern (`QFN-24_L5.6-W5.6-P0.50`), never a bare `QFN`; an
  author-supplied descriptive name is kept. Multi-unit symbol docs and their
  PART titles show the device name (no `SYM_` staging prefix).
- **Designator at the symbol's top-left, value at its bottom-left**, outside
  the body — never inside a large IC.
- **Pattern catalog (template-first, like composing slide layouts).** A block
  that matches a pattern gets its pinned geometry instead of the generic grid:
  two-pin **chains** (LED+R, RC, divider), **parallel/pull banks** (decoupling
  rows), a **sub-bank** beside an IC inside a mixed block, **hub+satellites**
  (a regulator/connector/button with the caps, ESD or gate-RC beside the pins
  they belong to), a **crystal + load caps** triangle, a **series + shunt
  bank** (an inductor/ferrite/0R with the output-cap row beside its far pin —
  DCDC stages, antenna pi-filters, RC filters), and a **two-anchor bridge**
  (AC-coupling caps or series resistors strung between two ICs), and a
  **link array** (two-pin parts on entirely independent nets — DNP straps, AC
  coupling arrays — one aligned column). A mixed block
  absorbs several patterns in one pass until nothing matches. Unmatched blocks
  keep the grid — extend the catalog in `sch-patterns.js` before adding
  one-off geometry. Measure it with
  `node scripts/pattern-coverage.js --design <file>` (or `--gen`): every block
  is reported `ok` (absorbed) or `gap` (falls back to the grid), with the
  coverage percentage — the target is ≥90%. A block that only holds lone
  symbols (multi-pin ICs) or single-pin parts (mounting holes, test points)
  counts as covered: the catalog groups PASSIVE two-pin parts, and the grid is
  the right place for a lone symbol.
- **Port kind follows the signal**: Netport-OUT when this module only drives the
  net, Netport-IN when it only receives it, Netport-BI for buses, mixed or
  unknown direction (evidence: declared pin dir → symbol pin type → pin name).
- **Power and ground**: decoupling caps sharing a supply/ground form one row with
  one rail and one flag; a dense IC side (power pins within 200 mil of each
  other) carries labels instead of stacked flags; a ground flag hangs below a
  horizontal pin, and an upward pin gets a label instead of a flag on the part.
- **PCB placement mirrors the modules**: each schematic block becomes one
  cluster around its largest part; every other member is placed next to the
  pads it shares a (non-ground) net with, so decoupling caps land at their
  supply pins. Clusters are packed in block order with a 300 mil channel;
  connectors (J/CN/USB) take the board edge. Placement only — no copper.

## Library tiers

Presets ship with the skill (`templates/library/{symbol,footprint}/`) and resolve
first — **only generic, non-model entries live there**: passives, diodes, LEDs,
test points, power flags, net ports and common packages. Parts with a real
part number are **not shipped and not cached**: they are resolved through the
EDA client at build time and placed by it.

```json
{ "id": "U1", "ic": "STM32F103C8T6", "lcsc": "C8734", "pins": { … } }
```

`scripts/lib/cli-lib.js` asks the client for the device geometry, writes the
skeleton around it, then the client places the official symbol
(`sch_SourcePrimitiveComponent.add`) and footprint
(`pcb_PrimitiveComponent.create`), sets the designator and the pad nets.
Requires the client **V4.1.94+** (`node scripts/eda.js doctor`); there is no
local IC cache and no HTTP fetch in 2.x. Class-based device auto-selection is
gone — name the device or give its LCSC id.

Generated/inline entries are staged under `<project>/.tmp/library/` during
authoring and removed by `build.js` or `cleanup.js`; `load-library.js
list|show|remove` inspects that tier. Inline entries are staged as `SYM_*` /
`FP_*` so a symbol and footprint sharing a display name cannot collide.

## Where to read next

| Need | Read |
| --- | --- |
| design.json edge cases, multi-sheet, PCB rules, copper policy | [`docs/build.md`](docs/build.md) |
| every check code and what it means | [`docs/checks.md`](docs/checks.md) |
| land-pattern / symbol dimensions and their external sources | [`docs/footprint-evidence.md`](docs/footprint-evidence.md) |
| record-level format spec | [`docs/format-reference.md`](docs/format-reference.md) |
| a full worked manual flow (no design file) | [`docs/workflow.md`](docs/workflow.md) |
| extending the skill, iteration protocol | [`docs/development.md`](docs/development.md) |
| requirement form, 追问 protocol, confirmation gates | [`docs/intake.md`](docs/intake.md) |
| launching the client, non-default install paths | `node scripts/open.js --help` |
| regression / benchmark / compliance | `node test/pipeline.js`, `node test/dfm.js`, `node test/corpus.js`, `node scripts/eval.js [--diff] [--design <file>]`, `node scripts/depcheck.js` |

## Output style

- Show the design file you wrote, the `build.js` invocation, and the final summary line.
- Do not narrate the format spec or "what eprj3 is" unless asked.
- Reference files as Markdown links: `[build.js](scripts/build.js)`.
- Report scores and any remaining warning codes honestly; a 82/100 layout with two
  `L006` warnings is worth stating, not hiding.

## Known limitations

- **Format dialect: V4.** Generated files write the current client shapes
  (ticketed `{"type":"DOCHEAD","ticket":1}` frame, `.ecfg` = DOCHEAD+META);
  the readers accept V3 and V4 alike — calibrated against real client-saved
  projects (official quick-start from 4.1.78 + H610): `validate.js` 0 errors
  on both. Never detect record kinds by string prefix; `E.isDocHeadLine` and
  `E.parseRecord` are the only sanctioned readers.
- Fidelity is only provable in the real client. If it refuses to open, run
  `validate.js` first, then compare with [`examples/blink`](examples/blink).
  Set `EPRJ3_DETERMINISTIC=1` to build byte-identical projects for golden-file
  diffs.
- **Cross-module signals use net ports where they fit** — one official port per module side for any net that leaves its block; a pin in a dense 100-mil column takes a stub + global net label instead (stacked port bodies overlap). Long wires across the page do not exist.
- **The skill never implements a router or a pour engine.** The offline build
  writes no copper; it prints the `rats:` handoff (nets still to connect, with
  pad counts). 2.x can ask the *client* to do the copper — `eda.js pcb --route`
  and `eda.js pour` run the vendor engine, then the screenshots and
  `check-net` verify the result. Differential pairs, length matching and
  impedance control remain client/human tasks. Flat multi-sheet authoring IS
  supported (`sheets: N` + net ports); hierarchical sheet navigation and
  simulation documents are not — finish those in the client.
- **Pin definitions of real devices are never invented.** Use `"ic": "<device>"`
  so the client supplies the official pins and places the symbol; if the
  client library truly lacks the part, self-build a quality symbol (functional
  pin grouping) + an `{auto}` footprint, **confirm the pinout with the user
  against the datasheet**, and declare `pinoutSource: "按 datasheet 手工绘制（用户已确认）"`
  — I007 fails any multi-pin inline symbol for a real device without it.
- **The system library belongs to the client.** 2.x never caches or downloads
  library documents; the client resolves devices and places them itself.
- **The deliverable is the `.eprj3` project itself — nothing else.** No
  manufacturing artifacts: BOM, pick-and-place / coordinate files, Gerber or
  production archives are out of scope; the EasyEDA client exports those. Do
  not add export commands to this skill.
