---
name: shipledger
description: >-
  Reconcile a claimed release changeset against git history using the shipledger
  CLI. Use when the user wants to verify a release, find commits that shipped
  without a ticket, find claimed work with no code, or produce a changelog or
  change request from a verified changeset.
---

# shipledger — verify a release, then write it up

## What this skill does and does not do

The CLI decides every match. It is deterministic and reproducible, and you must
not second-guess it. Your job is the four things it cannot do:

1. Build `changeset.json` from whatever tracker the user has.
2. Declare every matchable identifier in `items[].tokens`.
3. Confirm the ranges with the user.
4. Triage the findings into `notes.json`.

Never edit `verified-changeset.json`. Never claim a commit belongs to an item the
CLI did not link.

## Step 0 — Check compatibility and environment

Read `cliRange` from `plugin/cli-compatibility.json` and pass it through:

```bash
npx shipledger doctor --config shipledger.config.json --skill-cli-range '^0.1.0'
```

Exit 3 on an incompatible or uninterpretable range means stop and tell the user
which CLI version to pin. If there is no config yet:

```bash
npx shipledger init --preset tracker-keys   # or github-oss
```

`init` writes a pinned preset (`tracker-keys@1`). `check` and `doctor` reject an
unpinned preset, because an unpinned preset would let a CLI upgrade silently
change the policy a release was judged against.

### Inspect effective configuration

`doctor` prints the fully resolved effective configuration, marking each section
as `[preset]` (inherited from the preset) or `[adopter override]` (replaced by
the config file). The CLI uses replace-only overrides — when a section is
overridden, the entire preset default for that section is replaced, not merged.
Review the effective config before running `check` so there are no surprises
about which matchers, ignore rules, or policies apply.

## Step 1 — Build the changeset

Fetch the claimed release from the user's tracker using whatever is available —
an MCP server, a CLI such as `gh`, or a pasted export. Then write
`changeset.json`.

- `source` is mandatory: `kind`, `ref` (the exact query or URL), `fetchedAt`.
- **`fetchedAt` is the actual UTC time the provider response was received**, not
  a constructed or approximate value. Capture it immediately when the provider
  responds — for example, record the wall-clock time before you parse the
  response. The CLI rejects timestamps in the future.
- **`id` is opaque identity and is never matched against git.** Every identifier
  that might appear in a commit goes in `tokens` — including the item's own
  primary key or issue number. An item with no tokens is a schema error.
- Each token names its `matcher` and, for a repo-namespaced matcher, its `repo`:

```json
{
  "id": "example/repo-a#100",
  "title": "Handle empty range gracefully",
  "type": "issue",
  "status": "closed",
  "tokens": [
    { "matcher": "pr-ref", "token": "#100", "repo": "repo-a" },
    { "matcher": "pr-ref", "token": "#123", "repo": "repo-a" }
  ]
}
```

- This is the second hop: when a squash-merge subject carries a pull request
  number rather than an issue number, the token list is the only thing that
  connects them. You have the forge API; the CLI does not.
- V1 allows **one range per repo**. Multiple paths go in that range's `include`.

### Resolving PR tokens from forge evidence

When a claimed item was merged through a pull request, include the PR number as
a `pr-ref` token so the CLI can link the squash-merge commit. Look up associated
PRs from the forge API (e.g., `gh pr list --search "PROJ-101"` or the tracker's
linked-PR field).

**Only add a PR token when there is demonstrable association** — the PR
implements the claimed item, or the tracker/forge explicitly links them. Do not
guess. If a commit references `#42` and `#43`, but only `#42` implements
`PROJ-101`, then `PROJ-101`'s tokens include `#42` only. `#43` stays unresolved
and the CLI correctly reports it as `unknown-reference`.

Unresolved PR references are evidence, not defects. Classifying them requires
triage, not token injection.

After building the changeset, run `check` and inspect the output: every PR token
you added should resolve to the expected item. If a PR token you added does not
resolve (the commit carrying that PR number is not in the candidate range), the
association was wrong — remove the token and re-run. This is a concrete
verification that the association is supported by evidence in git, not only by
the tracker's metadata.

## Step 2 — Confirm the ranges

Do not invent `base` and `head`. Propose them and get confirmation:

> "I'll compare `repo-a` from `v1.3.0` to `v1.4.0`, scoped to `packages/thing/**`.
> Correct?"

### Preflight before confirmation

Before the operator confirms, run `doctor` with the changeset to validate the
environment and surface any issues:

```bash
npx shipledger doctor --config shipledger.config.json --changeset changeset.json
```

This checks that each repository is a complete (non-shallow) clone, that the
range refs resolve, and reports any staged, unstaged, or untracked changes under
the configured include paths.

