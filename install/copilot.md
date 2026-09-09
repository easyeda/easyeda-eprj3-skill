# Install for GitHub Copilot

Copilot Chat picks up instructions from `.github/copilot-instructions.md`. Custom agents and instruction files can also be scoped per repo. Instruction files become part of the prompt, so we install a one-line pointer that redirects Copilot to the full skill.

## Project-local

```bash
mkdir -p .github
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
cat > .github/easyeda-eprj3.instructions.md <<'EOF'
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
EOF
```

Then add a pointer in `.github/copilot-instructions.md`:

```markdown
# Copilot Instructions

For EasyEDA Pro / eprj3 work, follow `.github/easyeda-eprj3.instructions.md`.
```

The clone keeps `scripts/` next to `SKILL.md`, so every `node scripts/...` path in the skill resolves correctly (the skill's own path note says paths are relative to the SKILL.md directory).

## User-wide

VS Code: **Settings → Copilot Chat → Custom Instructions** → add the pointer line as a global instruction:

```markdown
When the user mentions EasyEDA, 嘉立创EDA, eprj3, schematic, PCB, read `skills/easyeda-eprj3/SKILL.md` and follow it.
```

The repo clone is project-local, so run the `git clone` above once per project.

JetBrains IDEs: **Settings → GitHub Copilot → Instructions** → point at `skills/easyeda-eprj3/SKILL.md` inside the cloned repo.

## Verifying

In Copilot Chat, ask:

> Read `skills/easyeda-eprj3/SKILL.md`, then summarize the easyeda-eprj3 workflow.
