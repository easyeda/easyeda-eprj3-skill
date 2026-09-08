# Install for Cursor

Cursor ships custom instructions through `.cursor/rules/*.mdc` (project-local) or `~/.cursor/rules/*.mdc` (user-wide).

## Project-local (recommended)

```bash
mkdir -p .cursor/rules
cp SKILL.md .cursor/rules/easyeda-eprj3.mdc
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

Add a header to `.cursor/rules/easyeda-eprj3.mdc`:

```markdown
---
description: Author EasyEDA Pro .eprj3 PCB projects (skill lives at ./skills/easyeda-eprj3)
globs:
  - "*.eprj3"
  - "**/*.esch2"
  - "**/*.epcb2"
alwaysApply: false
---

# EasyEDA Pro eprj3 skill

For the full workflow read `./skills/easyeda-eprj3/SKILL.md`.
Helper scripts live in `./skills/easyeda-eprj3/scripts/`.
```

## User-wide

Copy the rule to `~/.cursor/rules/easyeda-eprj3.mdc` and clone the repo to `~/.local/share/cursor/skills/easyeda-eprj3`. Adjust the path inside the `.mdc` accordingly.

## Verifying

Open a `.esch2` file in Cursor and ask:

> Use the EasyEDA skill to add a 1k resistor.