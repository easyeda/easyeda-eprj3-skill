# Install for Roo Code / Roo-Cline

Roo reads rules from `.roo/rules/` and modes from `.roo/modes/`.

## Project-local

```bash
mkdir -p .roo/rules
cp SKILL.md .roo/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

## User-wide (recommended for frequent use)

```bash
mkdir -p ~/.roo/rules
cp SKILL.md ~/.roo/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.roo/skills/easyeda-eprj3
```

## Triggering

Roo auto-applies `.roo/rules/*.md` to the matching context. You can also invoke explicitly:

> Use the easyeda-eprj3 skill: create a project named `myboard` at `~/myboard` with a 1k resistor and an LED.

## Verifying

Open the Roo panel and confirm the rule is listed.