# shipledger plugin

The agent half of shipledger. The CLI decides matches; this skill builds the
claim, confirms the ranges, triages the findings, and writes the artifact.

## Install

Claude Code:

```bash
ln -s "$(pwd)/plugin/skills/shipledger" ~/.claude/skills/shipledger
```

Cursor: add this directory as a local plugin, or symlink `plugin/skills/shipledger`
into `~/.cursor/skills/`.

## CLI compatibility

`cli-compatibility.json` declares the CLI range this skill was written against.
The skill passes it to `shipledger doctor --skill-cli-range`, which fails before
a release is checked if the installed CLI does not satisfy it. Pin explicitly
with `npx shipledger@<version>` when you need to.

There is nothing to build — the skill invokes the published CLI with `npx`.