**Shallow clones** cannot walk a commit range. `doctor` detects this and names
the remedy (`git fetch --unshallow`). Present the remedy and wait — never fetch
on the operator's behalf.

**Dirty working tree** changes are informational, not blocking. The CLI
reconciles against exact base/head commit SHAs, so working-tree modifications
are excluded from the candidate. Report them so the operator knows, and
explicitly state that they do not affect reconciliation. Changes outside
configured include paths are not reported.

### Ref resolution and annotated tags

The changeset records refs as-is (`v1.3.0`, `release/1.4`). The CLI resolves
them to commit SHAs internally using `git rev-parse --verify <ref>^{commit}`,
which correctly dereferences annotated tags to the underlying commit.

When showing the operator the resolved SHA for confirmation, use the same
dereference: `git rev-parse --verify <ref>^{commit}`. A bare
`git rev-parse <ref>` on an annotated tag returns the tag object ID, not the
commit — presenting that as a commit SHA is incorrect.

## Step 3 — Run the check

```bash
npx shipledger check --config shipledger.config.json --changeset changeset.json --out verified-changeset.json
npx shipledger render report --input verified-changeset.json
```

Exit codes: `0` pass; `1` policy violation, which is an expected outcome to
triage; `2` your input is wrong — fix the config or changeset; `3` environment —
the message names the remedy, and you must **not** fetch or check out on the
user's behalf.

## Step 4 — Triage the findings

Triage is **all or nothing**. If you pass `--notes`, the file must account for
every finding in the artifact — exactly one entry each, no entries for findings
that are not there, and a real sentence on each. If you cannot classify
everything, **omit `--notes`** and render an explicitly untriaged artifact rather
than a partial one dressed up as complete.

Each section is an array of records, not a keyed object. Use this vocabulary and
nothing else:

| Section | Identifies a finding by | Allowed classifications |
| --- | --- | --- |
| `noReference` | `repo`, `sha` | `revert`, `dependency-bump`, `hotfix-already-released`, `tooling-or-ci`, `process-miss` |
| `unknownReference` | `repo`, `sha`, `matcher`, `token` | `other-release`, `typo`, `wrongly-omitted` |
| `items` | `item` | `configuration-only`, `documentation-only`, `landed-earlier`, `wrongly-tagged`, `not-done` |
| `ranges` | `repo` | `expected-divergence`, `wrong-base` |

```json
{
  "version": 1,
  "noReference": [
    { "repo": "repo-a", "sha": "<full 40-char sha>", "classification": "tooling-or-ci", "note": "CI workflow only" }
  ],
  "unknownReference": [
    { "repo": "repo-a", "sha": "<full 40-char sha>", "matcher": "ticket-key", "token": "PROJ-9", "classification": "other-release", "note": "shipped in 1.3.0" }
  ],
  "items": [
    { "item": "PROJ-3", "classification": "not-done", "note": "moved to the next release" }
  ],
  "ranges": []
}
```

An `unknownReference` entry names the full reference tuple rather than just the
commit, so two unknown references on one commit take separate dispositions. Reuse
the same sentence wherever it genuinely applies — forty dependency bumps may all
say "routine dependency bump"; that is not a shortcut, it is the truth.

`render` also re-checks the artifact's internal consistency, so a carelessly
hand-edited `verified-changeset.json` is rejected rather than rendered. Careful
editing survives that check, so when you did not produce the artifact yourself
in this session, add `--verify-against-repos --config shipledger.config.json`.
That re-derives everything from git and refuses to render unless it matches.

`unknown-reference` matters most: work shipped that this release does not claim.
Never classify it as benign without evidence — name the release it belongs to, or
flag it to the user. If you cannot classify something, say so and ask. A wrong
classification in an audit artifact is worse than an open question.

## Step 5 — Render the artifact

```bash
npx shipledger render changelog --input verified-changeset.json --notes notes.json
npx shipledger render release-notes --input verified-changeset.json --notes notes.json
```

For a change request, verify against the repositories first and say in the
document whether you did:

```bash
npx shipledger render report --input verified-changeset.json --notes notes.json \
  --verify-against-repos --config shipledger.config.json
```

Org-specific artifacts come from you, using `templates/change-request.md`. Fill
every field from `verified-changeset.json` and `notes.json`. Do not invent test
evidence, approvers, or rollback steps. Report the config fingerprint as what it
is — a fingerprint of the config and CLI version — and cite the range SHAs when
the question is what shipped.

## Write discipline

The CLI writes only its own output files. Everything else — posting to a tracker,
commenting on a PR, updating a wiki — is **propose → confirm**, one confirmation
per write, showing the exact payload and destination first. Approval of a plan is
not approval of the writes inside it.
