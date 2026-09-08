# Install for Cline (VS Code)

Cline reads instructions from `.clinerules/` (a plain-text folder of `.md` rules) and `.clinerules.md`.

## Project-local

```bash
mkdir -p .clinerules
cp SKILL.md .clinerules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

Cline will auto-include any file in `.clinerules/` as a system rule. Add a header to `.clinerules/easyeda-eprj3.md` so Cline knows when to trigger it:

```markdown
# EasyEDA Pro eprj3 Skill

Apply this skill whenever the user asks to:
- Create or edit an EasyEDA Pro (.eprj3) project
- Convert a KiCad project to EasyEDA Pro
- Import a component from an .elibz2 library
- Validate the format of an existing .eprj3 directory

Helper scripts live in `./skills/easyeda-eprj3/scripts/`. See the full
`SKILL.md` (this file) for the workflow.
```

## User-wide

In VS Code: **Settings → Cline → Custom Instructions** → paste the contents of `SKILL.md`.

## Verifying

In the Cline panel, ask:

> Create an EasyEDA Pro project named `myboard` at `~/projects/myboard` with a 1k resistor.