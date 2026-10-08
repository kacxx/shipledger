# AGENTS.md

Working notes for agents and contributors. `README.md` says what shipledger does;
`docs/design.md` says why it works the way it does. This file covers how to change
it without breaking the things that aren't obvious from the code.

## Layout

- `packages/cli` — the `shipledger` npm package (TypeScript, ESM, Node >= 20.10).
  - `src/core` — pure functions: tokens, reconciliation, findings, verdict. The
    exception is `build-digest.ts`, which reads the installed package's files to
    compute the build digest.
  - `src/git` — the only code that shells out to git, and it only reads.
  - `src/config` — config loading, validation and the pinned presets (`presets.ts`).
  - `src/render` — `report`, `changelog`, `release-notes` and the check summary.
    `render/text.ts` strips control characters; Markdown escaping is separate
    (see "Escape at the renderer" below).
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
  the new version in the README. If it adds a config field, extend
  `schemas/config.schema.json`, and if that field reaches the artifact, extend
  `schemas/verified-changeset-v2.schema.json` too (`@3`'s `bodyReferences`
  needed both). A new preset changes output, so the version and `cliRange`
  rules below apply.
- **release-please sets the version; feature PRs don't.** It reads the PR
  titles merged to `main` (they become the squash-merge subjects) and keeps a
  release PR open that bumps `packages/cli/package.json`, the CLI's entry in
  the root `package-lock.json` and `packages/cli/CHANGELOG.md`. While the
  version is below 1.0, `feat` bumps the minor version, `fix` the patch
  version, and a breaking change (`!`) the minor version. Merging the release
  PR tags `vX.Y.Z`, creates the GitHub release and publishes to npm
  (`.github/workflows/release.yml`). Never edit the version by hand.
- **A PR that changes output needs a `feat` or `fix` title.** Any change to
  reconciliation, the artifact or rendered output must ship in a new version:
  the config fingerprint includes the CLI version, and
  `render --verify-against-repos` refuses artifacts written by a different
  version. A `docs`, `chore`, `test` or `refactor` title produces no release,
  so it must not change output. Say in the PR description whether output
  changes.
- **Rerun the corpus on the release PR.** Maintainers: before merging a
  release PR, rerun the private regression corpus (#36) against its build, and
  report verdict changes, new and resolved findings, other diffs, verification
  failures, and undetected or unexpected mutations (or "no diff") in a comment
  on the release PR. After merging, rebuild at the tagged commit and accept the
  new baseline in the corpus. Anyone who can't run the corpus says so; never
  report a result you didn't run.
- **Bump `cliRange` only when the skill needs the new CLI.** When you do, update
  `plugin/skills/shipledger/cli-compatibility.json` and every
  `--skill-cli-range` example in `SKILL.md`; `plugin.test.ts` fails if they
  disagree.
- **Escape at the renderer.** Item ids, titles and statuses come from a tracker,
  and subjects and ref names from git. `plain` and `oneLine` in `render/text.ts`
  only replace control and bidirectional-text characters; use `plain` for
  terminal output. Markdown output also needs Markdown syntax escaped, as
  `mdEscape` and `codeSpan` do in `report.ts`; without that, a title such as
  `[x](https://example.com)` renders as a live link. `changelog` and
  `release-notes` currently use only `oneLine` (issue #35).
- **Keep the repository adopter-neutral.** CI scans every file, the PR title
  and body, commit messages and the branch name (`CONTRIBUTING-GENERICITY.md`).
  Use the synthetic namespaces it lists (`PROJ-1`, `example/repo`) in fixtures,
  docs and PR text. Never name a real organization, tracker or private repo.
- **Update `docs/design.md` in the same PR** when behaviour or a data contract
  changes.

## Pull requests

- Conventional commit titles (`feat:`, `fix:`, `docs:`, `chore:`). PRs are
  squash-merged, so the PR title becomes the commit on `main`.
- `main` is protected: the six `test` jobs (Ubuntu, macOS and Windows on Node
  20 and 22) must pass on an up-to-date branch, and every review thread must be
  resolved before merging. The genericity jobs are not required checks, so
  check they passed before merging.
- The repository owner can't approve their own PRs, so agent reviews are posted
  as comment reviews with inline comments.
- PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`, `feat!:`),
  because release-please reads them. PR descriptions usually open with
  `## Summary` or `## Change`, say whether output changes, and end with a
  testing section.
- Leave follow-up work as a GitHub issue, not as a note in a PR or chat.

## Known environment quirks

- git 2.45 and later print a UTC commit time as `Z`; older git prints
  `+00:00`. `git/log.ts` normalises both to `+00:00`. CI's git prints `Z`, so
  the unit test in `test/git/log.test.ts` is what covers `+00:00`.
- macOS and Windows are in the CI matrix for path handling: the symlink, file
  URL and repo-root comparisons are exercised there and never on Ubuntu.
