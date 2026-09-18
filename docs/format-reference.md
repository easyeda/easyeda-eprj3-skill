# eprj3 Format Reference

Compact reference for the records the scripts in this skill produce — verified against the official example at https://github.com/easyeda/easyeda-pro-eprj3-format (its `example/eprj3-example` project is the ground truth) and cross-checked against the JSON Schemas and real record samples of the **easyeda-pro-format-skill** repo: https://github.com/easyeda/easyeda-pro-format-skill. Every JSON snippet below is quoted from a real record or a sample-backed merge.

Refreshed 2026-09-18 against a full sweep of the companion repo (`primitives/`, `documents/`, `examples/`, `validate.js`) — the field-level traps are consolidated in [Gotchas](#gotchas-卡点经验-swept-from-easyeda-pro-format-skill) near the end.

## Project layout (folder format)

```
<projectName>/
├── <projectName>.eprj3                  ← project index (pretty-printed JSON)
├── sch/
│   └── <schematicName>/
│       ├── <sheetTitle>.esch2           ← sheet container (docs + SCH_PAGE main doc)
│       ├── <schematicName>.ecfg         ← 4 records: DOCHEAD(SCH) + META + RULE + RULE
│       └── <schematicName>.evar         ← empty file (variant data)
├── pcb/
│   └── <pcbTitle>.epcb2                 ← PCB container (docs + PCB main doc)
├── panel/                               ← optional — only when the user asks for a panel
│   └── <panelTitle>.epan2               ← panel container
└── .tmp/library/                        ← generation-time only: temp entries staged by
                                            this skill's generate-*/load-library scripts.
                                            Tooling metadata — the client never sees it;
                                            cleanup.js deletes the whole .tmp/ folder when
                                            authoring ends. Preset templates live in the
                                            skill repo (templates/library/{symbol,footprint}/).
```

The client resolves documents through the index `profile`, following these path conventions. Extra root-level files are tolerated (the official example itself ships README files inside the project directory).

## Index file (`<name>.eprj3`)

```jsonc
{
  "name": "blink",
  "format": "folder",
  "owner_uuid": "<32 hex>",        // owner/creator/modifier are 32-hex uuids
  "creator_uuid": "<32 hex>",
  "modifier_uuid": "<32 hex>",
  "created_at": "2026-09-09 10:00:00",
  "updated_at": "2026-09-09 10:00:00",
  "pcb_count": 1,                  // == number of entries in profile.pcbs
  "profile": {
    "boards":   { "<16hex>": { "uuid": "<16hex>", "title": "Board1", "zIndex": 1 } },
    "schematics": { "<16hex>": { "uuid": "<16hex>", "name": "Schematic1", "board": "<board-uuid>", "version": "<ms>", "updateTime": <ms> } },
    "sheets":   { "<16hex>": { "uuid": "<16hex>", "title": "P1", "schematic_uuid": "<sch-uuid>", "zIndex": 1, "version": "<ms>", "updateTime": <ms> } },
    "pcbs":     { "<16hex>": { "uuid": "<16hex>", "title": "PCB1", "board": "<board-uuid>", "version": "<ms>", "updateTime": <ms> } },
    "panels":   { "<16hex>": { "...": "..." } },
    "blockSymbols": {}, "simSchematics": {}, "simulations": {},
    "owner":    { "uuid": "<32hex>", "...": "..." }
  }
}
```

The `client` field used in document DOCHEADs is `md5(owner_uuid).hexdigest().slice(0,16)`.

## Container file grammar

`.esch2` / `.epcb2` / `.epan2` files are line-oriented. Each line is one record:

```
{"type":"TYPE","ticket":N,"id":"..."}||{body}|
{"type":"TYPE","ticket":N}|||        ← empty body
```

- Exactly two segments separated by `||`, terminated by a final `|`. `DOCHEAD` lines carry no ticket/id.
- **Never split a line on every `||`** — a `||` can appear inside a JSON string value. Parse the head as JSON up to the first `||`, then treat the remainder (minus the trailing `|`) as the body JSON.
- A container holds several **documents** back to back, each starting with a `DOCHEAD` line:

```jsonc
{"type":"DOCHEAD"}||{"docType":"SYMBOL","client":"<16hex>","uuid":"<16hex>","updateTime":<ms>,"version":"<ms>","editVersion":"2.3.0","user":{}}|
```

- **Per-container embedding policy:** each container embeds only the library docs its placed components need. A sheet embeds `SYMBOL` + `DEVICE` per device; a PCB embeds `SYMBOL` + `FOOTPRINT` + `DEVICE` per placed footprint. The **last** DOCHEAD of a container is the main document (`SCH_PAGE` in `.esch2`, `PCB` in `.epcb2`).
- **Tickets are unique within each document** — not globally monotonic across the file, and not increasing in file order inside a doc. Library docs restart their ticket scope per doc. Appending to a main doc uses `max(ticket in file) + 1`.

## Schematic container (`sch/<sch>/<sheet>.esch2`)

Document order in a real file (blink example): `SYMBOL(frame) DEVICE(frame) … SYMBOL DEVICE (per device) … FOOTPRINT DEVICE … SCH_PAGE(main)`.

The **SCH_PAGE main doc** opens with page META and the placed A4 frame, then one block per placed item:

```jsonc
{"type":"META","ticket":1,"id":"META"}||{"title":"P1","schematic":"<sch-uuid>","source":"","zIndex":1}|

// A4 frame component (always first; DeviceName → the embedded frame DEVICE doc)
{"type":"COMPONENT","ticket":34,"id":"acde227911e7a178"}||{"partId":"pid8a0e77bacb214e","x":0,"y":0,"rotation":0,"isMirror":false,"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":"{\"uuid\":\"212f2dc0ecb42d65\",\"name\":\"Drawing-Symbol_A4\",\"source\":\"\"}"},"zIndex":null}|
```

### Regular component block

```jsonc
{"type":"COMPONENT","ticket":110,"id":"e6fdad57320a09f7"}||{"partId":"pid8a0e77bacb214e","x":300,"y":-440,"rotation":90,"isMirror":false,"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":"{\"uuid\":\"b02c92de66f189fd\",\"name\":\"R0402\",\"source\":\"\"}","FootprintName":null,"pinClass":{},"differentialPairClass":{},"Symbols":"[]"},"zIndex":97}|
{"type":"ATTR",...}||{...,"key":"Symbol","value":"<symbol-uuid>","parentId":"e6fdad57320a09f7","zIndex":12,...}|   // value == embedded SYMBOL doc uuid
{"type":"ATTR",...}||{...,"key":"Device","value":"<device-uuid>","parentId":"e6fdad57320a09f7","zIndex":-2,...}|
{"type":"ATTR",...}||{...,"key":"Unique ID","value":"gge7",...}|
{"type":"ATTR",...}||{...,"key":"Name","value":null,"zIndex":<nameZ>,...}|        // page z's mirror the
{"type":"ATTR",...}||{...,"key":"Designator","value":"R1","valueVisible":true,"zIndex":<designatorZ>,...} // symbol doc's Name/Designator z (+1)
{"type":"ATTR",...}||{...,"key":"Reuse Block"|"Group ID"|"Footprint"|"Relevance",...}|
```

`rotation` is degrees CCW; symbol units map 1:1 onto page mil (a pin placed at symbol `(20,0)` rotation 180 lands 20 mil right of the component origin on the page).

### Power symbol block

Power components are ordinary `COMPONENT` records whose attrs **omit** `pinClass`/`differentialPairClass`/`Symbols` and carry `DeviceName: null`; the net lives in two standalone attrs:

```jsonc
{"type":"COMPONENT",...}||{"partId":"pid8a0e77bacb214e","x":300,"y":-500,"rotation":0,"isMirror":false,"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":null,"FootprintName":null},"zIndex":96}|
{"type":"ATTR",...}||{...,"key":"Symbol","value":"<power-symbol-uuid>","zIndex":1,...}|
{"type":"ATTR",...}||{...,"key":"Device","value":"<power-device-uuid>","zIndex":12,...}|
{"type":"ATTR",...}||{...,"key":"Relevance","value":"[]","zIndex":0,...}|
{"type":"ATTR",...}||{...,"key":"Name","value":"VCC","zIndex":9,...}|
{"type":"ATTR",...}||{...,"key":"Global Net Name","value":"VCC","zIndex":11,...}|
```

### Port block

Net ports are the third member of the special-device family (no `PORT` record type exists). The staged SYMBOL doc uses **META `docType: 19`** (NetPort; power uses 18) with title `Port-<NET>`, tags `["特殊器件","网络标识"]`, a PIN at `(0,0)` rotation 0 length 5 and a RECT body `(5,-7)-(25,7)`. On the page it is an ordinary power-style block:

```jsonc
{"type":"COMPONENT",...}||{"partId":"pid8a0e77bacb214e","x":460,"y":-440,"rotation":0,"isMirror":false,"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":null,"FootprintName":null},"zIndex":96}|
{"type":"ATTR",...}||{...,"key":"Symbol","value":"<port-symbol-uuid>","zIndex":1,...}|
{"type":"ATTR",...}||{...,"key":"Device","value":"<port-device-uuid>","zIndex":12,...}|
{"type":"ATTR",...}||{...,"key":"Relevance","value":"[]","zIndex":0,...}|
{"type":"ATTR",...}||{...,"key":"Name","value":"SIG","x":475,"y":-440,"align":"CENTER_MIDDLE","zIndex":9,...}|
{"type":"ATTR",...}||{...,"key":"Global Net Name","value":"SIG","x":475,"y":-440,"align":"CENTER_MIDDLE","zIndex":11,...}|
```

### Page TEXT & graphics

Free TEXT and non-electrical graphics. The official example carries these records only inside SYMBOL docs (with `partId`); page-level copies omit `partId` and use positive display-order zIndexes:

```jsonc
{"type":"TEXT","ticket":109,"id":"..."}||{"x":300,"y":-300,"rotation":0,"color":null,"fontFamily":null,"fontSize":10,"fontWeight":null,"italic":null,"underline":null,"align":null,"value":"5V rail","fillColor":null,"zIndex":97,"groupId":"","locked":false}|   // groupId/locked per the format skill's SCH_PAGE TEXT sample
{"type":"RECT","ticket":110,"id":"..."}||{"groupId":"","locked":false,"zIndex":98,"dotX1":200,"dotY1":-200,"dotX2":400,"dotY2":-300,"radiusX":0,"radiusY":0,"rotation":0,"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|
{"type":"POLY","ticket":111,"id":"..."}||{"groupId":"","locked":false,"zIndex":99,"points":[{"x":200,"y":-200},{"x":300,"y":-100},{"x":400,"y":-200}],"closed":true,"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|
{"type":"CIRCLE","ticket":112,"id":"..."}||{"groupId":"","locked":false,"zIndex":100,"centerX":300,"centerY":-250,"radius":50,"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|
{"type":"ELLIPSE","ticket":113,"id":"..."}||{"groupId":"","locked":false,"zIndex":101,"centerX":300,"centerY":-250,"radiusX":80,"radiusY":40,"rotation":0,"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|
{"type":"ARC","ticket":114,"id":"..."}||{"groupId":"","locked":false,"zIndex":102,"startX":200,"startY":-200,"referX":300,"referY":-300,"endX":400,"endY":-200,"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|
{"type":"BEZIER","ticket":115,"id":"..."}||{"groupId":"","locked":false,"zIndex":103,"controls":[200,-200,250,-100,350,-100,400,-200],"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|
```

- Real-record sources: TEXT/RECT/ARC/POLY shapes are quoted from the example's symbol docs (string enums, point objects); CIRCLE/ELLIPSE/BEZIER follow the format docs with the example's string-enum conventions (`strokeStyle:"SOLID"`, `fillStyle:"NONE"`, numeric `strokeWidth`).
- ARC is the 3-point form: start, a point the arc passes through (`referX/referY`), end.
- These records are annotations — no net connectivity.

### Wire block

```jsonc
{"type":"WIRE","ticket":132,"id":"6ac533e76661a882"}||{"zIndex":99}|
{"type":"LINE","ticket":133,"id":"37cdb87aa09a450c"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":300,"startY":-500,"endX":300,"endY":-460,"lineGroup":"6ac533e76661a882"}|
{"type":"ATTR","ticket":135,"id":"0d177a161602f2b4"}|||                                                        // empty stub record (present in the example)
{"type":"ATTR",...}||{...,"key":"Relevance","value":"[]","zIndex":6,...}|
{"type":"ATTR",...}||{...,"key":"NET","value":"SIG","keyVisible":false,"valueVisible":true,"parentId":"6ac533e76661a882","zIndex":7,...}|
```

One `WIRE` + one `LINE` per segment; `LINE.lineGroup` → `WIRE.id`. A named wire carries a NET attr; client-generated unnamed wires omit the NET attr entirely (a labeled wire = the NET attr with a value plus label position/rotation on the same record). Every record head (`WIRE`/`LINE`/`ATTR`/`COMPONENT`) carries an id; ATTR records link to their owner through `parentId`.

## Library documents

### SYMBOL doc (regular, `docType: 2`)

```
DOCHEAD(SYMBOL) → META(title,description,tags,docType:2,source) → CANVAS → PART{BBOX:[-10,-h/2,10,h/2]}
→ RECT(body outline, strokeStyle SOLID, fillStyle NONE) → PIN + its 3 pin ATTRs (per pin) → Name attr → Designator attr
```

```jsonc
{"type":"PIN","ticket":5,"id":"e1"}||{"partId":"pid<16hex>","dotX":20,"dotY":0,"rotation":180,"length":10,"display":true,...}|
{"type":"ATTR",...}||{...,"parentId":"e1","key":"Pin Name","value":"A","align":"RIGHT_BOTTOM","fontSize":9.72222,...}|
{"type":"ATTR",...}||{...,"parentId":"e1","key":"Pin Number","value":"1","align":"LEFT_BOTTOM","fontSize":9.72222,...}|
{"type":"ATTR",...}||{...,"parentId":"e1","key":"Pin Type","value":"","fontSize":6.75,...}|
```

Pin attr alignment flips with pin rotation (rot 0: name LEFT_BOTTOM / num RIGHT_BOTTOM; rot 180: name RIGHT_BOTTOM / num LEFT_BOTTOM). The page-level component block copies the doc's `Name`/`Designator` attr zIndexes (+1 for the Symbol attr).

### SYMBOL doc (power)

Power symbols use `docType: 8`-style power META (`["Power","VCC"]` naming, tags `["特殊器件","网络标识"]`), graphic POLY/LINE primitives only (no PART pins).

### DEVICE doc

```
DOCHEAD(DEVICE) → META{title, description, tags, attributes:{Designator:"R?", Name, ...}, source} → ...
```

The META `attributes.Designator` holds the designator prefix pattern (`"R?"`). **Power device META has no `Designator` key** and carries `attributes["Global Net Name"]`; power devices are tagged `["特殊器件","网络标识"]` with titles like `Power-VCC` / `Ground-GND`.

### FOOTPRINT doc

```
DOCHEAD(FOOTPRINT) → META → CANVAS{unit:"mm"} → Pads + graphics → Designator/Footprint attrs
```

```jsonc
{"type":"PAD","ticket":25,"id":"e2"}||{"groupId":0,"netName":"","layerId":1,"num":"1","centerX":-16.54,"centerY":0,"padAngle":0,"hole":null,"defaultPad":{"padType":"RECT","width":31.5,"height":35.43,"radius":0},"specialPad":[],"padOffsetX":0,"padOffsetY":0,"relativeAngle":90,"plated":true,...}|
{"type":"PAD","ticket":26,"id":"e5"}||{"groupId":0,"netName":"GND","layerId":12,"num":"1","centerX":499.2387,"centerY":348.6491,"padAngle":0,"hole":{"holeType":"ROUND","width":36,"height":36,"cornerRadius":11.811},"defaultPad":{"padType":"ELLIPSE","width":60,"height":60},"specialPad":[],"padOffsetX":0,"padOffsetY":0,...}|  // through-hole, official example
{"type":"POLY","ticket":23,"id":"..."}||{...,"layerId":48,"width":2,"path":[-27.56,-19.69,"L",27.56,-19.69,27.56,19.69,-27.56,19.69,-27.56,-19.69],...}| // courtyard/body outline, polyline corners
{"type":"POLY","ticket":24,"id":"..."}||{...,"layerId":3,"width":6,"path":[-27.56,-19.69,"L",27.56,-19.69,27.56,19.69,-27.56,19.69,-27.56,-19.69],...}| // silk, polyline form
```

- Polyline paths are `[x0, y0, "L", x1, y1, x2, y2, ...]` (one leading `"L"`, then coordinate pairs). Rect shapes use `["R", x, y, w, h, rx, ry]` — **the anchor `(x, y)` is the min-x / max-y corner and `h` extends toward −y**: the rect covers `x ∈ [x, x+w]`, `y ∈ [y−h, y]`. Verified against the official example (board outline `["R",0,940,1475,940,0,0]` covering `[0,1475]×[0,940]`) and a real-client project. Real footprint docs describe outlines as polylines only — never as rect paths.
- **All footprint coordinates are mil even though the CANVAS says `unit:"mm"`** (the official example does the same).
- Layers: 1 top copper, 3 top silk, 11 board outline, 12 multi (through-hole pads), 48 component body/courtyard.
- PAD `hole` is `null` for SMD, otherwise a `THoleDef` object `{holeType, width, height[, cornerRadius]}` with `holeType` ∈ `ROUND | RECT | SLOT | ROUND_RECT` (only `ROUND` appears in real samples; mil). A holed pad sits on layer 12 with an `ELLIPSE` `defaultPad`.
- The PCB component block reuses the footprint doc's `Footprint`/`Designator` attr ids and zIndexes.

## PCB container (`pcb/<pcb>.epcb2`)

Document order: `SYMBOL FOOTPRINT DEVICE` per placed footprint, then the **PCB main doc**:

```
META → LAYER records (1=Top, 2=Bottom, …) → empty NET → named NETs → BOARD_OUTLINE POLY →
per-component blocks (COMPONENT + PAD_NETs + Designator/Footprint/… attrs) → tracks/graphics
```

```jsonc
{"type":"LAYER","ticket":39,"id":"[\"LAYER\",1]"}||{"layerId":1,"layerType":"TOP","layerName":"Top Layer","use":true,"show":true,"locked":false,"activeColor":"#ff0000","activateTransparency":1,"inactiveColor":"#7f0000","inactiveTransparency":1}|
{"type":"NET","ticket":152,"id":"[\"NET\",\"\"]"}||{}|                                          // the empty NET is mandatory
{"type":"NET","ticket":153,"id":"[\"NET\",\"VCC\"]"}||{"netType":null,"specialColor":null,"retLine":true,"differentialName":null,"isPositiveNet":false,"equalLengthGroupName":null}|
{"type":"POLY","ticket":157,"id":"06bf6d5071462681"}||{"partitionId":"","groupId":0,"netName":"","layerId":11,"width":10,"path":["R",0,3000,4000,3000,0,0],"locked":false,"zIndex":-1,"polyType":"BOARD_OUTLINE"}|   // board 0..4000 × 0..3000 (rect anchor = min-x/max-y corner)
{"type":"COMPONENT","ticket":160,"id":"a0ee7cd54d8e3d86"}||{"partitionId":"","groupId":0,"layerId":1,"x":300,"y":300,"angle":90,"attrs":{"Reuse Block":"","Group ID":"","Channel ID":"","Unique ID":"gge1","DeviceName":"{\"name\":\"R0402\",\"source\":\"\",\"uuid\":\"b02c92de66f189fd\"}"},"locked":false,"zIndex":-1,"pinSwap":false,"pinSwapInfo":{"a0ee7cd54d8e3d86e2":{"pinClass":"","differentialPairClass":""}},"footprintPrimitives":true}|
{"type":"PAD_NET","ticket":158,"id":"[\"PAD_NET\",\"a0ee7cd54d8e3d86\",\"1\",\"e2\"]"}||{"partitionId":"","padNet":"VCC","padLen":null,"propagationDelay":null,"attrsMap":{}}|
{"type":"LINE","ticket":171,"id":"5d3cbdb8d4b54f4b"}||{"partitionId":"","groupId":0,"netName":"SIG","layerId":1,"startX":300,"startY":316.54,"endX":450,"endY":316.54,"width":10,"locked":false,"zIndex":-1}|   // copper track
```

### PCB graphics, STRING, VIA, POUR, FILL, REGION

The example PCB main doc has only LINE/POLY/POUR/COMPONENT/NET/LAYER (its FILL records live in footprint docs); STRING/VIA/ARC/REGION follow the real samples in the easyeda-pro-format-skill repo (`examples/PCB`), merged with the official example's `partitionId:""` / `groupId:0` / `locked:false` / `zIndex:-1` conventions. The real POUR record quoted below is authoritative. Where the format skill's JSON Schemas disagree with these samples (numeric `groupId`, `bold/italic: 0`, omitted `propagationDelay`, array `prohibitType`, `pourType` object), the samples win — see `scripts/tools/audit-format.js` for the full list.

```jsonc
{"type":"POLY","ticket":172,"id":"..."}||{"partitionId":"","groupId":0,"netName":"","layerId":1,"width":2,"path":["R",500,800,400,300,0,0],"locked":false,"zIndex":-1,"polyType":"NORMAL"}|              // rect graphic covering 500..900 × 500..800
{"type":"POLY","ticket":173,"id":"..."}||{"partitionId":"","groupId":0,"netName":"","layerId":1,"width":2,"path":["CIRCLE",700,650,100,1],"locked":false,"zIndex":-1,"polyType":"NORMAL"}|               // circle graphic
{"type":"ARC","ticket":174,"id":"..."}||{"partitionId":"","groupId":0,"layerId":1,"netName":"","startX":500,"startY":500,"endX":900,"endY":500,"angle":90,"width":10,"arcType":"DOT","locked":false,"zIndex":-1}|   // two-point arc, CCW positive; arcType DOT|CENT
{"type":"STRING","ticket":175,"id":"..."}||{"partitionId":"","groupId":0,"layerId":3,"x":2000,"y":2800,"text":"REV A","fontFamily":"default","fontSize":60,"strokeWidth":6,"bold":0,"italic":0,"origin":"CENTER_MIDDLE","angle":0,"reverse":false,"expansion":0,"mirror":false,"locked":false,"zIndex":-1}|   // origin = EAlign string (LEFT_BOTTOM … RIGHT_TOP); mirror true on bottom
{"type":"VIA","ticket":176,"id":"..."}||{"partitionId":"","groupId":0,"netName":"SIG","ruleName":"viaSize","centerX":700,"centerY":316.54,"holeDiameter":12.0078,"viaDiameter":24.0158,"viaType":"NORMAL","topSolderExpansion":null,"bottomSolderExpansion":null,"unusedInnerLayers":[],"locked":false,"zIndex":-1}|   // viaType NORMAL|BLIND|SUTURE; defaults = example PREFERENCE; propagationDelay omitted as in the sample
{"type":"POUR","ticket":177,"id":"..."}||{"partitionId":"","groupId":0,"netName":"GND","layerId":1,"width":0.2,"name":"POUR1","order":0,"path":[["R",100,2900,3800,2800,0,0]],"pourType":{"pourType":"SOLID","fineness":8},"keepIsland":false,"locked":false,"zIndex":-1}|  // real record, area 100..3900 × 100..2900
{"type":"FILL","ticket":178,"id":"..."}||{"partitionId":"","groupId":0,"netName":"GND","layerId":1,"width":0.2,"fillStyle":"SOLID","path":[["R",100,400,400,300,0,0]],"locked":false,"zIndex":-1,"isBridgingCopper":false,"networkList":[],"refs":[]}|   // body mirrors the real footprint-doc FILL records, main-doc conventions
{"type":"REGION","ticket":179,"id":"..."}||{"partitionId":"","groupId":0,"layerId":1,"width":1,"prohibitType":["COPPER","TRACK"],"path":[["R",200,400,300,200,0,0]],"locked":false,"zIndex":-1,"regionType":"PROHIBIT","name":"KEEP1"}|   // regionType PROHIBIT|CONSTRAINT
```

- FILL field order follows the real footprint-doc records (`groupId,netName,layerId,width,fillStyle,path,locked,zIndex,isBridgingCopper,networkList,refs`) with the main-doc `partitionId:""` prepended. Only `fillStyle:"SOLID"` is sample-backed — grid/inner-plane modes and POUR's line/grid `pourType` variants have no verifiable sample and are rejected by the scripts.
- REGION `prohibitType` is an array of string enums: `COMPONENT` `VIA` `TRACK` `FILL` `COPPER` `PLANE`. `name` is optional and only written when provided.
- The legacy PROP record no longer exists in the format; per-primitive styling such as `specialColor` now lives on the ATTR record.

- PCB path arrays use the docs encoding: `[x0,y0,"L",...]` polyline, `["R",x,y,w,h,rot,isCCW,round]` rect (anchor = min-x/max-y corner, covers `y ∈ [y−h, y]`), `["CIRCLE",cx,cy,r,isCCW]`, `"ARC"angle` / `"C"` bezier segments; complex pour outlines are arrays of simple polygons (first CW outer, rest CCW holes). The skill's scripts take bottom-left corner + size and emit the anchored rect form for you (`E.rectPath`).
- POUR is the region record only — the client recomputes the filled copper (POURED records) on open. `width: 0.2` and `pourType {pourType:"SOLID",fineness:8}` are quoted from the real example.
- The pour/via `netName` must name an existing NET record (`ensurePcbNets` inserts one before renumbering).

Invariants:

- `PAD_NET.id = ["PAD_NET", <componentId>, <padNum>, <padElemId>]` where `padElemId` is the PAD record id inside the embedded FOOTPRINT doc. `padNet` must name an existing NET record.
- Named NET records sit **after the empty NET and before the first PAD_NET**; inserting one mid-file renumbers the main doc's tickets to stay increasing in file order.
- PCB `COMPONENT.body.angle` (not `rotation`); `zIndex: -1`; the component id doubles as the prefix of its pad element ids in `pinSwapInfo`.
- `Unique ID` attrs use the `gge<N>` convention, counting across the whole main doc.

## Gotchas (卡点经验) — swept from easyeda-pro-format-skill

Field-level traps collected from the companion repo's `primitives/*.md` field tables, `documents/*.md` and `validate.js`. Where the companion docs and real client records disagree, the real records win (noted inline).

### Envelope & record heads

- Every line ends with a `|` separator **except the last line of the file**. `DOCHEAD` is the only head without `ticket`/`id`.
- `DOCHEAD.client` / `uuid` must be **16-char lowercase hex**; `version` normally equals `updateTime` (ms). Within one project the `client` id should stay consistent.
- Record order: `DOCHEAD` → `CANVAS` → everything else; tickets increase in generation order (CANVAS fixed `ticket:1, id:"CANVAS"`, others start at 2 — scope is per document).
- `CANVAS` exists **only** for SCH_PAGE / SYMBOL / SIMULATION / PCB / FOOTPRINT / PANEL / PANEL_LIB docs. DEVICE / SCH / SIMULATION_SCH / CONFIG / BOARD / FONT / BLOB docs have **no CANVAS line** — don't emit one.
- Three incompatible CANVAS flavors: schematic `{originX, originY}` (+ optional `yAxisDirection`), PCB/FOOTPRINT full grid block, PANEL material/thickness/print/coverColor fields. They are not interchangeable.
- Singleton-atom ids are not random hex: META/CANVAS use the type name as id, **NET uses the net name as id**, FONT's id is the whole font-parameter array (`["C1","仿宋",4.5,10,0,0,0,0]`), POURED's id is `["POURED","<id>"]`.
- TABLE cells are **embedded structures, not standalone records** — never emit a line per cell.

### Schema resolution (companion validator)

- The same primitive name means different things per doc type (SCH_PAGE `LINE` = wire segment with `lineGroup`; PCB `LINE` = copper track with `netName/layerId/width`). The companion `validate.js` resolves bare names by priority `SCH_PAGE > SCH > SYMBOL > PCB > …` — unreliable across doc families. Use `<DOCTYPE>_<NAME>` prefixes (`PCB_LINE`) or `--doc`.
- `--doc X` silently falls back to bare-name resolution with only a warning when the type isn't registered under X; some doc types have empty schemas (validation = pass-through). A validator `valid: true` is necessary, not sufficient.

### Units, coordinates, layers

- `CANVAS.unit` is **display-only — it never re-scales the data**. This is the documented reason footprint coords stay mil even with `unit:"mm"`.
- `yAxisDirection` (`TYAxisDirection`: `up`/`down`) is the local-format Y-axis **marker**, not the axis itself: per `schemas/ty-axis-direction.json`, a missing field means `down` (cloud/editor-internal space), and writing a local file pairs the marker with a whole-coordinate Y flip (`addUpAndFlipY` / `stripUpAndFlipY` — the business layer never sees the field). Every SCH_PAGE/SYMBOL primitive and its CANVAS may carry it, **but the official example emits it zero times** while storing flipped (Y-up) coordinates (component at `y:-545`) — so the axis shows up in the data as negative-y-below-origin, not as a field. Our writers omit the marker and write Y-up coordinates directly, like the real client.
- Layer limits: ≤32 inner layers, ≤30 custom layers, ≤31 substrate layers. `LAYER.layerName` must be **unique**; colors must match `^#[0-9A-Fa-f]{6}$` or be empty.

### Path encodings (POLY / POUR / BOARD / REGION / FILL / FONT)

- `"R"` rect segments: the companion docs have **no chapter on the anchor geometry** — the 5th/6th params are always `0,0` in every sample and their meaning is undocumented. The min-x/max-y anchor rule documented above comes from real records only; trust those, not any schema.
- `"L"` polylines repeat the start point at the beginning and close **explicitly** back to the start (`[x0,y0,"L",x1,y1,…,x0,y0]`).
- Arc segments are `"ARC"<angle>` (CCW positive), bezier `"C"`; circles `["CIRCLE",cx,cy,r(,isCCW)]`.
- `path` is **nested `any[][]`** (multi-ring: outer CW, holes CCW) for BOARD / POUR / REGION / FPC_FILL / FONT. The companion doc types FILL's path as a flat single-polygon `any[]` ("组合模式画的才有多个"), but the real FILL example still wraps one polygon in an array (`[["CIRCLE",…]]`) — **always emit the nested form**, even for a single ring.

### Schematic side

- `groupId` when ungrouped: schematic primitives use the **empty string `""`** (`wire.md`: "没有则为空"); the companion PCB docs say `"0"`, but real client PCB records use numeric `0` — emit numeric 0, parse both.
- `LINE.lineGroup` must match `^[0-9a-f]{16}$`. For BUS members, every LINE's `lineGroup` **and** the NET attr's `parentId` all point at the BUS record's id.
- `fillColor:""` means no fill; when filled, LINE/POLY shapes **auto-close** start→end regardless of `closed`.
- Rotation pivots differ per type and are easy to get wrong: RECT rotates around **corner 1** (`dotX1/dotY1`), TEXT around its text anchor, COMPONENT around its position, BUSENTRY around its endpoint.
- PIN `rotation` is documented 0–360 but real usage is only **0/90/180/270**; `pinShape` ∈ NONE/CLOCK/INVERTED/INVERTED_CLOCK.
- ATTR `x`/`y` stay **null until the attr has ever been displayed**; `partId` is a SYMBOL-doc-only field. `fontWeight`/`italic` are documented `boolean|null`, but real client records show `0`/`1` — write booleans, tolerate numbers when parsing.
- BUSENTRY `order` (position within its BUS) **may repeat** — it is not a unique index.
- A schematic COMPONENT **must** carry a `Symbol` attr whose value is the embedded SYMBOL doc uuid; `DeviceName`/`Devices`/`Footprints` attrs are JSON.stringify'd strings (v4 shape).

### PCB side

- **`null` means "follow the design rule"**, not "none": VIA/PAD `topSolderExpansion`/`bottomSolderExpansion`/`connectMode`/`spokeSpace`/`spokeWidth`/`spokeAngle`/the four expansions. Writing `0` instead of `null` silently overrides the rule.
- SMD pad `hole`: the companion doc says null = no hole, but real samples write a **zero-size hole** `{"holeType":"ROUND","width":0,"height":0}`. Follow the sample.
- VIA requires **both** `holeDiameter` and `viaDiameter`; `ruleName` selects the via rule (start/end layers); `viaType` ∈ NORMAL/BLIND/SUTURE; `propagationDelay` is a v3.3-era field.
- PCB COMPONENT fixed attrs include `3D Model` / `3D Model Transform`; `footprintPrimitives` (v3.3+, default true) and `pinSwap`/`pinSwapInfo` (v3.4+, default false) are newer than many samples — keep them defaulted.
- STRING `mirror` must flip to true when the text sits on the bottom layer (layer/text coupling the schema does not enforce); `angle` min 0; `expansion` may be negative.
- REGION `prohibitType` old format: numeric codes 1–8 (1 route+place-fill … 8 inner plane) — the client still parses them for backward compat; emit the string-array form only.
- NET null semantics: `netType:null` = untyped, `differentialName:null` = not a diff pair, `equalLengthGroupName:null` = not in an equal-length group.
- Deprecated in the format: the whole **SHELLCUT** record and `SHELL.strokeWidth`. **PROP does not exist anywhere** in the companion repo — confirms this skill's removal of it.

### Holes in the companion repo (why real samples stay the ground truth)

- **NetFlag (docType 18) / NetPort (docType 19) have no primitive docs, no schema, no example** in easyeda-pro-format-skill (grep confirms zero hits). Power symbols and net ports are authored purely from real-client samples — the rules in this doc's *Power symbol block* / *Port block* sections are the only spec that exists.
- The empty-NET placement rule (after `["NET",""]`, before the first PAD_NET) is likewise absent from the companion docs — derived from the official example.
- `examples/` in the companion repo carry no schema-vs-record annotations; each example is silently authoritative.

## Units & conventions

- Coordinates are **mil** (1 mm = 39.37 mil); Y grows upward. Rotation is degrees CCW.
- Document uuids and record ids are 16-hex strings; index owner/creator/modifier uuids are 32-hex.
- `version` / `updateTime` are millisecond timestamps (also duplicated as string `version` in the index profile).
- `editVersion` is `"2.3.0"`; the fixed part id for schematic components is `pid8a0e77bacb214e`.
- `source` fields look like `<32hex>|<owner-uuid>`.

## Validation

`scripts/validate.js` checks all of the above mechanically: index shape, `.ecfg`/`.evar` presence, per-doc uuid uniqueness, per-doc ticket uniqueness, `Device`/`Symbol`/`Footprint` attr → embedded doc resolution, `LINE.lineGroup` → `WIRE`, empty NET + BOARD_OUTLINE presence, `PAD_NET` → `COMPONENT`/`NET` references, POUR/VIA/FILL → NET references, and the panel file(s) when `profile.panels` is non-empty (panels are optional). Exit code 0 = clean, 1 = errors printed.
