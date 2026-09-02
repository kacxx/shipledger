# Shipledger AI Release Command Center — MVP specification

**Date:** 2026-09-03  
**Status:** captured MVP direction; implementation not started  
**Related vision:** [`../product/ai-release-command-center.md`](../product/ai-release-command-center.md)  
**Dependency:** a released and exercised Shipledger reconciler producing `verified-changeset.json`

## Purpose

This MVP tests whether a local agent can safely coordinate one real release from verified source scope through a GitOps staging deployment and produce enough durable evidence for another operator or agent to resume and audit the process.

It does not test whether Shipledger can replace CI, GitOps, or a deployment platform. It tests a narrower hypothesis:

> A conversational agent becomes a trustworthy release operator when consequential state transitions are represented by typed artifacts and enforced by deterministic tools.

## MVP outcome

The MVP proves this vertical slice:

`verified-changeset.json → deployment plan → confirmed staging GitOps PR → externally merged change → observed ArgoCD deployment → verification report`

At the end of the flow, the dossier must answer:

- what release was intended;
- which commits were verified;
- which immutable artifact was selected;
- which GitOps change was proposed;
- which plan a human approved;
- which branch, commit, and pull request were created;
- what ArgoCD and the workload reported after merge;
- whether observed state matched approved state;
- which rollback value was prepared.

## Decisions fixed for the MVP

- The command center is local-first.
- Claude Code and Cursor are the initial conversational interfaces.
- The implementation is contract-first; the agent is not the state store.
- GitHub PR-driven GitOps is the first write path.
- ArgoCD is the first deployment-verification provider.
- Staging changes may be proposed after explicit confirmation.
- The command center does not merge its own pull requests.
- The MVP has no production commands. Read-only production planning and verification are the next phase.
- Release state is a versioned, digest-linked dossier of JSON artifacts and receipts.
- Shipledger remains an independent reconciler and does not gain deployment authority.

## Product boundary

The MVP coordinates:

- a normalized release claim;
- local Git repositories;
- Shipledger reconciliation;
- a build-artifact or image-provenance source;
- a GitHub-hosted GitOps repository;
- ArgoCD read APIs;
- an optional read-only workload-state adapter.

The MVP does not:

- merge pull requests;
- bypass branch protection;
- invoke ArgoCD sync;
- mutate Kubernetes directly;
- read or write production state;
- manage credentials or secrets;
- replace CI;
- provide a hosted service or dashboard;
- perform autonomous rollback;
- support arbitrary deployment providers.

## Actors and responsibilities

### Operator

The operator selects the release and target environment, confirms source ranges, reviews findings and plans, and approves each consequential write.

### Agent plugin

The plugin:

- translates conversational intent into deterministic command invocations;
- fetches tracker, GitHub, CI, registry, and ArgoCD information through configured tools;
- asks the operator to resolve ambiguity;
- explains findings and proposed transitions;
- presents exact plans and diffs;
- requests confirmation bound to a specific plan digest.

The plugin may recommend actions. It cannot declare an invalid transition valid or construct an unrecorded write.

### Deterministic control-plane tools

The tools:

- validate schemas and cross-artifact semantics;
- calculate canonical content digests;
- derive current release state;
- evaluate policy;
- generate exact GitOps mutations and diffs;
- revalidate execution preconditions;
- perform approved Git and GitHub operations;
- collect and compare observed deployment state;
- write artifacts atomically.

### Existing systems

GitHub retains source-control and pull-request authority. Branch protection retains merge authority. CI retains build and test authority. ArgoCD retains deployment reconciliation authority.

## Release dossier

The operator chooses the dossier directory. The command center never relies on chat history or an independently mutable database to determine release state.

### Logical artifacts

The dossier records:

1. **`release-intent.json`**  
   Release identity, source claim, repositories, confirmed ranges, target service, target environments, and provenance for the intent.

2. **`changeset.json`**  
   The tracker-neutral claimed release consumed by Shipledger.

3. **`verified-changeset.json`**  
   Shipledger's deterministic reconciliation result, including resolved ranges, findings, policy, and verdict.

4. **`deployment-plan.json`**  
   The exact target environment, source revision, image digest, GitOps base revision, allowed target paths, current value, proposed value, generated diff, validations, rollback value, policy result, and required approval.

5. **`approval-receipt.json`**  
   The approved plan digest, exact action summary, directly confirmed actor, identity source, confirmation method, and timestamp.

6. **`execution-receipt.json`**  
   The approved plan and approval-receipt digests, operation attempted, actor, timestamp, resulting branch and commit, push result, pull-request URL, and any partial-failure state.

