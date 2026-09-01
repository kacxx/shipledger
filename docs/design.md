# shipledger — design

**Date:** 2026-09-01
**Status:** approved design, not yet implemented
**Scope:** sub-project 1 of 2 (reconciler). Sub-project 2 (GitOps deployer) is out of scope here; the seam is described at the end.

## Problem

Release tooling answers "what does the tracker say shipped?" and "what does git say shipped?" separately, and the two are rarely checked against each other. The gap is where releases go wrong: work that merged but was never tagged onto the release, tickets marked done with no code behind them, commits nobody can account for.

Changelog generation from git is well served — `git-cliff`, `release-please`, `conventional-changelog`, `changesets` all do it without an LLM, and shipledger does not compete with them. Mainstream release tools do not centre the reconciliation between a tracker's claim and git's reality, and that is the whole point of this tool. The changelog is a by-product of a verified changeset, not the product.

## Goals

- Prove a claimed changeset against git across one or more repositories, and report what does not line up.
- Work with any tracker without shipping adapters for any of them.
- Produce output an auditor would accept: reproducible, complete, and explicit about what was excluded and why.
- Be usable in sixty seconds against a public repository with no credentials and no configuration.
- Preserve a hard separation between deterministic mechanics (a CLI) and judgement (an agent skill).

## Non-goals (v1)

- Tracker adapters of any kind.
- Deploying anything.
- Posting anything to any system.
- Version control other than git.
- Signing or cryptographic attestation of the artifact.

## Audience

Public open source. Two first-class workflows, both supported and both exercised in CI:

- **`github-oss`** — the changeset is a milestone or draft release; items are issues and pull requests; commit hygiene is inconsistent, so commits carrying no reference at all are normal and not a failure.
- **`tracker-keys`** — the changeset is a tracker release (Jira fixVersion or equivalent); items carry keys like `PROJ-42`; a commit with no reference is a process defect worth failing on.

Supporting both keeps the abstraction honest. A design validated against only one of them would quietly encode that one's assumptions.

## Architecture

Three units in the CLI package, plus the skill as a separate concern.

| Unit | Does | Depends on |
| --- | --- | --- |
| `core` | Given commit records, changeset items, and config, returns a reconciliation result | nothing — pure functions, no I/O |
| `git` | Walks a range in a local checkout and returns commit records | `git` binary, local filesystem (read-only) |
| `cli` | Arg parsing, file I/O, exit codes, built-in renderers | `core`, `git` |
| skill (plugin) | Builds the changeset, resolves aliases, confirms ranges, triages residue, renders org artifacts | the CLI, plus whatever MCP/CLI the operator already has |

`core` holds every interesting rule and can be tested entirely from fixtures. `git` is the only code that shells out. The skill is where all network I/O and all judgement live.

### Why the tool never talks to a tracker

The agent fetches the changeset through whatever the operator already has — an MCP server, a CLI, a REST call, a CSV export — normalises it to `changeset.json`, and hands that to the CLI. The CLI is then a pure function over local git plus that file.

This buys tracker-genericness with zero adapter code, zero credential handling, and zero auth surface. The cost is that the full workflow needs an agent; the CLI alone can still run headless in CI given a committed or generated `changeset.json`.

## Data contracts

### `shipledger.config.json` — durable, committed by the adopter

```json
{
  "version": 1,
  "preset": "tracker-keys@1",
  "repos": [
    { "name": "repo-a", "path": "../repo-a" },
    { "name": "repo-b", "path": "../repo-b" }
  ],
  "matchers": [
    {
      "id": "ticket-key",
      "sources": ["subject", "body"],
      "pattern": "([A-Z][A-Z0-9]+-\\d+)",
      "namespace": "global",
      "normalize": "upper"
    },
    {
      "id": "pr-ref",
      "sources": ["subject"],
      "pattern": "(#\\d+)",
      "namespace": "repo",
      "normalize": "none"
    }
  ],
  "history": "first-parent",
  "ignore": {
    "authors": ["dependabot[bot]"],
    "subjects": ["^Merge branch", "^chore\\(deps\\)"]
  },
  "policy": { "failOn": ["no-reference", "unknown-reference", "item-without-commits"] }
}
```

A matcher declares four things. `sources` are the commit fields it reads — **`subject` and `body` only**; see *Commit sources* below. `pattern` must contain exactly one capture group, and the **token is capture group 1 verbatim**, which is why `pr-ref` captures `(#\d+)` including the sigil rather than `#(\d+)`: the token and the alias that must match it are then written identically. `normalize` (`upper`, `lower`, or `none`) is applied to the token before comparison. `namespace` is either `global` — the token means the same thing everywhere, as a tracker key does — or `repo`, meaning the token is only meaningful within one repository, as a forge issue or PR number is.

