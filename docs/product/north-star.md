# Shipledger + AI Release Command Center — North Star

A trackable outline of the strategic idea. Each section is a stake to revisit,
not a spec. The companion documents are the product vision
(`ai-release-command-center.md`) and the MVP spec
(`../specs/ai-release-command-center-mvp.md`).

## 1. One-line positioning

**"Prove that what your tracker says shipped matches what Git — and
production — actually contains."**

Not a changelog tool, not an "AI deploy" wrapper. A **chain-of-custody engine
for releases**, with a conversational command center as its first frontend.

## 2. The durable product vs. the frontend

The key strategic split. Keep it clean.

- **Durable (defensible) product:** the schemas, deterministic engines,
  policies, and evidence artifacts. Version-pinned, reproducible, network-free.
- **Frontend (replaceable):** the Claude Code plugin as command center. First
  interface, *not* the product. Anything Claude-specific stays in the adapter
  layer.
- **Test for every feature:** "Would this still be valuable if the frontend
  were a plain CLI or a different agent?" If no, it belongs in the frontend,
  not the core.

## 3. The distinctive chain (the actual moat)

```
tracker claim → Git contents → built image SHA → GitOps change → deployed image → health evidence
```

Each link is deterministically verifiable and produces a reproducible artifact.
No competitor spans the full chain — reconcilers stop at Git, deploy assistants
start at GitOps.

## 4. Differentiation

Why this is not "another release tool":

- Tracker-independent (not Jira-locked).
- Multi-repository releases as a first-class concept.
- Deterministic verification **separated from** AI judgement.
- Strict, reproducible audit artifacts.
- No network access or credentials in the CLI.
- CI-friendly policies and exit codes.

## 5. Target audience

**Strong fit:** teams with Jira/GitHub release drift; multi-repo products;
compliance or formal-evidence requirements; AI-assisted engineering workflows.

**Weak fit (do not chase):** single-repo projects already on release-please,
conventional commits, or fully automated GitHub releases.

## 6. Architecture

| Layer | Role | Property |
|---|---|---|
| Shipledger core | Release truth and evidence | Deterministic, reproducible |
| Provider adapters | Exact plans/commands per provider (ArgoCD, Helm, GitHub Actions) | Deterministic |
| Claude Code plugin | Conversational command center | Explains state and next valid transition |
| Execution systems | GitHub / ArgoCD / etc. | Retain their own authority |
| Human | Approves each consequential write | Gate, not rubber-stamp |

## 7. Command surface

Staging-only in the MVP:

`ship init` · `ship status` · `ship verify-release` · `ship plan staging` ·
`ship deploy staging` · `ship verify staging` · `ship resume <dossier>`

Deferred to a later phase: `ship plan production`, `ship promote production`,
`ship verify-production`, `ship rollback`.

## 8. Phased build

1. **Reconciler + evidence artifact** — the verifiable core; ships standalone
   value with zero deployment features.
2. **Read-only deployment planner** — exact diff, no writes.
3. **Post-deployment state verification** — approved vs desired vs observed.
4. **Approval-gated execution** — branch/PR, never self-merge.
5. **Monitoring + rollback orchestration.**

## 9. Adoption risks

Name them so they do not ambush the roadmap:

- **`changeset.json` friction** — the #1 uptake blocker. The GitHub-milestone →
  changeset path must feel nearly automatic for public adoption.
- **Frontend lock-in creep** — resist letting Claude-specific behaviour leak
  into the core.
- **Scope gravity toward "AI deploys things"** — the generic version is a
  commodity; the proof / chain-of-custody framing is the defensible one.

## 10. Open questions

- What is the lowest-friction way to auto-derive `changeset.json` from a GitHub
  milestone or release?
- Which single provider adapter (likely ArgoCD) proves the
  verify-what-deployed link end-to-end first?
- What is the minimal evidence-artifact schema that is both audit-grade and
  diffable?

## 11. Guiding opinion

The **reconciler + evidence artifact is the real product**, and it delivers
value with zero deployment features — Phase 1 must be independently useful and
shippable, because it de-risks everything after it and earns adopters before
the deploy layer exists.

The command-center slant is the right *frame*, but the moat is the
deterministic chain, not the AI. The line to hold: keep the AI on the
*explain-state / propose-transition* side and never on the *assert-that-a-write-
succeeded* side. That separation is exactly what makes this trustworthy where
generic AI-deploy tools are not.