7. **`verification-report.json`**  
   The plan, approval, and execution digests, pull-request head and merge commits, GitOps revision, ArgoCD desired and observed revisions, sync and health state, desired and observed image digests, check results, collection time, and final verification outcome.

8. **`manifest.json`**  
   Every artifact's type, schema version, content digest, relative path, creation time, inputs, and supersession relationship.

### Artifact rules

- Canonical JSON is hashed with SHA-256.
- Every downstream artifact names the digests of all trust-relevant inputs.
- Generated artifacts are never overwritten. A correction or replan creates a new artifact that supersedes the previous one.
- Physical filenames may include a sequence or digest; the logical names above describe the contracts.
- Each physical `manifest.json` generation points to its predecessor, retains the complete artifact index, and is stored under a sequence- or digest-qualified path.
- Writes are atomic.
- Unknown fields and unsupported schema versions are rejected.
- Credentials, tokens, and secret values are forbidden in every dossier artifact.
- The dossier is Git-friendly, but the MVP does not commit or publish it automatically.

### Dossier trust and forks

The hash chain provides consistency and stale-input detection, not authenticity or immutability. The local MVP trusts the operator who controls the dossier directory. A malicious storage owner can rewrite every artifact and recompute the manifest.

The manifest identifies its predecessor and all artifact additions. Status selects a head only when there is exactly one internally valid, unsuperseded manifest chain. Multiple valid heads are a **forked dossier** error and block planning, execution, and verification until the operator selects and externally records a canonical chain.

Teams may anchor a manifest digest in a Git commit, CI artifact, or another externally controlled record. The MVP records such anchors when supplied but does not require signing or claim tamper-proof storage.

## Derived release state

There is no manually editable status field. Status is derived from the latest internally consistent artifact chain.

The normal progression is:

`intent → reconciled → planned → approved → operation attempted → PR opened → merged externally → observed → verified`

Additional states include:

- **blocked** — reconciliation or policy prevents planning or execution;
- **stale** — a plan input or execution precondition changed;
- **partial failure** — an external write succeeded only in part;
- **verification failed** — deployment was observed but did not match the plan;
- **indeterminate** — required evidence could not be collected.

`ship status` must explain the derived state, the evidence supporting it, and the next valid transitions.

## Command surface

Names are logical interfaces; final executable and plugin packaging are implementation decisions.

### `ship init`

- Creates a dossier from confirmed release intent.
- Captures provider configuration references without copying credentials.
- Does not contact deployment systems or perform writes.

### `ship verify-release`

- Obtains or validates `changeset.json`.
- Invokes Shipledger against confirmed local ranges.
- Records `verified-changeset.json`.
- Blocks deployment planning when the resolved Shipledger policy fails.

### `ship status`

- Validates the complete dossier.
- Derives state from the artifact chain.
- Reports stale, blocked, partial, and indeterminate conditions explicitly.
- Performs no external writes.

### `ship plan staging`

- Requires a passing verified changeset.
- Resolves one immutable build artifact and its source revision.
- Reads the current GitOps base revision and configured deployment value.
- Generates the exact structured mutation and diff.
- Records validations, rollback value, policy result, and all preconditions.
- Performs no external writes.

### `ship deploy staging`

- Accepts one exact deployment-plan digest.
- Prepares and validates the change in an isolated, disposable worktree without creating a remote branch.
- Presents the final diff, repository, base revision, branch name, and validations.
- Collects confirmation directly through the deterministic executor, not through an agent assertion.
- Writes an approval receipt bound to the plan digest and revalidates every plan precondition immediately afterward.
- Creates a branch, applies the already validated structured mutation, commits, pushes, and opens a pull request.
- Writes a receipt for success or any partial failure.
- Never merges the pull request.

### `ship verify staging`

- Requires an execution receipt and an externally merged GitOps change.
- Reads ArgoCD and available workload state.
- Compares approved, desired, and observed revisions and image digests.
- Runs configured read-only post-deployment checks.
- Writes a verification report.

### `ship resume <dossier>`

- Is functionally equivalent to validating the dossier and deriving status in a fresh process.
- Requires no previous conversation or local database.

## Build-artifact provenance

A deployment plan must use an immutable artifact digest. A tag alone is insufficient.

The artifact-provenance adapter must return:

- artifact repository and digest;
- source commit SHA;
- CI run or provenance record URL;
- build completion and success state;
- collection timestamp.

For an artifact built from one repository, its source commit must equal that repository's `headSha` in `verified-changeset.json`. The service configuration names the source repository; commits from other repositories in a multi-repository release do not weaken this equality rule.