`preset` supplies defaults for `matchers`, `history`, `ignore`, and `policy`. Merge semantics are deliberately blunt: **a key present in the config replaces the preset's value entirely**, including arrays, which are never concatenated or merged element-wise. Partial array merging is the kind of cleverness that makes two similar configs behave differently for reasons nobody can see in the file. Presets are versioned (`tracker-keys@1`); an unversioned name resolves to the latest and the resolved version is recorded in the output.

`failOn` keys are the finding names defined under *Reconciliation semantics*: `no-reference`, `unknown-reference`, `item-without-commits`, and `range-divergence`. `no-reference` and `unknown-reference` are separately selectable, which is what lets one format serve both worlds — `tracker-keys` fails on both, while `github-oss` fails only on `unknown-reference`, because a drive-by fix with no issue is normal in open source but work referencing a ticket outside the release is a problem anywhere.

### `changeset.json` — ephemeral, per release, written by the agent

This is the tracker's *claim*. The example below is from the `github-oss` workflow, whereas the config above is from `tracker-keys` — the two file formats are independent of preset, and `aliases` matters in both.

```json
{
  "version": 1,
  "id": "release 1.4.0",
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
      "url": "https://github.com/example/repo-a/issues/100",
      "aliases": [
        { "matcher": "pr-ref", "token": "#123", "repo": "repo-a" },
        { "matcher": "pr-ref", "token": "#128", "repo": "repo-b" }
      ]
    }
  ],
  "ranges": [
    { "repo": "repo-a", "base": "v1.3.0", "head": "v1.4.0" },
    { "repo": "repo-b", "base": "release/1.3", "head": "release/1.4", "include": ["packages/thing/**"] }
  ]
}
```

Five deliberate features:

- **`source` is mandatory.** An audit artifact that cannot say which query produced it, and when, is worth very little.
- **`aliases` resolve the second hop.** When a squash-merge subject carries a pull request number rather than an issue number, pure-git matching fails — `#123` in the commit does not match issue `#100` even though the PR closed it. The agent resolves that relationship, because it has the forge API; the matcher stays a dumb deterministic pattern with more tokens to match against. The same mechanism carries PR numbers in the tracker workflow.
- **Aliases are structured, not bare strings.** An alias names the matcher whose tokens it is expressed in, and — when that matcher's namespace is `repo` — which repository it belongs to. Bare `#123` is ambiguous in a multi-repo release, where `repo-a#123` and `repo-b#123` are unrelated pull requests, and matching them interchangeably would fabricate links that look authoritative. An alias for a `repo`-namespaced matcher that omits `repo` is a schema error, not a guess.
- **An item's `id` is implicitly a `global` token; everything repo-scoped goes in `aliases`.** This works because tracker keys are globally unique by construction, which is what a tracker key is for. Forge numbers are not, so in the `github-oss` workflow the agent sets `id` to a globally unique form (`example/repo-a#100`) and puts the repo-scoped tokens in `aliases`, as above.
- **`include` handles monorepos.** A release of one package must not absorb another package's commits. Cheap to build now, painful to retrofit.

### `verified-changeset.json` — the output, and every renderer's input

The output is **one canonical list of commits** carrying their references and findings, plus a derived index by item. It is not a set of mutually exclusive buckets, for the reason given under *Reconciliation semantics*. The example below uses the `tracker-keys` workflow, because the coexistence case it illustrates is clearest with tracker keys.

```json
{
  "version": 1,
  "generatedAt": "2026-09-01T02:00:00Z",
  "cliVersion": "1.0.0",
  "configFingerprint": "sha256:…",
  "changeset": { "id": "release 1.4.0", "source": { "…": "…" } },
  "ranges": [
    {
      "repo": "repo-a",
      "base": "v1.3.0", "baseSha": "…",
      "head": "v1.4.0", "headSha": "…",
      "mergeBase": "…",
      "baseIsAncestorOfHead": true,
      "commitsOnlyInBase": 0
    }
  ],
  "commits": [
    {
      "repo": "repo-a",
      "sha": "…",
      "subject": "PROJ-42: handle empty range (#123)",
      "author": "…",
      "committedAt": "…",
      "ignored": null,
      "references": [
        { "matcher": "ticket-key", "token": "PROJ-42", "namespace": "global", "source": "subject", "resolvesTo": "PROJ-42" },
        { "matcher": "ticket-key", "token": "PROJ-99", "namespace": "global", "source": "body", "resolvesTo": null }
      ],
      "findings": ["unknown-reference"]
    }
  ],
  "items": [
    { "id": "PROJ-42", "commits": [{ "repo": "repo-a", "sha": "…" }], "findings": [] }
  ],
  "summary": { "…": "…" },
  "verdict": "fail",
  "violations": [{ "finding": "unknown-reference", "count": 1 }]
}
```

