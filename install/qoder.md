# Install for Qoder

Qoder reads rule markdown from `.qoder/rules/`. Rule files become part of the system prompt, so we install a one-line pointer rule that redirects Qoder to the full skill:

```bash
mkdir -p .qoder/rules
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .qoder/rules/easyeda-eprj3.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## Verifying

Confirm `easyeda-eprj3` is listed in Qoder's rules, then ask:

> Use the easyeda-eprj3 rule to author a board at `~/myboard`.
