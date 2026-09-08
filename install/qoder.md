# Install for Qoder

Qoder reads rule markdown from `.qoder/rules/`:

```bash
mkdir -p .qoder/rules
cp SKILL.md .qoder/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

## Verifying

Ask Qoder:

> Use the easyeda-eprj3 rule to author a board at `~/myboard`.