Ignored commits stay in `commits` with `ignored` set to the rule that excluded them, rather than moving to a separate array. One canonical list means nothing can be dropped by omission, which is the property an audit artifact actually needs.

### `notes.json` — optional, produced by the agent's triage

Maps commit SHAs and item ids to a classification and a sentence. Passed to `render` so triage survives into the artifact and is reviewable as a diff. Keeps the CLI pure while making the judgement auditable.

## Reconciliation semantics

**What counts as a commit.** Default `history: "first-parent"`, which yields one entry per merged pull request on both squash-merge and merge-commit repositories rather than every intermediate commit. Set `history: "all"` for repositories that rebase-merge. `include` paths are applied as a pathspec on the same walk.

**Commit sources.** Matchers read `subject` and `body`. There is deliberately no `branch` source: a merged commit does not retain the branch it came from, and after a squash or rebase merge the branch name is gone from git entirely. A local-only walk cannot implement branch matching honestly, and a source that works on some merge strategies and silently returns nothing on others is worse than an absent feature. Where branch-derived information matters, the agent has it from the forge and expresses it as an alias.

**References, then findings.** Matching happens in two stages, and the order matters.

First, every commit gets a `references` list: each matcher runs over its sources, each capture becomes a `(matcher, token, namespace)` triple, normalised per the matcher's `normalize` rule. Tokens are compared as tuples, never as bare strings — a `repo`-namespaced token from `repo-a` never matches an item alias scoped to `repo-b`.

Second, each reference is resolved against the changeset's token set: it either names an item (`resolvesTo`) or it does not (`resolvesTo: null`).

Findings are then derived from that, and **they are not mutually exclusive**:

| Finding | Meaning |
| --- | --- |
| `no-reference` | The commit produced zero references. Routine in open source, a process miss under a tracker. |
| `unknown-reference` | At least one reference resolved to nothing — work shipped that the release does not claim. |
| `item-without-commits` | An item that no reference resolved to. The tracker claims it shipped; git disagrees. |
| `range-divergence` | `base` is not an ancestor of `head`, so the walk is asymmetric (see *Range validation*). |

The critical property is that `unknown-reference` is independent of linkage. A commit reading `PROJ-42, PROJ-99` where only `PROJ-42` is in the release is *both* linked to `PROJ-42` and carrying an unknown reference to `PROJ-99`. An earlier version of this design used mutually exclusive buckets, which would have linked that commit and discarded the `PROJ-99` signal entirely — losing exactly the orphan-detection the tool exists for, while still reporting success.

Ignored commits are excluded from matching but remain in the output with the rule that excluded them. An audit artifact that quietly discards commits is worse than no artifact.

**Range validation.** For each range the tool resolves `baseSha` and `headSha`, computes the merge-base, and records whether base is an ancestor of head. When it is not — two release branches cut independently from a trunk, for instance — `git log base..head` still returns something meaningful, but it is asymmetric: commits reachable from base and not head are invisible. That case emits `range-divergence` carrying the merge-base and the count of commits only in base. It is a warning by default rather than a hard error, because divergent release branches are a legitimate workflow; making it fatal is a one-word change to `failOn`. What is not acceptable is computing the asymmetric answer and presenting it as complete.

**Verdict.** `policy.failOn` names which findings are fatal; everything else is a warning. The verdict drives the exit code, so one invocation serves both interactive triage and a CI gate.

## Reproducibility contract

The tool claims that the same committed inputs produce the same answer. That claim only holds if the following are pinned, so they are part of the public contract rather than implementation detail.

- **Path resolution.** `repos[].path` resolves relative to the directory containing the config file, never the current working directory. A committed config must mean the same thing regardless of where the command is run from.
- **Strict schemas.** Published JSON Schema for all three input files, with `additionalProperties: false`. An unknown key is a schema error (exit 2), not a silently ignored one — a typo in `failOn` must not quietly disable a gate.
- **Preset merging and versioning.** As described above: a key present in the config replaces the preset's value entirely, arrays included; presets are versioned and the resolved version is recorded in the output.
- **Config fingerprint.** SHA-256 over the canonical JSON of the *fully resolved* config — after preset merge — together with the CLI version and the resolved preset version. Two runs that agree on the fingerprint were configured identically; two that disagree have an explanation available by diffing.
- **Ordering.** Repos in config order, commits in git's order for the given range, object keys sorted. Two runs diff cleanly or not at all.
- **Timestamps.** `generatedAt` appears in normal output and is suppressed under `--stable`, which is what golden tests and byte-comparison diffs use.
- **Output writing.** The output file is written atomically, so an interrupted run leaves either the previous file or none — never a truncated artifact that looks parseable.

## CLI surface

