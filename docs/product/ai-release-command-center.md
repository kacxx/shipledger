# Shipledger: AI Release Command Center

**Date:** 2026-09-03  
**Status:** product vision; implementation not started  
**Scope:** a future release-control-plane project built on Shipledger's reconciler, not an expansion of the reconciler itself

## One-line proposition

An AI-assisted release command center that proves what should ship, plans and controls deployment, and verifies what actually reached an environment.

## Thesis

Cloud infrastructure made systems dynamic, so delivery moved from manual server operations toward declarative infrastructure and continuous reconciliation. Agentic coding is making software change generation faster and increasingly autonomous. The next delivery bottleneck is therefore not producing code; it is preserving intent, trust, coordination, and proof as the volume and velocity of change increase.

Today's release process expects a human to join information spread across trackers, source repositories, CI, registries, GitOps repositories, deployment controllers, test systems, and observability tools. An agent can navigate those systems, but giving an unconstrained model deployment credentials or letting it invent shell commands does not create a trustworthy delivery system.

An agent-native solution needs:

- declarative release intent;
- typed, machine-readable state;
- deterministic plan, validate, execute, and verify operations;
- explicit capability and approval boundaries;
- idempotent, resumable workflows;
- digest-linked receipts connecting intent, source, artifact, configuration, and runtime state;
- continuous verification with a defined rollback path.

This points to an agent-native release control plane. Shipledger is its first trust primitive: it establishes what source changes belong to a release before any deployment authority is granted.

## Problem

Release truth is fragmented across:

- tracker releases, milestones, and tickets;
- Git commits, tags, and pull requests;
- CI runs and built artifacts;
- container registries and image digests;
- GitOps configuration;
- deployment-controller state;
- running workloads;
- tests, metrics, logs, and alerts.

Existing deployment assistants can invoke these systems, but invocation alone does not prove that:

- the tracker claim agrees with Git;
- the built artifact came from the approved source;
- the proposed GitOps change deploys that exact artifact;
- the observed deployment matches the approved plan;
- the release remained healthy;
- a later operator or agent can reconstruct what happened.

## Product definition

The command center is a local, agent-native control plane for teams that already use GitHub and GitOps. It coordinates existing systems through a verifiable release protocol.

The agent is the operator interface. It gathers context, resolves ambiguity, explains findings, recommends transitions, and asks for approval. It is not the durable source of truth and does not invent consequential operations.

Deterministic components own trust-sensitive work:

- Shipledger reconciles tracker intent with Git history.
- A deployment planner calculates exact, reviewable changes.
- A policy evaluator decides whether a transition is permitted.
- Execution drivers perform only approved, precomputed operations.
- Verifiers compare the approved plan with observed deployment state.
- A release dossier preserves the artifacts and receipts needed to resume or audit the release.

## End-to-end chain of custody

The product should establish and preserve this chain:

`tracker intent → Git commits → build artifact → GitOps change → deployed workload → health evidence`

Every transition records immutable identifiers such as commit SHAs, image digests, GitOps revisions, pull-request URLs, input digests, and observed controller state.

The command center should be able to answer:

- What was intended to ship?
- What source actually belongs to the release?
- What artifact was built from that source?
- What configuration change was approved?
- What was deployed?
- Who approved and performed each consequential action?
- Did the deployment become and remain healthy?
- What rollback target was prepared?

## Product boundary

The command center coordinates rather than replaces:

- trackers;
- GitHub;
- CI systems;
- artifact registries;
- ArgoCD or Flux;
- Kubernetes;
- test and observability systems.

It is not:

- a replacement for CI or GitOps;
- a general-purpose coding-agent manager;
- a system that gives an LLM unrestricted shell access;
- an autonomous production operator;
- a hosted deployment platform in its first form.

Claude Code and Cursor are initial interfaces, not permanent platform dependencies. The durable product is the set of schemas, policies, deterministic operations, state transitions, and receipts. Any agent, CI job, or future UI should be able to use the same protocol.

## Operating model

The command center operates over a versioned release dossier rather than chat history or an independently mutable status record.

A typical flow is:

1. Capture release intent and provenance.
2. Use Shipledger to reconcile the claimed release against Git.
3. Resolve the exact build artifact and target environment.
4. Generate a deployment plan from current GitOps state.
5. Revalidate all preconditions immediately before execution.
6. Request approval for the exact proposed operation.
7. Create the approved GitOps change and record a receipt.
8. Allow existing review, branch-protection, and GitOps controls to operate.
9. Observe deployment state and health evidence.
10. Produce a verification report.

