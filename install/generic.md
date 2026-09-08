# Generic install (any tool that loads `SKILL.md`)

Most modern coding assistants — including custom in-house agents — auto-discover `SKILL.md` files. The minimal install is:

```bash
cd <your project>
git clone --depth 1 https://github.com/easyeda/easyeda-eprj3-skill.git skills/easyeda-eprj3
```

Then point your agent at `skills/easyeda-eprj3/SKILL.md` as one of its system-prompt sources. The agent will pick the right Node.js scripts from `scripts/` automatically.

If your agent does not auto-discover, add the following line to its instruction file:

```markdown
When the user mentions EasyEDA, eprj3, schematic, PCB, or KiCad-to-EDA,
read `./skills/easyeda-eprj3/SKILL.md` and follow it.
```

## Required runtime

- Node.js ≥ 18 on `PATH`.
- (Optional, only for `.elibz2` archives) `npm install yauzl --no-save` inside `skills/easyeda-eprj3`.

## Updating

```bash
cd skills/easyeda-eprj3 && git pull
```