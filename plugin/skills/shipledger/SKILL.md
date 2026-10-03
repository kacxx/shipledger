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
not second-guess it. Your job is the three things it cannot do:

1. Build `changeset.json` from whatever tracker the user has.
2. Declare every matchable identifier in `items[].tokens`.
3. Confirm the ranges with the user.

Never edit `verified-changeset.json`. Never claim a commit belongs to an item the
CLI did not link.

## Step 0 — Check compatibility and environment

Read `cliRange` from `cli-compatibility.json` in this skill's own directory (next
to this file, not the user's repository) and pass it through. `shipledger
--version` prints the installed version; `shipledger identity` adds the build
digest.

```bash
npx shipledger doctor --config shipledger.config.json --skill-cli-range '^0.3.2'
```

Exit 3 on an incompatible or uninterpretable range means stop and tell the user
which CLI version to pin. If there is no config yet:

```bash
npx shipledger init --preset tracker-keys   # or github-oss
```

`init` writes a pinned preset (`tracker-keys@2`). `check` and `doctor` reject an
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
`changeset.json`. A complete changeset looks like this (`init` also writes a
`changeset.example.json`):

```json
{
  "version": 1,
  "id": "v1.4.0 milestone",
  "source": {
    "kind": "github-milestone",
    "ref": "https://github.com/example/repo-a/milestone/7",
    "fetchedAt": "2026-09-01T01:00:00Z"
  },
  "items": [
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
  ],
  "ranges": [{ "repo": "repo-a", "base": "v1.3.0", "head": "v1.4.0" }]
}
```

- `source` is mandatory: `kind`, `ref` (the exact query or URL), `fetchedAt`.
- **`fetchedAt` is the actual UTC time the provider response was received**, not
  a constructed or approximate value. Capture it immediately when the provider
  responds — for example, record the wall-clock time before you parse the
  response. A fabricated or approximate timestamp corrupts the audit trail and
  makes the artifact non-reproducible.
- **`id` is opaque identity and is never matched against git.** Every identifier
  that might appear in a commit goes in `tokens` — including the item's own
  primary key or issue number. An item with no tokens is a schema error.
- Each token names its `matcher` and, for a repo-namespaced matcher, its `repo`,
  as in the item above.

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

After building the changeset, run `check` and inspect the verified output. For
each PR token you declared, confirm two things:

1. The commit carrying that PR number appears in the candidate range. If it does
   not, the PR may have landed in an earlier release or a different branch — the
   token is inapplicable to this changeset. Remove it and re-run.
2. That same commit also contains a reference the ticket-key matcher links to the
   same item. If the only link between a commit and an item is the PR token you
   declared, the association is circular — your declaration created the
   resolution. Find a second signal (ticket key in the commit subject, forge API
   link between the PR and the item) or remove the token.

### Stacked and feature-branch pull requests

A claimed PR merged into another PR's branch, rather than the default branch, has
no commit of its own on the first-parent path. Only the PR that finally reached
the default branch does, and its subject carries only its own number. The CLI is
right to report the claimed PR as `item-without-commits`; do not change
`history` to hide it.

Start with one pass over every `item-without-commits` item before tracing any
chain. Read each PR's base branch and merge commit together, and list the
commits `check` walked. Do this per repo: look PRs up in the item's own repo,
and take `baseSha` and `headSha` from that repo's range in
`verified-changeset.json`, not the ref names, which may have moved since
`check` ran. Drop `--first-parent` when the artifact's `history` is `all`:

```bash
for n in 101 102 103; do gh pr view "$n" -R <owner>/<repo> --json number,baseRefName,mergeCommit; done
git log --first-parent --format='%H %s' <baseSha>..<headSha>
```

Then sort each item by where its merge commit is:

- **On that path, under another PR's subject:** the variant described below.
  Containment is direct whatever the base branch says, and items from one stack
  often share this commit, so resolve them together.
- **On that path, under a subject with no PR reference** (a plain `Merge branch`
  merge, or a direct push): the work shipped, but no token can link it. Triage
  the item as `merged-via-another-change` and name the commit in the note. Unless
  an ignore rule matched it, that commit also carries its own `no-reference`
  finding; classify it as `process-miss` with a note naming the PR, so both
  entries describe the same event.
- **Not on that path, with a base branch that is another PR's head branch:**
  stacked. Follow the steps below.
- **None of these:** not stacked (a PR closed without merging has no merge
  commit). Triage the item.

Resolve the stacked items from forge evidence:

1. Read the PR's base branch and merge commit from the forge API (for example
   `gh pr view 123 --json baseRefName,mergeCommit`). A base branch that is
   another PR's head branch is the forge link the second-signal rule asks for.
   The child's merge commit is the commit made on that parent branch.
2. Confirm the child's work is contained in the parent's merge. A shared base
   branch is not enough: a child merged into the parent's branch *after* the
   parent reached the default branch never shipped with it. Check that the
   child's merge commit is one of the parent PR's commits (`gh pr view <parent>
   --json commits`), which holds for every merge method; for a merge-commit
   parent, `git merge-base --is-ancestor <child merge commit> <parent merge
   commit>` also works. If containment fails, triage the item instead. In a
   stack merged with merge commits, a child merge commit that is an ancestor of
   `headSha` but not of `baseSha` is already in this release. The PR that
   brought it in is the oldest first-parent commit in range that contains it,
   which may not be the PR the child was opened against:

   ```bash
   for c in $(git rev-list --first-parent --reverse <baseSha>..<headSha>); do
     git merge-base --is-ancestor <child merge commit> "$c" && { git log -1 --format='%H %s' "$c"; break; }
   done
   ```

   Use that commit's PR number as the token, and skip steps 3 and 4.
3. Follow the chain to the PR that reached the default branch, confirming
   containment at each hop, and add that PR's number as a token on the claimed
   item. Several stacked items may share one token; the one commit then links all
   of them.
4. Re-run `check` and confirm the parent's merge commit is in range. If it is
   not, the work landed in another release; triage it rather than keep the token.

A variant needs no chain: a PR whose base is the default branch but whose commits
reached it inside another PR first. The forge then records that other PR's merge
commit as this PR's merge commit, so containment is direct; add the other PR's
number as the token after confirming that commit is in range.

When the chain ends in a commit that carries no reference (for example a plain
`Merge branch` merge of a feature branch, which the preset ignores), no token can
link it. Triage the item as `merged-via-another-change` and name the branch or
commit in the note.

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
them to commit SHAs internally using
`git rev-parse --verify --end-of-options <ref>^{commit}`, which safely handles
any ref string (including those starting with `-`) and correctly dereferences
annotated tags to the underlying commit. All git commands use argument arrays
(no shell) and `--end-of-options` to prevent option injection.

When showing the operator the resolved SHA for confirmation, use the same
dereference: `git rev-parse --verify --end-of-options <ref>^{commit}`. A bare
`git rev-parse <ref>` on an annotated tag returns the tag object ID, not the
commit — presenting that as a commit SHA is incorrect.

## Step 3 — Run the check

```bash
npx shipledger check --config shipledger.config.json --changeset changeset.json --out verified-changeset.json
```

`check` also prints a short human summary to stderr: a `PASS`/`FAIL` line with
the violations and counts, then one line per finding (capped at 20). It is a
convenience for the operator; report from the artifact, which is the record.

Exit codes: `0` pass; `1` policy violation, which is an expected result to
report, then stop; `2` your input is wrong — fix the config or changeset; `3` environment —
the message names the remedy, and you must **not** fetch or check out on the
user's behalf.

### Default stop point

**Stop here.** Read `verified-changeset.json` and report these fields to the
user, then wait:

- **verdict** — `pass` or `fail`
- **summary** — `items`, `itemsLinked`, `commits`, `commitsIgnored`, `noReference`,
  `unknownReference`, `itemsWithoutCommits`, `rangeDivergence`,
  `indeterminateCommits`, `indeterminateItems`
- **violations** — each `{ finding, count }`, or "none" if empty
- **artifact path** — the `--out` path so the user knows where to find it

Exit `1` still stops. A policy violation is a result to report, not a reason to
auto-proceed into triage.

Steps 4 and 5 below run only when the user explicitly asks — e.g. "triage the
findings", "render a changelog", "write the change request". Do not proceed
automatically.

## Step 4 — Triage the findings (on request)

Triage is **all or nothing**. If you pass `--notes`, the file must account for
every finding in the artifact — exactly one entry each, no entries for findings
that are not there, and a real sentence on each. If you cannot classify
everything, **omit `--notes`** and render an explicitly untriaged artifact rather
than a partial one dressed up as complete.

Each section is an array of records, not a keyed object. Use this vocabulary and
nothing else:

| Section | Identifies a finding by | Allowed classifications |
| --- | --- | --- |
| `noReference` | `repo`, `sha` | `revert`, `dependency-bump`, `hotfix-already-released`, `tooling-or-ci`, `process-miss`, `security-advisory` |
| `unknownReference` | `repo`, `sha`, `matcher`, `token` | `other-release`, `typo`, `wrongly-omitted` |
| `items` | `item` | `configuration-only`, `documentation-only`, `landed-earlier`, `wrongly-tagged`, `not-done`, `merged-via-another-change` |
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

Two classifications need evidence in the note:

- **`security-advisory`** is for a fix merged from a private security fork (for
  example a `Merge commit from fork` commit), which carries no reference by
  design. Name the advisory the release claims in the note. Never add an ignore
  rule for these commits: that would hide security changes from the artifact.
- **`merged-via-another-change`** is for a claimed item whose work reached the
  default branch in a commit that no token can link: inside another change, or
  pushed directly without its own reference (see "Stacked and feature-branch pull
  requests" above). Name that commit or change in the note.

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

## Step 5 — Render the artifact (on request)

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