| Command | Purpose |
| --- | --- |
| `shipledger init` | Scaffold a config from a preset |
| `shipledger doctor` | Environment check against locally provable facts: repos present at the resolved paths, named refs resolvable, checkout not shallow, base/head ancestry, CLI/skill version compatibility |
| `shipledger check` | Config + changeset → `verified-changeset.json` + verdict |
| `shipledger render <report\|changelog\|release-notes>` | Verified changeset (+ optional notes) → artifact on stdout |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Verdict pass |
| 1 | Policy violation — the tool worked; the release has problems |
| 2 | Usage or schema error |
| 3 | Environment error |

Separating 1 from 2 and 3 is what lets the same invocation be a CI gate. The exit-code contract is a public API and is covered by tests.

### Failure behaviour

The tool blocks rather than guesses. A range naming a repo the config does not define, a ref that does not resolve, or a shallow checkout that cannot be walked is a hard stop naming the exact remedy — never a partial reconciliation. For a tool whose value is "you can trust this count", a quietly incomplete answer is the one failure mode that ends it.

## Safety posture

The CLI is **repository-read-only**: it never fetches, never checks out, never mutates a working tree or git metadata, and never contacts a network. It writes only its own explicit outputs — the config `init` scaffolds and the verified changeset `check` produces, both at operator-specified paths. That is a narrower and more honest claim than "read-only", and it is the one stated in the README, because a tool that runs unexpected network or write operations against repositories is one people will not point at their employer's code.

Because it does not fetch, `doctor` reports only what is locally provable: whether a named ref resolves, whether the checkout is shallow, whether base is an ancestor of head. It **cannot** know whether local refs are behind their upstream — that would require a network call it deliberately does not make. So it reports what it can see and says plainly that upstream state is unknown, rather than implying freshness it has no evidence for.

The only writes in the system are the agent posting an artifact somewhere, gated propose → confirm, each write confirmed individually.

## The skill

The skill owns the four things the CLI cannot do:

1. **Assemble `changeset.json`**, including provenance, from whatever source the operator has.
2. **Resolve the second hop into `aliases`** using forge or tracker context, including the matcher each alias is expressed in and the repository it is scoped to. This is the one place in the system that knows a pull request closed an issue, and it is the reason the CLI never has to.
3. **Confirm the ranges with the operator** rather than inventing base and head.
4. **Triage the findings**, using a fixed vocabulary so results are consistent between operators:
   - `no-reference` commit → revert, dependency bump, hotfix already released, tooling or CI, genuine process miss
   - `unknown-reference` commit → the referenced item belongs to another release, the reference is a typo, or the item was wrongly omitted from this release
   - `item-without-commits` → configuration only, documentation only, landed in an earlier release, wrongly tagged, not actually done
   - `range-divergence` → expected for independently cut branches, or a sign the wrong base was chosen

The skill never decides a match. Matching is deterministic and belongs to the CLI.

Org-specific artifacts — a change request, an evidence bundle, a release summary — are rendered by the agent from templates shipped in the plugin. The boundary is easy to police: mechanical projections of the JSON belong to the CLI; anything needing judgement or house style belongs to the agent.

## Testing

| Layer | Approach |
| --- | --- |
| `core` | Unit tests entirely from fixtures — no I/O to mock |
| `git` | Real throwaway repositories built by a fixture builder in a temp dir, covering each merge strategy and a divergent-range case |
| Renderers | Golden files under `--stable` |
| CLI | Exit-code assertions for each failure class |
| End to end | A **git bundle** of a pinned public repository at fixed refs, cloned into a temp dir by the test |

The end-to-end fixture is a bundle rather than vendored `git log` text, because the CLI's whole job is to walk a real repository — text output cannot exercise ref resolution, ancestry, shallowness detection, or pathspec filtering, which is most of what could go wrong. A bundle is a single self-contained file, keeps CI offline and deterministic, and still exercises the real code path end to end.

## Repo layout and packaging

```
packages/cli/      published to npm
plugin/            skill + artifact templates (Claude Code / Cursor plugin)
fixtures/          git bundle of the pinned public repo, plus core test fixtures
examples/          one config per preset
docs/
```

The CLI is published and invoked with `npx`, so adopters get no build step and the deterministic half is usable without an agent — in CI, in a Makefile, by someone who does not use Claude at all. The plugin stays small.

The cost of two cadences is a compatibility contract: the skill pins a CLI version range and `doctor` reports a mismatch.

Licence MIT, published under a neutral personal namespace rather than an employer org, since nothing in the tool is employer-specific.

## Seam to sub-project 2

The GitOps deployer will consume `verified-changeset.json` rather than a tracker URL, inheriting the tracker-genericness paid for here.

Once it exists it can supply a third input — what actually deployed, resolved from image tags back to commit SHAs — closing the triangle: the tracker's claim, git's reality, and the cluster's reality, reconciled against each other. That is an unusual capability among release tools, and the data model above supports it without change. It is explicitly not built in v1.
