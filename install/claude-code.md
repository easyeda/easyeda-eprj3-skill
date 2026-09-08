# Install for Claude Code

Two options. Pick whichever fits your project layout.

## A. Project-local (recommended for one-off projects)

From your project root:

```bash
mkdir -p .claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  .claude/skills/easyeda-eprj3
```

Claude Code auto-loads any `SKILL.md` under `.claude/skills/`. From now on, when you ask Claude Code to "create an EasyEDA Pro project" or "convert my KiCad project to .eprj3", the skill triggers automatically.

## B. User-wide (every project on this machine)

```bash
mkdir -p ~/.claude/skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git \
  ~/.claude/skills/easyeda-eprj3
```

Claude Code merges user skills with project skills, so the skill is available in every workspace.

## Verifying

Inside Claude Code, ask:

> What scripts are available in the easyeda-eprj3 skill?

You should see `init.js`, `add-symbol.js`, `add-wire.js`, `validate.js`, etc.

## Updating

```bash
cd .claude/skills/easyeda-eprj3 && git pull
```

(Use `~/.claude/skills/easyeda-eprj3` for the user-wide install.)