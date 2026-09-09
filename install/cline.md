# Install for Cline (VS Code)

Cline reads instructions from `.clinerules/` (a plain-text folder of `.md` rules) and `.clinerules.md`. Rule files become part of the system prompt, so we install a pointer rule that redirects Cline to the full skill.

## Project-local

```bash
mkdir -p .clinerules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .clinerules/easyeda-eprj3.md <<'EOF'
# EasyEDA Pro eprj3 Skill

Apply this skill whenever the user asks to:
- Create or edit an EasyEDA Pro (.eprj3) project
- Generate symbols, footprints, or devices and place them on a sheet or PCB
- Validate the format of an existing .eprj3 directory

For the full workflow read `skills/easyeda-eprj3/SKILL.md` and follow it.
Helper scripts live in `skills/easyeda-eprj3/scripts/`.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## User-wide

In VS Code: **Settings → Cline → Custom Instructions** → paste the pointer line instead of the whole skill:

```markdown
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
```

The repo clone is project-local (`skills/easyeda-eprj3`), so run the `git clone` above once per project.

## Verifying

In the Cline panel, ask:

> Create an EasyEDA Pro project named `myboard` at `~/projects/myboard` with a 1k resistor.
