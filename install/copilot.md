# Install for GitHub Copilot

Copilot Chat picks up instructions from `.github/copilot-instructions.md`. Custom agents and instruction files can also be scoped per repo.

## Project-local

```bash
mkdir -p .github
cp SKILL.md .github/easyeda-eprj3.instructions.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

Then add a pointer in `.github/copilot-instructions.md`:

```markdown
# Copilot Instructions

When the user asks about EasyEDA Pro, eprj3 projects, or schematic/PCB authoring,
read `.github/easyeda-eprj3.instructions.md` (which references
`./skills/easyeda-eprj3/SKILL.md`) and follow the workflow there.
```

## User-wide

VS Code: **Settings → Copilot Chat → Custom Instructions** → add `SKILL.md` content as a global instruction file.

JetBrains IDEs: **Settings → GitHub Copilot → Instructions** → point at the `SKILL.md` file inside the cloned repo.

## Verifying

In Copilot Chat, ask:

> Summarize the easyeda-eprj3 workflow.