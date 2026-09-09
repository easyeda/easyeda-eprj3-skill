# eprj3 Format Reference

Compact reference for the records the scripts in this skill produce — verified against the official example at https://github.com/easyeda/easyeda-pro-eprj3-format (its `example/eprj3-example` project is the ground truth). Every JSON snippet below is quoted from a real record.

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
├── panel/
│   └── Panel1.epan2                     ← panel container
└── library/                             ← staged entries written by this skill's
                                            generate-*/load-library scripts. Tooling
                                            metadata only — the client does not read it.
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
{"type":"TEXT","ticket":109,"id":"..."}||{"x":300,"y":-300,"rotation":0,"color":null,"fontFamily":null,"fontSize":10,"fontWeight":null,"italic":null,"underline":null,"align":null,"value":"5V rail","fillColor":null,"zIndex":97}|
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
{"type":"ATTR","ticket":135}|||                                                                 // empty stub record (present in the example)
{"type":"ATTR",...}||{...,"key":"Relevance","value":"[]","zIndex":6,...}|
{"type":"ATTR",...}||{...,"key":"NET","value":"SIG","keyVisible":false,"valueVisible":true,"parentId":"6ac533e76661a882","zIndex":7,...}|
```

One `WIRE` + one `LINE` per segment; `LINE.lineGroup` → `WIRE.id`. Every wire carries a NET attr (value `""` when unnamed). A net label is just that NET attr with a value plus label position/rotation on the same record.

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
{"type":"POLY","ticket":23,"id":"..."}||{...,"layerId":48,"width":2,"path":["R",-27.56,-19.69,55.12,39.37,0,0],...}|       // courtyard/body outline, rect form
{"type":"POLY","ticket":24,"id":"..."}||{...,"layerId":3,"width":6,"path":[-27.56,-19.69,"L",27.56,-19.69,27.56,19.69,-27.56,19.69,-27.56,-19.69],...}| // silk, polyline form
```

