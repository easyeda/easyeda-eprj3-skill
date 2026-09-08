# Install for Trae (ByteDance)

Trae loads custom instructions from `.trae/rules/`. Drop the skill there:

```bash
mkdir -p .trae/rules
cp SKILL.md .trae/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

## Verifying

In Trae's chat panel, ask:

> Use the easyeda-eprj3 rule to create a project at `~/myboard`.