The dossier makes this flow resumable by a fresh agent or operator without relying on the conversation that created it.

### Trust model

Digest links make accidental alteration, stale inputs, and internally inconsistent history detectable. They do not make a locally controlled dossier immutable or prove who created it: someone who controls every file can rewrite the chain and recompute its hashes.

The local MVP therefore trusts the dossier's storage owner and records the provenance and identity available from each external system. Teams needing stronger authenticity can anchor a manifest digest in Git or another externally controlled record. Signing, transparency logs, and hosted immutable storage remain later capabilities and must not be implied by the local hash chain.

## Safety principles

- Plan before execution.
- Use immutable commit SHAs and image digests, never mutable deployment tags.
- Present the exact diff and destination before a consequential write.
- Require explicit human approval for writes unless a separately reviewed policy grants a narrower capability.
- Revalidate plans immediately before execution and fail closed when state changed.
- Execute structured operations through deterministic drivers, not model-generated shell.
- Treat tracker text, commit messages, pull-request descriptions, repository files, and tool output as untrusted data.
- Keep credentials out of release artifacts.
- Preserve complete and machine-readable success, failure, and partial-failure receipts.
- Make operations idempotent or detect that an operation already occurred.
- Prepare a rollback target before deployment.
- Let existing branch protection and deployment controllers retain authority.

## Initial user experience

The first interface can expose conversational commands such as:

- `/ship init`
- `/ship status`
- `/ship verify-release`
- `/ship plan staging`
- `/ship deploy staging`
- `/ship verify staging`
- `/ship plan production`
- `/ship verify production`
- `/ship resume <dossier>`

The agent explains the state and next valid transition. Deterministic tools validate and perform that transition.

## Target users

The strongest initial users are teams with:

- multi-repository releases;
- Jira or GitHub release drift;
- GitHub-based development and GitOps deployment;
- formal release evidence or compliance requirements;
- growing use of coding agents;
- repeated manual coordination across source, deployment, and observability systems.

Small single-repository projects with fully automated releases and no audit requirement may receive less value.

## Differentiation

The differentiator is not that an agent can run deployment commands. That capability is easy to reproduce and unsafe when unconstrained.

The differentiator is a verified, resumable chain of custody:

- Shipledger proves that a supplied, provenance-recorded release claim agrees with the configured local Git ranges; the command center remains responsible for establishing where that claim came from.
- Plans connect approved source to an immutable build artifact and exact GitOps change.
- Execution is constrained to the reviewed plan.
- Verification proves that observed state matches approved state.
- Receipts preserve evidence for humans, agents, CI, and auditors.

## Product progression

### Phase 1 — Source reconciliation

Deliver the current Shipledger reconciler and validate `verified-changeset.json` against real releases.

### Phase 2 — Command-center MVP

Prove one GitHub and ArgoCD staging flow from verified changeset through deployment verification. The detailed scope is in [`../specs/ai-release-command-center-mvp.md`](../specs/ai-release-command-center-mvp.md).

### Phase 3 — Read-only production verification

Add production planning, then compare approved image digests and GitOps revisions with observed production state and health evidence. Production remains read-only at this phase.

### Phase 4 — Broader gated execution

Add policy-controlled promotions, additional GitOps providers, and carefully scoped rollback operations.

### Phase 5 — Shared control plane

Only after the local protocol is validated, consider shared storage, RBAC, a dashboard, background reconciliation, and cross-release coordination.

## Strategic risks

- The command center becomes a thin prompt wrapper instead of a testable protocol.
- Provider-specific assumptions leak into supposedly portable contracts.
- The dossier becomes too burdensome for ordinary releases.
- Artifact provenance cannot be established reliably from existing CI systems.
- Approval records identify a chat interaction rather than an authenticated actor.
- Partial external failures leave Git branches, pushes, or pull requests without usable receipts.
- Teams do not value source reconciliation enough to make it a release gate.
- Broad platform scope arrives before one end-to-end workflow is proven.

The MVP must test these risks with a narrow vertical slice rather than attempting a full deployment platform.

## Relationship to the reconciler

The current Shipledger reconciler remains an independent, deterministic tool with no deployment or posting authority. Its design and public contracts must not absorb command-center concerns.

The command center is a separate project that consumes the reconciler's published output. This separation keeps the release-evidence primitive useful in CI and to adopters who do not want an agent-driven deployment workflow.
