# Footprint / symbol evidence table

Requirement: library numbers must be **traceable to an external source** — not
to "whatever the shipped recipes already used" (that loop is self-verification,
and it did bake in an error: the original SOT-23 pad row sat 60 mil apart, ~0.35
mm inside the actual leads).

Rules for anyone extending this table or the families in
[fp-auto.js](../scripts/lib/fp-auto.js):

1. A family's key dimensions cite a **standard** (JEDEC / IPC-7351) or a **real
   part** (LCSC footprint of an orderable component) — recorded here, with the
   number the generator uses.
2. [test/dfm.js](../test/dfm.js) asserts those numbers. When a dimension
   changes, change the evidence row and the test in the same commit — never the
   test alone.
3. All values are mil (1 mil = 0.0254 mm).

## Auto families (`{auto: …}`)

| family | key dims (mil) | evidence |
| --- | --- | --- |
| `SOT23` | pad 24×30 @ x=±47, in-row pitch 37 | JEDEC TO-236AB / MO-178: lead span 2.10–2.50 mm, in-row pitch 0.95 mm; pad centres ±1.19 mm per IPC-7351B nominal density (e.g. LCSC BC817 footprint). Fixed in 1.14.0 — before, pads sat at ±30 (1.52 mm span), inside the leads |
| `SOT23-5` | pad 24×30 @ x=±55, pitch 37 | TSOT-23-5 / SC-74A (JEDEC MO-178): lead span 2.8 mm → centres ±1.4 mm; pitch 0.95 mm (e.g. LCSC LMV358 footprint) |
| `SOT23-6` | pad 24×30 @ x=±55, pitch 37 | TSOT-23-6 (SC-70-6 variant class): same body/lead span as SC-74A, 3×0.95 mm row |
| `SOT223` | pads 28×40 @ x=-90/0/+90, y=-100; tab 60×100 @ y=+150 | JEDEC TO-261 (SOT-223): in-row pitch 2.3 mm (90 mil), tab 3.6 mm centre from row, tab pad 1.5×2.3 mm class (e.g. LCSC AMS1117-3.3 footprint) |
| `SOP<n>` | pad 24×55 @ span 80, pitch 50 | SOIC-8 (JEDEC MS-012): lead span 5.8–6.2 mm → centres ±2.0–2.3 mm; pitch 1.27 mm. Matches SOIC_8P as shipped in rs485.json |
| `SSOP<n>` | pad 20×38 @ span 95, pitch 25.6 | SSOP/TSSOP 0.65 mm pitch class (JEDEC MO-150): pitch 25.6 mil |
| `TSSOP<n>` | pad 24×28 @ span 120, pitch 37 | TSSOP-20 (MO-153): pitch 0.95 mm (37 mil), lead span 6.4 mm → centres ±3.0–3.2 mm |
| `QFN<n>` | pad `0.45×pitch` wide × `1.35×pitch` tall, span derived | QFN pitch classes 0.4/0.5 mm (JEDEC MO-220); pad length ≈ 0.8 mm at 0.5 mm pitch. **Thermal pad NOT modelled** — hand-write an inline footprint (with the EP pad) for QFNs that need it |
| `QFP`/`LQFP<n>` | pad `0.55×pitch` wide × `2.8×pitch` tall, span derived | LQFP-48 0.5 mm pitch (JEDEC MO-220 variant): pad ≈ 0.28×1.4 mm |
| `DIP<n>` | pad 60×60, hole 32, pitch 100, rowSpan 300 | 0.1″ (2.54 mm) grid; 0.9–1.0 mm drill for square posts; 300 mil row span = the common 7.62 mm DIP class |
| `HDR<n>` / `HDR2R<n>` | pad 60×60, hole 32, pitch 100 | 2.54 mm pin header, 0.8–1.0 mm drill (e.g. LCSC pin header) |
| `SW_4P` | pads 60×50 @ x=±100, y=±70 | 6×6 mm tactile switch land pattern (e.g. TS-6606 class); verify against the specific switch before assembly |
| `XTAL` | pads 50×60 @ x=±60 | HC-49S SMD (5032 class) crystal pads; verify against the specific crystal |
| `OSC` | pads 40×40 @ x=±60, y=±40 | 3225 (3.2×2.5 mm) MEMS oscillator pads |
| `USB_C` | 10 pads 24×32 @ x=±60 | **POWER-ONLY**: VBUS A4/A9/B4/B9, GND A1/A12/B1/B12, CC1/CC2 A5/B5 per the USB Type-C spec pin names. DP/DM/SBU/shield are NOT modelled — a pin mapped without a pad fails ERC (E006). Use a hand-written inline footprint for full-featured USB-C |

## Preset footprints (`templates/library/footprint/`)

| preset | key dims (mil) | evidence |
| --- | --- | --- |
| `R0603`/`C0603`/`L0603` | pads 31.75×34 @ ±29.66 | IPC-7351B nominal for 1608M (0603): pad ≈ 0.81×0.87 mm at ±0.75 mm (e.g. LCSC generic 0603 footprint) |
| `R0402`/`C0402`/`L0402` | pads 23×25 @ ±19 | IPC-7351B nominal for 1005M (0402): pad ≈ 0.58×0.63 mm at ±0.48 mm. Fixed in 1.14.0 — before, pads were 0603-sized (0.8×0.9 mm) |
| `LED0603` | like 0603 + polarity-marked silk | 1608M LED land pattern |
| `SMA` | pads 78.74×78.74 @ ±86.6 | SMA (DO-214AC) diode: pad 2×2 mm at ±2.2 mm (e.g. SS34/SMBJ footprints) |
| `TP0.5` | pad 19.685×19.685 @ origin | test point ≈ 0.5 mm probe pad |

## Preset symbols (`templates/library/symbol/`)

| preset | convention | evidence |
| --- | --- | --- |
| `DIODE`, `LED` | **pin 1 = A (anode), pin 2 = K (cathode)**; designator `D?`; both carry diode artwork (triangle + bar; LED adds emission arrows) | unified in 1.14.0 — DIODE previously had pin 1 = K and designator `U?`, contradicting LED and KiCad's `A=1/K=2` convention |
| `RES` `CAP` `IND` | pin 1/2 symmetric | classic passive symbols |
| power flags `GND` `AGND` `PGND` `VCC` `5V` | connect at their ORIGIN (length 0) | captured from real client saves |
| `PORT_IN/OUT/BI`, `OFFPAGE_*` | connect at their ORIGIN | captured from real client saves |
| `TEST_POINT` | 1 pin | — |

## Still unverified against a real client open

`DIFF_PAIR`, `SHORT`, `A3`, `A4` frame symbols — listed in SKILL.md's known
limitations; do not rely on them for a deliverable until opened once in the
client.