- Polyline paths are `[x0, y0, "L", x1, y1, x2, y2, ...]` (one leading `"L"`, then coordinate pairs). Rect shapes use `["R", x, y, w, h, rx, ry]`.
- **All footprint coordinates are mil even though the CANVAS says `unit:"mm"`** (the official example does the same).
- Layers: 1 top copper, 3 top silk, 11 board outline, 48 component body/courtyard.
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
{"type":"POLY","ticket":157,"id":"06bf6d5071462681"}||{"partitionId":"","groupId":0,"netName":"","layerId":11,"width":10,"path":["R",0,0,4000,3000,0,0],"locked":false,"zIndex":-1,"polyType":"BOARD_OUTLINE"}|
{"type":"COMPONENT","ticket":160,"id":"a0ee7cd54d8e3d86"}||{"partitionId":"","groupId":0,"layerId":1,"x":300,"y":300,"angle":90,"attrs":{"Reuse Block":"","Group ID":"","Channel ID":"","Unique ID":"gge1","DeviceName":"{\"name\":\"R0402\",\"source\":\"\",\"uuid\":\"b02c92de66f189fd\"}"},"locked":false,"zIndex":-1,"pinSwap":false,"pinSwapInfo":{"a0ee7cd54d8e3d86e2":{"pinClass":"","differentialPairClass":""}},"footprintPrimitives":true}|
{"type":"PAD_NET","ticket":158,"id":"[\"PAD_NET\",\"a0ee7cd54d8e3d86\",\"1\",\"e2\"]"}||{"partitionId":"","padNet":"VCC","padLen":null,"propagationDelay":null,"attrsMap":{}}|
{"type":"LINE","ticket":171,"id":"5d3cbdb8d4b54f4b"}||{"partitionId":"","groupId":0,"netName":"SIG","layerId":1,"startX":300,"startY":316.54,"endX":450,"endY":316.54,"width":10,"locked":false,"zIndex":-1}|   // copper track
```

### PCB graphics, STRING, VIA, POUR, FILL, REGION, PROP

No real example samples exist for POLY/ARC/STRING/VIA/REGION/PROP (the example PCB main doc has only LINE/POLY/POUR/COMPONENT/NET/LAYER; its FILL records live in footprint docs) — shapes follow the format docs, with the real records' `partitionId:""` / `groupId:0` / `locked:false` / `zIndex:-1` conventions. The real POUR record quoted below is authoritative:

```jsonc
{"type":"POLY","ticket":172,"id":"..."}||{"partitionId":"","groupId":0,"netName":"","layerId":1,"width":2,"path":["R",500,500,400,300,0,0],"locked":false,"zIndex":-1,"polyType":"NORMAL"}|              // rect graphic
{"type":"POLY","ticket":173,"id":"..."}||{"partitionId":"","groupId":0,"netName":"","layerId":1,"width":2,"path":["CIRCLE",700,650,100,1],"locked":false,"zIndex":-1,"polyType":"NORMAL"}|               // circle graphic
{"type":"ARC","ticket":174,"id":"..."}||{"partitionId":"","groupId":0,"netName":"","layerId":1,"startX":500,"startY":500,"endX":900,"endY":500,"angle":90,"width":10,"locked":false,"zIndex":-1}|         // two-point arc, CCW positive
{"type":"STRING","ticket":175,"id":"..."}||{"partitionId":"","groupId":0,"locked":false,"zIndex":-1,"layerId":3,"positionX":2000,"positionY":2800,"text":"REV A","fontFamily":"default","fontSize":60,"strokeWidth":6,"bold":0,"italic":0,"origin":4,"angle":0,"reverse":0,"reverseExpansion":0,"mirror":0,"width":null,"height":null,"path":null}|   // origin 0-8 align; mirror 1 on bottom
{"type":"VIA","ticket":176,"id":"..."}||{"partitionId":"","groupId":0,"netName":"SIG","ruleName":"viaSize","centerX":700,"centerY":316.54,"holeDiameter":12.0078,"viaDiameter":24.0158,"viaType":0,"topSolderExpansion":null,"bottomSolderExpansion":null,"locked":false,"zIndex":-1}|   // defaults = example PREFERENCE
{"type":"POUR","ticket":177,"id":"..."}||{"partitionId":"","groupId":0,"netName":"GND","layerId":1,"width":0.2,"name":"POUR1","order":0,"path":[["R",100,100,3800,2800,0,0]],"pourType":{"pourType":"SOLID","fineness":8},"keepIsland":false,"locked":false,"zIndex":-1}|  // real record
{"type":"FILL","ticket":178,"id":"..."}||{"partitionId":"","groupId":0,"netName":"GND","layerId":1,"width":0.2,"fillStyle":"SOLID","path":[["R",100,100,400,300,0,0]],"locked":false,"zIndex":-1,"isBridgingCopper":false,"networkList":[],"refs":[]}|   // body mirrors the real footprint-doc FILL records, main-doc conventions
{"type":"REGION","ticket":179,"id":"..."}||{"partitionId":"","groupId":0,"locked":false,"zIndex":-1,"layerId":1,"width":1,"prohibitType":[2,5],"path":[["R",200,200,300,200,0,0]],"name":"KEEP1"}|   // docs shape; no real sample
{"type":"PROP","ticket":180,"id":"<target-record-id>"}||{"color":"#FF0000"}|   // docs shape; the PROP id IS the target element's id
```

- FILL field order follows the real footprint-doc records (`groupId,netName,layerId,width,fillStyle,path,locked,zIndex,isBridgingCopper,networkList,refs`) with the main-doc `partitionId:""` prepended. Only `fillStyle:"SOLID"` is sample-backed — grid/inner-plane modes and POUR's line/grid `pourType` variants have no verifiable sample and are rejected by the scripts.
- REGION `prohibitType` ids: 2 禁止元件, 3 禁止过孔, 5 禁止布线, 6 禁止放置填充区域, 7 禁止覆铜, 8 禁止内电层 (1/4 deprecated, rejected). `name` is optional and only written when provided.
- PROP head id = the target primitive's record id; the body currently documents only `{color}`.

- PCB path arrays use the docs encoding: `[x0,y0,"L",...]` polyline, `["R",x,y,w,h,rot,isCCW,round]` rect, `["CIRCLE",cx,cy,r,isCCW]`, `"ARC"angle` / `"C"` bezier segments; complex pour outlines are arrays of simple polygons (first CW outer, rest CCW holes).
- POUR is the region record only — the client recomputes the filled copper (POURED records) on open. `width: 0.2` and `pourType {pourType:"SOLID",fineness:8}` are quoted from the real example.
- The pour/via `netName` must name an existing NET record (`ensurePcbNets` inserts one before renumbering).

Invariants:

- `PAD_NET.id = ["PAD_NET", <componentId>, <padNum>, <padElemId>]` where `padElemId` is the PAD record id inside the embedded FOOTPRINT doc. `padNet` must name an existing NET record.
- Named NET records sit **after the empty NET and before the first PAD_NET**; inserting one mid-file renumbers the main doc's tickets to stay increasing in file order.
- PCB `COMPONENT.body.angle` (not `rotation`); `zIndex: -1`; the component id doubles as the prefix of its pad element ids in `pinSwapInfo`.
- `Unique ID` attrs use the `gge<N>` convention, counting across the whole main doc.

## Units & conventions

- Coordinates are **mil** (1 mm = 39.37 mil); Y grows upward. Rotation is degrees CCW.
- Document uuids and record ids are 16-hex strings; index owner/creator/modifier uuids are 32-hex.
- `version` / `updateTime` are millisecond timestamps (also duplicated as string `version` in the index profile).
- `editVersion` is `"2.3.0"`; the fixed part id for schematic components is `pid8a0e77bacb214e`.
- `source` fields look like `<32hex>|<owner-uuid>`.

## Validation

`scripts/validate.js` checks all of the above mechanically: index shape, `.ecfg`/`.evar` presence, per-doc uuid uniqueness, per-doc ticket uniqueness, `Device`/`Symbol`/`Footprint` attr → embedded doc resolution, `LINE.lineGroup` → `WIRE`, wire NET attrs, empty NET + BOARD_OUTLINE presence, `PAD_NET` → `COMPONENT`/`NET` references, POUR/VIA/FILL → NET references, and the panel file. Exit code 0 = clean, 1 = errors printed.
