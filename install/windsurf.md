# Install for Windsurf (Codeium)

Windsurf reads memory files from `.windsurf/rules/*.md` (project) or `~/.windsurf/rules/*.md` (user). Rule files become part of the system prompt, so we install a one-line pointer rule that redirects Cascade to the full skill.

## Project-local

```bash
mkdir -p .windsurf/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .windsurf/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## User-wide

```bash
mkdir -p ~/.windsurf/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.windsurf/skills/easyeda-eprj3
cat > ~/.windsurf/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `~/.windsurf/skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

## Triggering

Windsurf auto-includes `.windsurf/rules/*.md` as a system prompt. Confirm `easyeda-eprj3` is listed in the rules, then ask Cascade:

> Author an EasyEDA Pro project at `~/myboard` with a 1k resistor and an LED.