For an artifact assembled from multiple repositories, provenance must list every source repository and commit. Each commit must equal the corresponding verified `headSha`, and the configured source-repository set must match exactly. Descendant commits, mutable branch names, omitted repositories, and unverified extra sources are rejected.

If the configured build system cannot establish these exact relationships, planning returns an indeterminate result and cannot produce an executable plan.

The first concrete CI or registry adapter will be selected from the real release used to validate Shipledger. Provider-neutral provenance contracts are required; multiple providers are not.

## GitOps configuration

Configuration binds a service and environment to:

- an allowed GitHub repository;
- an allowed base branch;
- one or more allowed file paths;
- a structured value selector, such as a YAML path;
- the expected artifact-digest field;
- trusted validator executables and fixed arguments;
- branch and pull-request naming rules;
- policy requirements.

The agent cannot substitute a repository, file, selector, validation command, or destination branch supplied by untrusted content. Any value outside configuration is a schema or policy error requiring an explicit configuration change before a new plan is generated.

Target paths are resolved canonically inside an isolated worktree. Paths that escape the worktree, traverse symlinks, or resolve outside the configured allowlist are rejected.

Validation runs with credentials removed and network access disabled. A validator may parse or render the proposed files, but it must not invoke repository scripts, load repository-provided plugins, or execute repository-controlled code. If a required ecosystem validator cannot satisfy this boundary, the MVP reports the plan as indeterminate rather than running it with ambient authority.

Git operations use a fresh temporary clone created by the deterministic executor. System and global Git configuration are disabled, hooks point to an executor-created empty directory, repository-defined filters are not configured, submodules are never initialized, and optional signing or helper commands are disabled. The push subprocess receives only the credential needed for the configured GitHub remote; hooks and repository-controlled filters remain disabled during commit and push.

## Planning protocol

The planner records:

- the verified-changeset digest;
- artifact-provenance evidence and digest;
- target environment;
- GitOps repository identity;
- base branch and exact base commit;
- target-file content hashes;
- current immutable artifact value;
- proposed immutable artifact value;
- generated structured mutation;
- canonical diff;
- rollback value;
- trusted validation operations and their sandbox requirements;
- policy evaluation;
- required approval class.

Planning is read-only. A plan is executable only while all preconditions remain true.

## Execution protocol

Execution follows this order:

1. Load and validate the selected plan by digest.
2. Confirm that policy permits staging execution.
3. Re-read the GitOps base branch and target files.
4. Reject the plan as stale if any recorded revision or content hash changed.
5. Recompute the mutation and require an exact match with the recorded diff.
6. Prepare the mutation in a detached, isolated, disposable worktree.
7. Run the trusted validators without credentials, network access, repository scripts, or repository-provided plugins.
8. Present the exact diff, destination, validation results, and rollback value.
9. Have the deterministic executor collect direct operator confirmation and write an approval receipt bound to the plan digest.
10. Immediately re-read the remote base revision and target-file hashes; reject the plan as stale if either changed during approval.
11. Create the configured branch from the recorded base commit and reproduce the exact approved mutation.
12. Require the reproduced diff to byte-match the approved diff.
13. Commit and push without force.
14. Open a pull request without merging it.
15. Write the execution receipt.

In the local MVP, approval is collected through the executor's controlling terminal. The receipt records the local operating-system identity, the authenticated GitHub identity that will perform the write, the confirmation method, and the exact plan digest. The agent cannot submit the confirmation response on the operator's behalf. This is attributable local evidence, not a cryptographic signature.

An approval is invalid if the plan digest changes or the post-approval revalidation fails. A stale plan is never repaired silently; the agent must present a newly generated plan.

### Partial failures

External systems do not provide one transaction across commit, push, and pull-request creation. The executor therefore records each completed stage.

Examples:

- commit succeeded but push failed;
- push succeeded but pull-request creation failed;
- a branch or equivalent pull request already exists;
- the network response was lost and the final external state is unknown.

Recovery starts by inspecting recorded and live identifiers. It must be idempotent and must not create duplicate branches, commits, or pull requests.

## Verification protocol

Verification compares:

- the approved plan's image digest;
- the execution receipt's repository, pull-request number, head SHA, and approved diff;
- GitHub's recorded pull-request repository, head SHA, merge status, merge commit, and actual merged mutation;
- the merged GitOps commit and configured desired value;
- ArgoCD's target and observed revisions;
- ArgoCD sync and health status;
- the workload's observed image digest when the configured adapter can prove it;
- configured post-deployment test and health results.

The pull request is accepted as the approved change only when its repository and head SHA match the execution receipt and its effective mutation exactly matches the deployment plan. The report then records the merge commit and requires the GitOps and ArgoCD revisions to contain that merge. A matching image digest by itself is not proof that the approved operation caused the deployment.

