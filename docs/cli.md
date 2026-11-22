# CLI bridge (2.x)

2.x moves the work the EDA client can do itself into the client: library
search, component placement, copper pour,
netlist extraction and canvas screenshots. The skill ships thin Node scripts
that open the project through the **LCEDA Pro / EasyEDA Pro CLI** and run the
client's own `source` / auto APIs; the model calls these scripts instead of
writing JavaScript. Geometry is authored by the AI in `design.json` (see
[`ai-layout.md`](ai-layout.md)) — the client executes the given coordinates and
makes no layout or routing decisions of its own.

## Requirement

- Desktop client (LCEDA Pro or EasyEDA Pro) **V4.1.94 or newer**.
  The source APIs used here start at 4.1.83; 4.1.94 is the verified build.
- The CLI executable is `lceda-pro` / `easyeda-pro`. The scripts find it at the
  standard install locations or on `PATH`; override with `--cli <path>` or the
  `LCEDA_PRO_CLI` / `EASYEDA_PRO_CLI` environment variable.
- The local bridge must be reachable for `invoke`/sessions. When no client is
  running, the scripts boot it in hidden mode themselves (see below); `doctor`
  reports the state either way.
- **Headless while generating.** Every session these scripts open is headless
  (`open --headless true`) and every command closes + destroys its session.
  The bridge itself is booted in **hidden mode** (`lceda-pro --owner`, tray
  only): plain `open` on a cold client would start the full GUI, because
  `--headless` hides the project render, not the app that the command
  launches. `node scripts/open.js` is the only visible step — it is the
  intended final step of a build.

Every script checks the version first and refuses to continue with a clear
message when the client is older or missing.

## Commands

All commands print one JSON envelope (`{ ok, value, error }`).

| command | what it does | client API |
|---|---|---|
| `node scripts/eda.js doctor` | locate the CLI, print version / endpoint / version gate | `doctor` |
| `node scripts/eda.js search --q "LM358" [--limit 10] [--page 1]` | fuzzy device search in the system library | `lib_Device.search` |
| `node scripts/eda.js search --lcsc C7950` | exact device by LCSC id (symbol/footprint names included) | `lib_Device.searchByProperties` |
| `node scripts/eda.js pins --lcsc C7950` / `--q "LM358"` / `--device "LM358DR2G"` | official symbol pin table (number, name, side, position, electrical direction) for net mapping | `lib_Symbol.getGeometry` |
| `node scripts/eda.js netlist --dir <project> --out netlist.json` | export the schematic netlist as the EDA JSON, then simplify it to `parts[{ref,name,device,footprint,pins}]` + `nets{name:[ref.pin]}` | `sch_ManufactureData.getNetlistFile` |
| `node scripts/eda.js sch-drc --dir <project>` | run the client's schematic DRC; print counts and every violation (rule, net, designator/pin) | `sch_Drc.check` |
| `node scripts/eda.js screenshot --dir <project> --out <dir> [--doc sch\|pcb] [--page N]` | write PNGs of every schematic page, or the PCB canvas | `sch_ManufactureData.getPngFile`, `dmt_EditorControl.getCurrentRenderedAreaImage` |
| `node scripts/eda.js pour --dir <project> --net GND --outline x1,y1,x2,y2 --layers 1,2` | create copper pour borders **and rebuild their fill**; `--outline` is in PCB data units (mil; the board rectangle is the board-outline path in the `.epcb2`) | `pcb_PrimitivePour.create` + `rebuildCopperRegion` |
| `node scripts/eda.js route --dir <project> [--no-save]` | run the client's **auto-router** on the PCB (`pcb_Document.autoRouting`) and save | `pcb_Document.autoRouting` |
| `node scripts/eda.js run --dir <project> --file <script.js> [--args '{"json"}'] [--pcb] [--save]` | execute an **AI-authored script** inside the headless client session (routing, bespoke placement, bulk edits). The file is the body of an async function: top-level `await` works, `return` sets the JSON result, `__CLI__.args` holds `--args`, `eda` is the API root, `waitReady`/`pagesOf`/`pcbsOf` helpers are pre-defined; `--pcb` opens the PCB document first, `--save` saves PCB + schematic afterwards | everything (`pcb_PrimitiveLine.create`, `pcb_PrimitiveVia.create`, `pcb_PrimitivePad.getAll`, …) |

`--keep` keeps the session open (debugging); by default every command closes
and destroys its headless session so batch runs do not leak editor windows.

