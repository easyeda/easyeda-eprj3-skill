# CLI bridge (2.x)

2.x moves the work the EDA client can do itself into the client: library
search, component placement, **PCB** auto layout / auto route, copper pour,
netlist extraction and canvas screenshots. The skill ships thin Node scripts
that open the project through the **LCEDA Pro / EasyEDA Pro CLI** and run the
client's own `source` / auto APIs; the model calls these scripts instead of
writing JavaScript. Schematic layout/wiring deliberately stays on the skill's
own offline engine (the client's schematic auto engine ignores module frames).

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
| `node scripts/eda.js pcb --dir <project> [--clear] [--layout] [--route]` | PCB auto layout / auto route / clear routing and save | `pcb_Document.autoLayout` / `autoRouting` / `clearRouting` |
| `node scripts/eda.js pour --dir <project> --net GND --outline x1,y1,x2,y2 --layers 1,2` | create copper pour borders **and rebuild their fill**; `--outline` is in PCB data units (mil; the board rectangle is the board-outline path in the `.epcb2`) | `pcb_PrimitivePour.create` + `rebuildCopperRegion` |

`--keep` keeps the session open (debugging); by default every command closes
and destroys its headless session so batch runs do not leak editor windows.

## Library instances

`build.js` itself drives the client for any part written as `"ic": "<device>"`
(+ optional `"lcsc"`): `scripts/lib/cli-lib.js` resolves the device geometry
(`lib_Symbol.getGeometry` / `lib_Footprint.getGeometry`) so the offline engine
can plan positions, writes the project skeleton, then opens the project and:

- places each official symbol with `sch_SourcePrimitiveComponent.add` (one
  session), then reopens the project in a fresh session — the client only
  exposes newly placed primitives to its netlist engine after a reload;
- calls `pcb_Document.importChanges(schUuid, true)` — the client's own
  "schematic → PCB" update. It creates every footprint and links every pad net.
  The PCB document ships only the embedded symbol/footprint/device documents —
  no pre-placed instances — so nothing has to be deleted first (4.1.94 leaves
  empty `COMPONENT`/`PAD_NET` shells behind after a delete; a safety net removes
  those if an older project still needs the delete path);
- moves every footprint to the position the offline engine planned
  (`pcb_PrimitiveComponent.modify`);
- places the designator/name rows through the source API
  (`sch_SourcePrimitiveComponent.updateAttribute`, addressed by designator +
  key) on the fresh PCB session — this also positions the symbols the client
  placed itself, which have no authored ATTR records; failures leave the
  authored position and are logged, never fatal;
- marks every design `"NC"` pin with the client's real **no-connect** marker
  (`sch_PrimitiveComponent.getAllPinsByPrimitiveId` +
  `sch_PrimitivePin.modify({ noConnected: true })`, document API on the opened
  page). The NC stub + net label stays, so the pin keeps a net name for the
  client netlist and its PCB pad; the marker itself is client-managed state,
  not a source record;
- **runs the client's PCB auto layout** (`pcb_Document.autoLayout`) on the
  imported board — the same engine as `eda.js pcb --layout`, but automatic,
  after the board outline and the import exist. The planned positions stay as
  the fallback when the engine is missing or fails; `pcb.layout: "skill"` or
  `--skill-layout` skips the pass and keeps the engineering placement. The
  outcome is recorded as `pcb.layout` (`client-auto` / `skill-placement`) and
  `pcb.autoLayout` (duration / failed count / error) in `build.json`;
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

The layout snaps every wire vertex, flag, port and net label to the 50-mil
grid (5 schematic units): the client's NETOBJECTONGRID rule wants net objects
there, and router margins (+18, +53) otherwise leave a few jogs off it.

## Why "source" APIs

The client exposes two families of schematic APIs. The `source` family
(`sch_SourceDocument`, `sch_SourcePrimitiveComponent`, …) edits the project
source data directly; it has **no "current page" context** — every call names
`projectId` / `schematicName` / `pageName` — and it is the fastest path,
because it runs on the editor command space without rendering. The classic
`sch_Document` / `sch_Primitive*` family acts on an open, rendered document.
Prefer the source family for creation/editing; use the document family for
auto layout / auto route / rendering, which are document-scoped by design.

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
routing quality and feed concrete defects back into the design or into a
`pcb --layout` / `pcb --route` pass.

Client-side limitations (4.1.94):

- `pcb --layout` / `--route` change the board in place; pass `--clear` first
  when re-routing an already-routed board.
- `pcb_Document.autoLayout` is not part of the public 4.1.94 reference: on a
  build that does not expose it, `build.js` logs
  `PCB auto layout skipped — keeping the skill placement` and `build.json`
  carries the error; the board is still delivered (with the planner's
  positions).
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
- Schematic layout/wiring is **not** delegated to the client: the client's
  schematic auto layout ignores this skill's module frames and reads worse.
  The offline engine (`build.js`) owns it; 2.x only adds client-side review,
  netlist and PCB copper.
- `netcheck.js` reads the skill's `PAD_NET` records. It now also runs on
  client-imported boards: the import writes one PAD_NET per real pad, and the
  empty-shell records 4.1.94 used to leave behind are gone (see above), so the
  pin-by-pin diff is meaningful instead of counting phantom pads.

## Version check

```bash
node scripts/eda.js doctor
# { "ok": true, "value": { "version": "4.1.94", "connected": true, ... } }
```

Older clients: the command exits non-zero with
`CLI_VERSION_TOO_OLD — this skill needs 4.1.94+`.
