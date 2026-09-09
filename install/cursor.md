# Install for Cursor

Cursor ships custom instructions through `.cursor/rules/*.mdc` (project-local) or `~/.cursor/rules/*.mdc` (user-wide). Rule files become part of the system prompt, so we install a pointer stub that redirects Cursor to the full skill.

## Project-local (recommended)

```bash
mkdir -p .cursor/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .cursor/rules/easyeda-eprj3.mdc <<'EOF'
---
description: Author EasyEDA Pro .eprj3 PCB projects (skill lives at ./skills/easyeda-eprj3)
globs:
  - "*.eprj3"
  - "**/*.esch2"
  - "**/*.epcb2"
alwaysApply: false
---

# EasyEDA Pro eprj3 skill

When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
Helper scripts live in `skills/easyeda-eprj3/scripts/`.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## User-wide

Clone the repo to `~/.local/share/cursor/skills/easyeda-eprj3` and write the same stub to `~/.cursor/rules/easyeda-eprj3.mdc`, adjusting the path inside the `.mdc` to `~/.local/share/cursor/skills/easyeda-eprj3/SKILL.md`.

## Verifying

Open a `.esch2` file in Cursor, confirm `easyeda-eprj3` is listed in the rules, and ask:

> Use the EasyEDA skill to add a 1k resistor.
