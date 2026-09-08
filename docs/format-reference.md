# eprj3 Format Reference

Compact reference for the records the scripts in this skill produce. The authoritative spec lives at https://github.com/easyeda/easyeda-pro-eprj3-format.

## Project layout

```
<projectName>/
├── <projectName>.eprj3            ← project index (JSON)
├── sch/
│   ├── <schematicName>/
│   │   ├── <sheetTitle>.esch2     ← schematic sheet source
│   │   ├── <schematicName>.ecfg   ← schematic rules (may be empty)
│   │   └── <schematicName>.evar   ← assembly variants (may be empty)
│   ├── __symbols__/               ← embedded symbol docs
│   └── __footprints__/            ← embedded footprint docs
├── pcb/
│   └── <pcbTitle>.epcb2           ← PCB source
└── panel/
    └── <panelTitle>.epan2         ← panel source
```

## File grammar

`.esch2`, `.epcb2`, `.epan2` files all follow the same line-oriented JSON-record grammar:

```
{head}||{body}|
{head}||{ticketAndId}||{body}|
```

Each line is one record. Blank lines are tolerated. Records are written in `append`-then-`patch` order, so the on-disk ordering is the same as the edit history.

| Field | Description |
| --- | --- |
| `head.type` | `DOCHEAD` / `META` / `COMPONENT` / `ATTR` / `WIRE` / `LINE` / `NETLABEL` / `PORT` / `TEXT` / `OBJ` / `RECT` / `ARC` / `POLY` / `PIN` / `PAD` / `FILL` / `LAYER` / `CANVAS` / `PART` / `NET` / `RULE` / `TABLE` … |
| `head.ticket` | Strictly increasing within a document. |
| `head.id` | Unique within a document. |
| `body` | Free-form schema per record type. |

## Common record templates

### Schematic sheet (`sch/<schematic>/<sheet>.esch2`)

```jsonc
{"type":"DOCHEAD"}||{"docType":"SCH","uuid":"<schematic-uuid>","version":"<ts>","editVersion":"2.3.0"}|
{"type":"META","ticket":1,"id":"META"}||{"title":"P1","source":"","board":"<board-uuid>","zIndex":null}|
{"type":"CANVAS","ticket":2,"id":"CANVAS"}||{"originX":0,"originY":0}|
{"type":"COMPONENT","ticket":3,"id":"<uuid>"}||{
  "partId":"pid<uuid>",
  "x":100,"y":100,"rotation":0,"isMirror":false,
  "attrs":{"DeviceName":"{\"uuid\":\"...\",\"name\":\"RES\"}","Symbols":"[]","pinClass":{},"differentialPairClass":{}},
  "zIndex":3
}|
{"type":"ATTR","ticket":4,"id":"<uuid>"}||{"parentId":"<component-id>","key":"Designator","value":"R1","valueVisible":true,"x":110,"y":90,"fontSize":10,"align":"LEFT_TOP"}|
{"type":"WIRE","ticket":5,"id":"<wire-id>"}||{"zIndex":5}|
{"type":"LINE","ticket":6,"id":"<uuid>"}||{"strokeColor":"#000000","strokeStyle":"SOLID","strokeWidth":1,"startX":0,"startY":0,"endX":50,"endY":0,"lineGroup":"<wire-id>"}|
{"type":"NETLABEL","ticket":7,"id":"<uuid>"}||{"x":0,"y":0,"value":"VCC","color":"#FF0000","fontSize":12,"align":"CENTER_MIDDLE"}|
```

A `WIRE` is a **group container**; the actual visible line segments are `LINE` records whose `bodyLineGroup` equals the `WIRE`'s id. The validator enforces this.

### Symbol document (`sch/__symbols__/<name>.esch2`)