## Library instances

`build.js` itself drives the client for any part written as `"ic": "<device>"`
(+ optional `"lcsc"`): `scripts/lib/cli-lib.js` resolves the device geometry
(`lib_Symbol.getGeometry` / `lib_Footprint.getGeometry`) so `build.js --geometry`
can show real pin/pad coordinates before anything is authored, writes the
project skeleton, then opens the project and:

- places each official symbol with `sch_SourcePrimitiveComponent.add` (one
  session), then reopens the project in a fresh session — the client only
  exposes newly placed primitives to its netlist engine after a reload;
- calls `pcb_Document.importChanges(schUuid, true)` — the client's own
  "schematic → PCB" update. It creates every footprint and links every pad net.
  The PCB document ships only the embedded symbol/footprint/device documents —
  no pre-placed instances — so nothing has to be deleted first (4.1.94 leaves
  empty `COMPONENT`/`PAD_NET` shells behind after a delete; a safety net removes
  those if an older project still needs the delete path);
- moves every footprint to the authored position in `pcb.place`
  (`pcb_PrimitiveComponent.modify`);
- places the designator/name rows through the source API
  (`sch_SourcePrimitiveComponent.updateAttribute`, addressed by designator +
  key) on the fresh PCB session — this also positions the symbols the client
  placed itself, which have no authored ATTR records; failures leave the
  authored position and are logged, never fatal;
- marks every design `"NC"` pin with the client's real **no-connect** marker
  (`sch_PrimitiveComponent.getAllPinsByPrimitiveId` +
  `sch_PrimitivePin.modify({ noConnected: true })`, document API on the opened
  page). The marker itself is client-managed state; leave the NC pin electrically open;
- uses the exact AI-authored footprint coordinates, without client auto layout or routing; explicit tracks and vias are written after client import;
- saves, after which validate / ERC / lint / DRC / netcheck read the
  client-written project. The import is complete by construction, but the
  offline `netcheck` still runs as an independent pin-by-pin diff and catches
  an import that silently dropped a part.

There is no library document download and no local cache. If a device name is
not found, pass its LCSC id (`"lcsc": "C12345"`) or fall back to an inline
symbol + `{auto}` footprint with a declared `pinoutSource`.

## Schematic DRC

After the sheet is written, `build.js` runs `sch_Drc.check(true, false, true)`
on the finished schematic (client builds only). The report lands in
`build.json` as `schDrc` (counts + violations with rule / net / designator /
pin); `fatalError`/`error` items fail the build unless `--allow-sch-drc` is
passed. `eda.js sch-drc --dir <p>` re-runs it, which is the repair list.

The builder does not snap or move geometry. Use the client grid when authoring wire vertices, power flags and ports, and fix any off-grid findings in the authored layout.

## Why "source" APIs

The client exposes two families of schematic APIs. The `source` family
(`sch_SourceDocument`, `sch_SourcePrimitiveComponent`, …) edits the project
source data directly; it has **no "current page" context** — every call names
`projectId` / `schematicName` / `pageName` — and it is the fastest path,
because it runs on the editor command space without rendering. The classic
`sch_Document` / `sch_Primitive*` family acts on an open, rendered document.
Prefer the source family for creation/editing; use the document family for
rendering, which are document-scoped by design.

