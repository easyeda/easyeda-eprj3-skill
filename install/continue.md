# Install for Continue.dev

Continue reads rule files from `.continue/rules/` (project) or `~/.continue/rules/` (user). Rule files become part of the system prompt, so we install a one-line pointer rule that redirects the agent to the full skill.

## Project-local

```bash
mkdir -p .continue/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .continue/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

Optionally declare the rule in `.continue/config.json`:

```json
{
  "rules": [".continue/rules/easyeda-eprj3.md"]
}
```

## User-wide

```bash
mkdir -p ~/.continue/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.continue/skills/easyeda-eprj3
cat > ~/.continue/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `~/.continue/skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

## Verifying

In Continue's chat box, type `/rules` and confirm `easyeda-eprj3` is listed. Then ask:

> Run the easyeda-eprj3 skill on `~/projects/myboard`.
