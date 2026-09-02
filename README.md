# shipledger

Checks that what your tracker says shipped actually shipped.

You give shipledger a claimed changeset — a tracker release, a GitHub milestone,
whatever you use — and the git ranges it should correspond to, across as many
repositories as the release spans. It reports where the claim and git disagree:
commits referencing work outside the release, commits referencing nothing, items
claiming to have shipped with no code behind them, and ranges that cannot be
walked completely. Changelogs and change requests are rendered from the verified
result, never from the raw range.

`git-cliff` and friends tell you what is in a git range. shipledger tells you
where the tracker and git disagree.

## Try it

```bash
npx shipledger init --preset github-oss
# edit "repos" to point at a checkout
npx shipledger doctor
npx shipledger check --changeset changeset.json
npx shipledger render report
```

## How it works

Matching is deterministic regular expressions over commit text, never a language
model, so the result is reproducible and a CI gate can depend on it. shipledger
never talks to your tracker: an agent (or you) normalises the claim into
`changeset.json`, which is why any tracker works with no adapters and no
credentials.

**It is repository-read-only.** It never fetches, checks out, mutates a working
tree, or makes a network call. It writes only the output files you name.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Pass |
| 1 | Policy violation — the tool worked; the release has problems |
| 2 | Usage, schema, consistency, or invalid-expression error |
| 3 | Environment error |

## Findings

| Finding | Meaning |
| --- | --- |
| `no-reference` | The commit references nothing recognisable |
| `unknown-reference` | It references something this release does not claim |
| `item-without-commits` | The claim says it shipped; git disagrees |
| `range-divergence` | `base` is not an ancestor of `head`, so the walk is asymmetric |

Findings are **not** mutually exclusive. A commit linked to one item can still
carry an unknown reference to another, and that is the signal the tool exists for.

Which findings are *fatal* is policy, and the two presets differ deliberately.
`tracker-keys` fails on all four: under a tracker, a commit with no ticket is a
process defect. `github-oss` fails only on `unknown-reference` and
`range-divergence`, because a drive-by fix with no issue is normal in open
source, and milestone issues closed as duplicate, wontfix, or docs-only routinely
have no code behind them. Both findings are still reported either way — they are
just not gate failures.

## Triage

`render` accepts an optional `notes.json`. Omit it and the artifact is explicitly
marked untriaged. Supply it and it must cover every finding exactly once, with a
non-empty sentence each, and name no finding that does not exist — a partial
triage presented as a complete one is the failure this rule exists to prevent.
Identical sentences may be reused freely, which matters when forty dependency
bumps share one disposition.

## Two things that surprise people

**An item's `id` is not matched against git.** Every identifier that can appear
in a commit is listed explicitly in `items[].tokens`, including the item's own
key. This keeps matching fully tuple-based — `(matcher, scope, token)` — so a
pull request number in `repo-a` can never match one in `repo-b`.

**A present config key replaces the preset value entirely**, objects and arrays
included. There is no deep merge, so an override must be complete. Presets are
pinned (`tracker-keys@1`) so a CLI upgrade cannot silently change the policy your
release was judged against.

## With an agent

`plugin/` holds a Claude Code / Cursor skill that builds the changeset, resolves
the pull-request-to-issue hop into tokens, triages findings into `notes.json`, and
renders a change request. See `plugin/README.md`.

## Configuration

Start from a preset (`tracker-keys` or `github-oss`) and override what you need.
Full reference: `examples/` and `packages/cli/schemas/`.

## Licence

MIT.