```jsonc
{"type":"DOCHEAD"}||{"docType":"SYMBOL","uuid":"<symbol-uuid>","version":"<ts>","editVersion":"2.3.0"}|
{"type":"META","ticket":1,"id":"META"}||{"title":"RES","description":"","tags":[],"docType":2,"source":""}|
{"type":"CANVAS","ticket":2,"id":"CANVAS"}||{"originX":0,"originY":0}|
{"type":"PART","ticket":3,"id":"pid<uuid>"}||{"BBOX":[-30,-10,30,10],"title":"RES"}|
{"type":"RECT","ticket":4,"id":"<uuid>"}||{"partId":"pid<uuid>","dotX1":-30,"dotY1":-10,"dotX2":30,"dotY2":10,"strokeColor":"#000000","strokeStyle":"SOLID","strokeWidth":1,"fillStyle":"NONE"}|
{"type":"PIN","ticket":5,"id":"<uuid>"}||{"partId":"pid<uuid>","x":30,"y":0,"length":10,"rotation":180,"display":true,"pinShape":"NONE"}|
{"type":"ATTR","ticket":6,"id":"<uuid>"}||{"partId":"pid<uuid>","parentId":"<pin-id>","key":"Pin Number","value":"1","valueVisible":true,"align":"LEFT_BOTTOM","fontSize":9.72}|
```

### PCB document (`pcb/<name>.epcb2`)

```jsonc
{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"<pcb-uuid>","version":"<ts>","editVersion":"2.3.0"}|
{"type":"META","ticket":1,"id":"META"}||{"title":"PCB1","source":"","board":"<board-uuid>"}|
{"type":"LAYER","ticket":3,"id":"[\"LAYER\",1]"}||{"layerType":"TOP","layerName":"Top Layer","activeColor":"#FF0000","activateTransparency":1}|
{"type":"LAYER","ticket":4,"id":"[\"LAYER\",2]"}||{"layerType":"BOTTOM","layerName":"Bottom Layer","activeColor":"#0000FF","activateTransparency":1}|
{"type":"COMPONENT","ticket":5,"id":"<uuid>"}||{"partId":"pid<uuid>","x":0,"y":0,"rotation":0,"isMirror":false,"attrs":{"DeviceName":"{\"uuid\":\"...\",\"name\":\"0603\"}"}}|
{"type":"ATTR","ticket":6,"id":"<uuid>"}||{"parentId":"<component-id>","key":"Designator","value":"R1","x":10,"y":-10,"fontSize":10,"valueVisible":true}|
{"type":"PAD","ticket":7,"id":"<uuid>"}||{"groupId":0,"netName":"","layerId":1,"num":"1","centerX":-31.5,"centerY":0,"defaultPad":{"padType":"RECT","width":24,"height":16},"plated":true,"padType":"NORMAL","zIndex":7}|
```

### Project index (`<name>.eprj3`)

Single JSON object. Key fields:

```jsonc
{
  "name":"<projectName>",
  "owner_uuid":"<16 hex>",
  "creator_uuid":"<16 hex>",
  "created_at":"YYYY-MM-DD HH:MM:SS",
  "updated_at":"YYYY-MM-DD HH:MM:SS",
  "modifier_uuid":"<16 hex>",
  "format":"folder",
  "pcb_count":1,
  "profile":{
    "boards":{"<uuid>":{"uuid":"<uuid>","title":"Board1","zIndex":1}},
    "schematics":{"<uuid>":{"uuid":"<uuid>","name":"Schematic1","board":"<board-uuid>"}},
    "sheets":{"<uuid>":{"uuid":"<uuid>","title":"P1","schematic_uuid":"<sch-uuid>","zIndex":1}},
    "pcbs":{"<uuid>":{"uuid":"<uuid>","title":"PCB1","board":"<board-uuid>"}},
    "panels":{}, "blockSymbols":{}, "simSchematics":{}, "simulations":{},
    "owner":{"uuid":"<owner-uuid>"}
  }
}
```

## Units

- 1 mm = 40 mil. eprj3 stores positions in **mil**, so to convert from mm multiply by 40.
- Rotation is in degrees, counter-clockwise.
- Coordinates grow up-and-right (Y axis points up) — that is the same convention KiCad uses after the `mm → mil` conversion.

## Conversion tips

- KiCad wire `pts` → eprj3 `WIRE` + multiple `LINE` records sharing the same `lineGroup` id.
- KiCad `pad` → eprj3 `PAD` with `layerId` mapped: `F.Cu=1`, `B.Cu=2`, `F.SilkS=3`, `B.SilkS=4`.
- KiCad `segment` (PCB track) → eprj3 `FILL` with a closed polygon (use the 2 endpoints twice to make a degenerate rect).
- KiCad `symbol` (with `property` children) → eprj3 `COMPONENT` + `ATTR` records for the `Reference`, `Value`, `Footprint` properties.