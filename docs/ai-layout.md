# AI-authored schematic and PCB geometry

The running AI agent makes all placement and routing decisions. The builder validates the declarations and writes them to the project; nothing runs a placement or routing engine. Circuit-only `intake` and recipe output must be completed by the AI before building.

## 1. Inspect library geometry

```bash
node scripts/build.js --design design.json --dir <project> --geometry
```

JSON gives each symbol's local boundary, assigned sheet, electrical pin hotspot and net, and each footprint's pad geometry. **With `sch.place` present every pin also carries `sheetAt` — its absolute sheet position** (rotate the local pin by the part's angle, add the placement); use those numbers verbatim as wire endpoints. After `pcb.place` is entered, each pad also gets its absolute `boardAt` position. No project is created. `--gen` works the same way; use `A.schematicLayout(sch)`, `A.pcbLayout(pcb)` and `A.board(width, height, layers)` to supply explicit geometry. Pin and pad offsets rotate counterclockwise from the part origin. Coordinates are Y-up. Schematic units are 10 mil each, not the same numeric units as PCB coordinates. Use positive schematic coordinates with margin for the drawing frame; the builder does not shift, rotate, snap, or rescale them.

**Connectivity the builder proves before writing anything** (all problems are
reported together):

- every pin on a non-NC net must land on a **wire endpoint** — a pin in the
  middle of a segment is not connected (the client joins only at wire ends);
  a pin coincident with another pin of the same net is also accepted;
- every `sch.flags` / `sch.ports` entry must sit on a wire endpoint (a flag on
  a bare pin needs a short stub wire);
- a net with pins on more than one sheet needs a **net port or power flag on
  every one of those sheets** — a wire name alone does not cross pages;
- errors name the pin, its `sheetAt`, the nearest wire endpoint and the
  distance, so the fix is a coordinate edit in `sch.wires`.

## 2. Supply geometry

| Field | Required / meaning |
| --- | --- |
| `sch.place` | Map every schematic designator to `[x, y, angle]`; angle is a multiple of 90 degrees. Multi-unit symbols use their expanded unit IDs. |
| `sch.wires` | Array of `{net, points: [[x,y], ...], sheet?, label?}`. Minimum two points; orthogonal, nonzero segments. End a segment at every connected pin and tee. `label:false` hides the displayed name but preserves its electrical name. Named stubs may connect by name. |
| `sch.flags` | Optional `{net, at:[x,y], kind:"up" or "down", sheet?}` entries. Join the flag hotspot to a wire endpoint. |
| `sch.ports` | Optional `{net, at:[x,y], kind:"IN", "OUT" or "BI", sheet?}` entries. Use matched names and join each port to a wire endpoint. |
| `sch.frames` | Optional map from 1-based block index to `[xMin,yMin,xMax,yMax]`. Frames are written at these coordinates. |
| `blocks[].sheet` | For multi-page projects, explicitly assign every part to a block with a page number and set `sheet` on each wire, flag and port. Single-page geometry defaults to sheet 1. |
| `board` | Exact rectangular outline from `(0,0)` to `(width,height)`, in mil; explicitly set positive width/height. `layers` defaults to 2; inner copper IDs start at 15 (e.g. 15 and 16 on a 4-layer project). Review stackup details in the client. |
| `pcb.place` | Every physical footprint gets `[x,y,angle]` in mil/degrees. Multi-unit components use one base designator. The declarative writer places footprints on the top side; use explicit editor edits for bottom-side placement. |
| `pcb.tracks` | `{net, layer, width, points:[[x,y],...]}` per continuous same-layer path, in mil. Use layer 1 for top and 2 for bottom. Explicitly land each route on its pads and split paths at intentional junctions. **Alternative routing (post-build)**: `node scripts/eda.js route --dir <p>` runs the client's auto-router; or author a routing script (read pads via `pcb_PrimitivePad.getAll`, draw via `pcb_PrimitiveLine.create`/`pcb_PrimitiveVia.create`) and execute it with `node scripts/eda.js run --dir <p> --file route.js --pcb --save` — see [cli.md](cli.md#routing-paths). Client-routed copper is not in `design.json` (a `--force` rebuild loses it) and must pass the same local routed-DRC check. |
| `pcb.vias` | Optional `{net, at:[x,y], diameter, drill}` through vias, in mil. Change copper layers only through a via or plated through-hole connection. |
| `pcb.mode` | Defaults to `routed`; DRC checks copper connectivity even when `tracks` is empty — but the key itself is REQUIRED in routed mode (an explicit `[]` means "no copper written yet"). Only use `placed-only` for an agreed placement-only draft, with no tracks/vias. Use `pcb:false` for schematic-only output. |

Keep intentionally unused pins (`NC`/`DNC`) out of geometry. With system-library builds the client attempts to add NC markers; standalone checks can take `--design` to know which pins are intentionally open. Declare inspection rules under `pcb.rules` — **accepted keys, verbatim**: `clearance` (D001/D003 spacing, default 10), `trackWidth` (D002 min width, 8), `edgeClearance` (D003, 12), `minDrill` (D009, 12), `minRing` (D010, 4), `minAngle` (D012, 45). The DRC-internal names `minTrack`/`edge` are not accepted. Net-specific width floors go under `nets`. The writer does not generate or verify plane fill; use the client on an explicitly planned region and verify connectivity and clearances there. Do not claim a successful unverified plane connection.

**Placement/routing limitations to state in the deliverable:** `pcb.place` places on the TOP side only (bottom-side assembly needs a client edit, and bottom-side pad coordinates are not mirrored by the local DRC — treat client DRC as authoritative for boards with bottom parts); `pcb.tracks` are polylines (no arcs, no teardrops); D012 flags bends under `minAngle` only — 60°/75° corners are legal, the 45°-only habit is a style; D013/D014 body checks are rotated AABBs of the footprint bbox, not true courtyards.

## 3. Verify and iterate

See [`test/fixtures/ai-resistor-link.json`](../test/fixtures/ai-resistor-link.json) and [`test/fixtures/blink.json`](../test/fixtures/blink.json) for complete authored layouts (tracks on both layers, vias, flags, a routed ground return). Run `--plan` for an offline rehearsal or, with official library devices, a declaration-only preview. Run an actual build to verify official library import and the resulting geometry. Review the build report: it distinguishes `routed` from `placed-only`, lists DRC findings, and includes the spec-versus-schematic audit and schematic-versus-PCB netcheck. The local DRC uses simplified geometry; real clearances, pours, stackup, impedances and manufacture require further review in EasyEDA Pro.

For older designs remove `pcb.layout`, `pcb.route` and `pcb.pour`; add `sch` and explicit PCB geometry. The old `--layout skill/client`, layout tuning, and auto-route switches are not supported. `--keep-layout` can reuse stored PCB coordinates; the AI must provide the locations of new parts and all intended copper. It does not preserve old copper on a rebuild. Prefer in-place editing to preserve existing traces and locks.
