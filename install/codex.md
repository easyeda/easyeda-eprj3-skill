# Install for OpenAI Codex CLI

Codex reads `AGENTS.md` from the project root and any sibling folders it discovers. The recommended layout:

```bash
# project-local
mkdir -p skills
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

Then add a pointer in your project `AGENTS.md`:

```markdown
## Skills

This project uses the EasyEDA Pro eprj3 skill at `skills/easyeda-eprj3/SKILL.md`.
Read it whenever the user mentions "EasyEDA", "eprj3",
or asks to author a schematic/PCB project from scratch.
```

## Optional: user-wide

Drop the repo into `~/.codex/skills/easyeda-eprj3` and add the same `AGENTS.md` snippet to your home-directory `~/.codex/AGENTS.md` if you keep one.

## Verifying

Ask Codex:

> Read `skills/easyeda-eprj3/SKILL.md` and list the workflow steps.