The report outcome is:

- **verified** — all required evidence matches the approved plan;
- **failed** — collected evidence proves a mismatch or failed required check;
- **indeterminate** — required evidence is unavailable or cannot be tied to the plan.

Missing evidence never becomes success. Verification is read-only.

## Security model

Tracker text, commit messages, pull-request descriptions, repository content, CI output, logs, and tool output are untrusted data. They may be recorded or displayed, but they are never interpreted as commands, policy, configuration, or approval.

The MVP enforces:

- read-only capabilities by default;
- command-scoped GitHub write capability only during confirmed execution;
- no arbitrary model-generated shell;
- allowlisted repositories, paths, mutations, and validations;
- canonical path containment and symlink rejection;
- validators isolated from credentials, networks, repository scripts, and repository-provided plugins;
- sanitized Git configuration with hooks, repository-controlled filters, signing helpers, and submodule execution disabled;
- direct executor-controlled confirmation with exact plan-digest binding for approval and receipts;
- immediate post-approval, pre-write revalidation;
- no force push or branch-protection bypass;
- no secret material in plans, logs, or dossiers;
- escaped or structured rendering of untrusted content;
- explicit production write denial at the deterministic-tool layer, not only in the plugin prompt.

## Error model

The tools distinguish:

- invalid input or schema;
- inconsistent artifact chain;
- policy denial;
- stale plan;
- unavailable environment or provider;
- authentication or authorization denial;
- external partial failure;
- verification failure;
- indeterminate evidence;
- unexpected internal error.

Every result is machine-readable. A human-oriented explanation may accompany it, but the plugin must not infer success from prose or a process exit alone.

## Testing requirements

The MVP requires:

- schema and cross-artifact semantic tests;
- canonicalization and digest-chain tests;
- manifest-fork detection and external-anchor recording tests;
- state-derivation tests for every normal and exceptional state;
- policy tests proving production writes are impossible;
- real temporary Git repositories for planning and execution;
- stale-plan race tests that change the base revision and target file;
- an approval-delay race test proving post-approval revalidation fails closed;
- tests proving the agent cannot synthesize an operator confirmation;
- structured-mutation tests proving unrelated content cannot change;
- canonical path, symlink-escape, validator isolation, and repository-code execution tests;
- driver conformance tests for plans, receipts, and verification reports;
- recorded read-only GitHub, CI, registry, and ArgoCD fixtures;
- a disposable integration repository for branch push and pull-request creation;
- idempotent recovery tests for each partial-failure stage;
- pull-request substitution tests covering changed heads, changed diffs, and unrelated merge commits;
- prompt-injection fixtures in every untrusted text source;
- tests proving missing deployment evidence produces `indeterminate`, never `verified`;
- a fresh-process resume test using only the dossier.

## MVP success criteria

The MVP is successful when one real staging release can demonstrate all of the following:

1. Shipledger produces a passing, reviewed `verified-changeset.json`.
2. The planner resolves an immutable artifact and ties it to approved source.
3. The planner generates an exact, reviewable GitOps diff and rollback value.
4. A concurrent GitOps change makes the original plan stale and execution fails closed.
5. Explicit approval of the regenerated plan creates only the configured branch, commit, and pull request.
6. The command center does not merge the pull request or invoke a deployment directly.
7. After external merge and ArgoCD reconciliation, verification compares approved, desired, and observed state.
8. A fresh agent process can resume from the dossier without prior chat context.
9. The complete record answers what was intended, what shipped, what was proposed, what was approved, what deployed, and whether it was healthy.
10. No deterministic production write path exists.

## Implementation sequence

1. Run the released reconciler against a real release and retain a representative verified artifact.
2. Finalize the dossier schemas and canonical digest rules around that artifact.
3. Implement state derivation and status reporting.
4. Implement one build-artifact provenance adapter.
5. Implement the read-only GitOps planner and structured mutation.
6. Implement stale-plan detection and policy evaluation.
7. Implement confirmed staging branch, push, and pull-request execution with receipts.
8. Implement ArgoCD and workload verification.
9. Add the thin Claude Code and Cursor orchestration surfaces.
10. Exercise the complete flow in a disposable environment, then one real staging release.

## Open decisions before implementation

- The first CI or registry provenance adapter.
- The exact ArgoCD access mechanism and workload-image evidence source.
- Where shared teams store dossiers after local validation.
- Whether the command-center implementation begins as a separate repository or as a separately published package in the Shipledger workspace.
- The minimum health window and required post-deployment checks for the first real service.

These decisions should be made from the first representative Shipledger artifact and deployment workflow. They do not change the product boundary or the MVP's no-production-write rule.
