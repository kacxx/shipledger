# AGENTS.md

Working notes for agents and contributors. `README.md` says what shipledger does;
`docs/design.md` says why it works the way it does. This file covers how to change
it without breaking the things that aren't obvious from the code.

## Layout

- `packages/cli` — the `shipledger` npm package (TypeScript, ESM, Node >= 20.10).
  - `src/core` — pure functions, no I/O: tokens, reconciliation, findings, verdict.
  - `src/git` — the only code that shells out to git, and it only reads.
  - `src/config` — config loading, validation and the pinned presets (`presets.ts`).
  - `src/render` — `report`, `changelog`, `release-notes` and the check summary.
    Tracker and git text passes through `render/text.ts` (`plain`, `oneLine`).
  - `src/cli` — argument parsing, file I/O and exit codes.
  - `schemas/` — JSON schemas for the config, changeset, notes and artifact.
- `plugin/skills/shipledger` — the agent skill (`SKILL.md`) and
  `cli-compatibility.json`. The skill calls the published CLI through `npx`.
- `examples/` — sample configs and changesets. `examples.test.ts` and
  `plugin.test.ts` check them against the CLI and the skill.
- `docs/design.md` — the current design. `docs/plan.md` is the original
  implementation plan; it is historical and its paths and steps are out of date.

## Commands

Run from the repository root:

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
bash scripts/genericity-check.sh                  # whole tree
bash scripts/genericity-check.sh --diff origin/main
printf '%s\n' "$TEXT" | bash scripts/genericity-check.sh --stdin label
```

Tests make real git commits, so git needs a `user.name` and `user.email`.
Run one file with `npx vitest run test/<path>` from `packages/cli`.

## Rules that the code does not show

- **The CLI decides every match.** It is deterministic and never talks to a
  tracker or a network. Anything that needs judgement belongs in the skill or in
  `notes.json`, not in the CLI.
- **Presets are pinned.** Never change the behaviour of a released preset
  version. Add a new one in `presets.ts` (`github-oss@3` follows `@2`). `init`
  resolves the newest version, and `init.test.ts` asserts which one. Describe
  the new version in the README, and extend `schemas/config.schema.json` if it
  adds a config field.
- **Bump the CLI version when output changes.** Any change to reconciliation,
  the artifact or rendered output bumps `packages/cli/package.json`. The config
  fingerprint includes the CLI version, and `render --verify-against-repos`
  refuses artifacts written by a different version.
- **A version bump touches** `packages/cli/package.json`, `package-lock.json` and
  the expected version in `packages/cli/test/pack.test.ts`.
- **Bump `cliRange` only when the skill needs the new CLI.** When you do, update
  `plugin/skills/shipledger/cli-compatibility.json` and every
  `--skill-cli-range` example in `SKILL.md`; `plugin.test.ts` fails if they
  disagree.
- **Escape at the renderer.** Item ids, titles and statuses come from a tracker,
  and subjects and ref names from git. Pass them through `plain` or `oneLine`
  before they reach terminal or Markdown output.
- **Keep the repository adopter-neutral.** CI scans every file, the PR title
  and body, commit messages and the branch name (`CONTRIBUTING-GENERICITY.md`).
  Use the synthetic namespaces it lists (`PROJ-1`, `example/repo`) in fixtures,
  docs and PR text. Never name a real organization, tracker or private repo.
- **Update `docs/design.md` in the same PR** when behaviour or a data contract
  changes.

## Pull requests

- Conventional commit titles (`feat:`, `fix:`, `docs:`, `chore:`). PRs are
  squash-merged, so the PR title becomes the commit on `main`.
- `main` is protected: the CI matrix (Ubuntu, macOS and Windows on Node 20 and
  22) and the genericity jobs must pass, and every review thread must be
  resolved before merging.
- The repository owner can't approve their own PRs, so agent reviews are posted
  as comment reviews with inline comments.
- PR descriptions use `## Summary` (or `## Change`), `## Version` when the CLI
  version moves, and `## Tests`.
- Leave follow-up work as a GitHub issue, not as a note in a PR or chat.

## Known environment quirks

- Some git versions print a UTC commit time as `Z` and others as `+00:00`.
  `git/log.ts` normalises to `+00:00`; CI's git prints `+00:00`, so only the
  unit test in `test/git/log.test.ts` covers the `Z` form.
- Windows runs in CI because path handling (symlinks, file URLs, the repo-root
  comparison) only breaks there and on macOS.
