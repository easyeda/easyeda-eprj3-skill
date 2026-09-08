# Install for Continue.dev

Continue reads rule files from `.continue/rules/` (project) or `~/.continue/rules/` (user). Each rule is a `.md` file that becomes a system prompt.

## Project-local

```bash
mkdir -p .continue/rules
cp SKILL.md .continue/rules/easyeda-eprj3.md
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

Optionally declare the rule in `.continue/config.json`:

```json
{
  "rules": [".continue/rules/easyeda-eprj3.md"]
}
```

## User-wide

Place `SKILL.md` at `~/.continue/rules/easyeda-eprj3.md` and clone the repo to `~/.continue/skills/easyeda-eprj3`.

## Verifying

In Continue's chat box, type `/rules` and confirm `easyeda-eprj3` is listed. Then ask:

> Run the easyeda-eprj3 skill on `~/projects/myboard`.