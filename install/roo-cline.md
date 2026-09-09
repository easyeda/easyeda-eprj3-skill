# Install for Roo Code / Roo-Cline

Roo reads rules from `.roo/rules/` and modes from `.roo/modes/`. Rule files become part of the system prompt, so we install a one-line pointer rule that redirects Roo to the full skill.

## Project-local

```bash
mkdir -p .roo/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .roo/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## User-wide (recommended for frequent use)

```bash
mkdir -p ~/.roo/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.roo/skills/easyeda-eprj3
cat > ~/.roo/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `~/.roo/skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

## Triggering

Roo auto-applies `.roo/rules/*.md` to the matching context. You can also invoke explicitly:

> Use the easyeda-eprj3 skill: create a project named `myboard` at `~/myboard` with a 1k resistor and an LED.

## Verifying

Open the Roo panel and confirm the rule `easyeda-eprj3` is listed. Then ask:

> Read `skills/easyeda-eprj3/SKILL.md` and list the workflow steps.
