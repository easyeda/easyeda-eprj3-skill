# EasyEDA Pro Folder-Based Project Format (`.eprj3`)

This document introduces the folder-based project format for **EasyEDA Pro** (嘉立创EDA专业版), designed for users and AI tools who need to read, edit, or version-control electronic design projects.

## What is `.eprj3`?

`.eprj3` is the new folder-based project format for EasyEDA Pro. Unlike the legacy `eprj`/`.eprj2` format, which stores an entire project inside a single SQLite database file, `.eprj3` splits the project into a directory of plain-text and JSON files.

This makes the project:

- **Git-friendly** — you can track changes with version control and review diffs.
- **Tool-friendly** — text editors, scripts, and AI coding assistants can read and modify files directly.
- **Transparent** — project structure and data are visible and understandable.

### Format Comparison

| Feature          | Legacy `eprj`/`.eprj2`     | New `.eprj3`          |
| ---------------- | ------------------- | --------------------- |
| Form             | Single file         | Folder + files       |
| Data format      | SQLite database     | JSON + plain text    |
| Version control  | Difficult           | Easy / Git-friendly  |
| Direct access    | No                  | Yes                  |

## Project Folder Layout

A typical `.eprj3` project looks like this:

```
MyProject/                                  # Project root
├── MyProject.eprj3                         # Project metadata and index
├── sch/                                    # Schematics
│   └── <schematic title>/                  # A single schematic
│       ├── <sheet title>.esch2             # Schematic sheet source
│       ├── <schematic title>.ecfg         # Design rules for this schematic
│       └── <schematic title>.evar         # Assembly variant data
├── pcb/                                    # PCBs
│   └── <pcb title>.epcb2                  # PCB source
└── panel/                                  # Panels
    └── <panel title>.epan2                 # Panel source
```

### What each part means

- **`MyProject.eprj3`** — the project index and metadata. It is the only file created when the project is first created.
- **`sch/`** — contains all schematics. Each schematic lives in its own folder, with one or more `.esch2` sheet files.
- **`pcb/`** — contains all PCB designs as `.epcb2` files.
- **`panel/`** — contains panelization data as `.epan2` files.
- **`.ecfg` files** — store schematic-level design rules and configuration.
- **`.evar` files** — store assembly variant data.

## File Extensions

| Extension | File Type                                  |
| --------- | ------------------------------------------ |
| `.eprj3`  | Project index and metadata                 |
| `.esch2`  | Schematic sheet source                     |
| `.ecfg`   | Schematic / project configuration & rules  |
| `.evar`   | Assembly variant data                      |
| `.epcb2`  | PCB source                                 |
| `.epan2`  | Panel source                               |

## Data Records

Each source file (`.esch2`, `.epcb2`, `.epan2`) contains a sequence of JSON records. Every record is a JSON object, and the kind of object is determined by its `"type"` field. There are no special delimiter lines in the file.

### Common `type` Values

| `type`      | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `DOCHEAD`   | Document header, marks the start of a document       |
| `META`      | Metadata for the current document                    |
| `COMPONENT` | A placed component / part                            |
| `ATTR`      | An attribute of another object                         |
| `WIRE`      | A wire segment                                         |
| `NETLABEL`  | A net label                                            |
| `PORT`      | A port / connector                                     |
| `TEXT`      | Text object                                            |
| `OBJ`       | Generic graphical object                               |

### Example File Snippet

```
{"type":"DOCHEAD","ticket":534}||{"docType":"SCH_PAGE",...}|
{"type":"META","ticket":536,"id":"META"}||{"title":"CEM_GoldFinger",...}|
{"type":"COMPONENT","ticket":2,"id":"e1"}||{"locked":false,...}|
{"type":"ATTR","ticket":100,"id":"attr-1"}||{"key":"Footprint",...}|
{"type":"WIRE","ticket":1858,"id":"e3715"}||{"groupId":"",...}|
{"type":"DOCHEAD","ticket":10}||{"docType":"SYMBOL",...}|
```

> **Note:** The file is simply a sequence of JSON records, and each object's role is determined by the `"type"` field.

## Important Notes

- The project name is taken from the folder and the `.eprj3` file name.
- Schematic sheet, PCB, and panel names are determined by their file names.
- There is no separate project library. Devices, symbols, and footprints are stored as individual files inside the project.
- When importing a project, any loose library data that is not used by placed components is ignored.
- Images (BLOB) and fonts are not stored as standalone files; they travel with the document that references them.
- Thumbnails and project preview trees are not stored in this format.

## References

For the complete EasyEDA Pro file format specification, please visit:

- **GitHub Repository**: [easyeda/easyeda-pro-file-format](https://github.com/easyeda/easyeda-pro-file-format)
- **Online Documentation (English)**: [https://prodocs.easyeda.com/en/format/index/](https://prodocs.easyeda.com/en/format/index/)
- **Online Documentation (中文)**: [https://prodocs.lceda.cn/cn/format/index/](https://prodocs.lceda.cn/cn/format/index/)
