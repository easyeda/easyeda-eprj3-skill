# Install for Trae (ByteDance)

Trae loads custom instructions from `.trae/rules/`. Rule files become part of the system prompt, so we install a one-line pointer rule that redirects Trae to the full skill:

```bash
mkdir -p .trae/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .trae/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## Verifying

In Trae's chat panel, ask:

> Use the easyeda-eprj3 rule to create a project at `~/myboard`.
