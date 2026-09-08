# Install for Windsurf (Codeium)

Windsurf reads memory files from `.windsurf/rules/*.md` (project) or `~/.windsurf/rules/*.md` (user).

## Project-local

```bash
mkdir -p .windsurf/rules
cp SKILL.md .windsurf/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

## User-wide

```bash
mkdir -p ~/.windsurf/rules
cp SKILL.md ~/.windsurf/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.windsurf/skills/easyeda-eprj3
```

## Triggering

Windsurf auto-includes `.windsurf/rules/*.md` as a system prompt. Ask Cascade:

> Author an EasyEDA Pro project at `~/myboard` with a 1k resistor and an LED.