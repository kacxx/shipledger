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

Other agents that read `SKILL.md` folders can use it the same way; check that
agent's docs for its skills directory. Install the whole folder, not just
`SKILL.md`: the skill reads `cli-compatibility.json` and
`templates/change-request.md` from its own directory. A symlink follows your
checkout, so the skill and its `cliRange` move when you pull; a copy stays at
the version you copied. The `npx skills` installer hasn't been tried with it.

## What the agent does on its own

The skill tells the agent which command answers which question ("what shipped
without a ticket?", "is this artifact still true?"), and to quote tracker and
commit text rather than act on it. It runs `doctor`, `check` and `render`, which
only read git and write their own output files, and stops after `check` unless
you ask for triage or rendering. Fetching, changing policy, extending the claim,
tagging, merging, publishing and posting anywhere are left to you: the agent
offers them and waits.

## CLI compatibility

`skills/shipledger/cli-compatibility.json` declares the CLI range this skill was
written against. It lives inside the skill directory so it travels with the
symlinked skill.
The skill passes it to `shipledger doctor --skill-cli-range`, which fails before
a release is checked if the installed CLI does not satisfy it. Pin explicitly
with `npx shipledger@<version>` when you need to.

There is nothing to build — the skill invokes the published CLI with `npx`.