Schematic wiring now follows the same rule on client builds: the routed chains
are drawn with `sch_SourcePrimitiveWire.add` (one connected polyline per chain)
and power/ground flags with `sch_SourcePrimitiveComponent.addNetFlag` (the
system library's `power-*` / `Ground-*` special symbols) after the official
symbols are placed. Zero-length anchor wires (a power flag or net port sitting
on a bare pin) and net ports stay in the record emitter — the API rejects
zero-length geometry, and `netport-*` devices added via `add` get a component
designator and a different orientation. Offline builds (no client) keep the
record emitter. Project files, frames, self-drawn library documents and
component placement remain skill-authored.

## Review loop (netlist)

1. `node scripts/eda.js netlist --dir <project> --out review/netlist.json`
   exports the client's netlist and reduces it to the refdes / pin→net / model
   fields the reviewer needs.
2. Hand `review/netlist.json` to a fresh sub-agent (no inherited context) — it
   checks the net relationships against the PRD and reports design errors.
3. Fix `design.json` / the generator, rebuild, repeat.
4. When the client builds the PCB (`importChanges`), the schematic ↔ PCB
   netlist is consistent by construction — no separate diff step is needed.
   `scripts/netcheck.js` stays available for boards the skill places itself
   (no client).

## Visual loop (screenshots)

`node scripts/eda.js screenshot --dir <project> --out screenshots` writes one
PNG per schematic page plus the PCB canvas. Read the PNGs to judge layout /
routing quality and repair the explicit geometry in the design.

Client-side limitations (4.1.94):

- `importChanges(uuid)` takes the **schematic** UUID (the page UUID is not the
  API contract). A `true` return with **zero** footprints means the schematic
  exposed no footprint-bearing component — only power flags / symbol-only
  parts — or the import was skipped; a schematic with 4 library devices
  imports 4 footprints through the same call. The build fails with that
  diagnosis instead of retrying with a page UUID.
- Importing into an **already-routed** board keeps the copper, but may clear
  the footprint reference of footprint-only parts and does **not** clear an
  existing "Netlist Error" badge; a fresh import from the same schematic shows
  the same badge even when the pin-level netlists match. Never rebuild a
  routed board just to clear that badge.
- `pour` now rebuilds the fill (`rebuildCopperRegion`). The engine returns no
  fill when the outline reaches into an area where the clearance rules remove
  all of it (observed on the ESP32 board near the top/right edge): the command
  reports `filled:false` per layer — inset the outline and retry (a ~300 mil
  inset filled the same board). `pcb_PrimitivePoured.create` itself is a no-op;
  the rebuild call is the only way to make copper.
- `netcheck.js` reads the skill's `PAD_NET` records. It now also runs on
  client-imported boards: the import writes one PAD_NET per real pad, and the
  empty-shell records 4.1.94 used to leave behind are gone (see above), so the
  pin-by-pin diff is meaningful instead of counting phantom pads.

## Routing paths

Three ways to put copper on the board — all of them end in the same local
re-check (`node scripts/drc.js --dir <p>` in routed mode, `netcheck.js`):

1. **Authored tracks (declarative).** `pcb.tracks` / `pcb.vias` in
   `design.json` — the build writes them as records. Deterministic and
   re-reviewable; the default for AI-authored boards.
2. **Client auto-routing.** `node scripts/eda.js route --dir <p>` runs
   `pcb_Document.autoRouting()` headless and saves. The routed copper is NOT
   in `design.json` — a `build.js --force` rebuild loses it, so keep a client
   copy or re-run the router afterwards.
3. **AI-authored routing script.** The AI reads the board detail it needs
   (pad positions, nets, outline — e.g. `pcb_PrimitivePad.getAll()`,
   `pcb_PrimitiveComponent.getAll()`), computes the routes itself, and draws
   them through `pcb_PrimitiveLine.create(net, layer, x1, y1, x2, y2, width)`
   and `pcb_PrimitiveVia.create(net, x, y, drill, diameter)`. Execute it with:

   ```bash
   node scripts/eda.js run --dir <p> --file route.js --pcb --save \
     --args '{"layer":2,"width":10}'
   ```

   ```js
   // route.js — body of an async function; this example chains the two pads
   // of one footprint on layer 1 with an orthogonal two-segment route
   const width = __args.width || 10;
   const pads = await eda.pcb_PrimitivePad.getAll(1, "NET");
   pads.sort((p, q) => p.getState_X() - q.getState_X());
   const [a, b] = pads;
   const midX = (a.getState_X() + b.getState_X()) / 2;
   await eda.pcb_PrimitiveLine.create("NET", 1, a.getState_X(), a.getState_Y(), midX, a.getState_Y(), width);
   await eda.pcb_PrimitiveLine.create("NET", 1, midX, a.getState_Y(), midX, b.getState_Y(), width);
   await eda.pcb_PrimitiveLine.create("NET", 1, midX, b.getState_Y(), b.getState_X(), b.getState_Y(), width);
   return { routed: 3, pads: [a.getState_PadNumber(), b.getState_PadNumber()] };
   ```

After any of the three, the local DRC runs in routed mode and judges the
copper that is actually on the board (D001 spacing, D004 connectivity, …);
findings loop back the same way authored-track findings do.

## Version check

```bash
node scripts/eda.js doctor
# { "ok": true, "value": { "version": "4.1.94", "connected": true, ... } }
```

Older clients: the command exits non-zero with
`CLI_VERSION_TOO_OLD — this skill needs 4.1.94+`.
