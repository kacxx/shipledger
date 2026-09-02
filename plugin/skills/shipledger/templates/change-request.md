# Change request — {{changeset.id}}

**Verified changeset fingerprint:** {{configFingerprint}}
**Preset / history:** {{preset}} / {{history}}
**Claim source:** {{changeset.source.kind}} — {{changeset.source.ref}} (fetched {{changeset.source.fetchedAt}})
**Verdict:** {{verdict}}

## Scope

| Repo | Base | Head | Path scope | Complete |
| --- | --- | --- | --- | --- |
| {{range.repo}} | {{range.base}} ({{range.baseSha}}) | {{range.head}} ({{range.headSha}}) | {{range.include}} | {{range.baseIsAncestorOfHead}} |

Verified work items: {{summary.itemsLinked}} of {{summary.items}}.

## Verified contents

| Item | Title | Commits |
| --- | --- | --- |
| {{item.id}} | {{item.title}} | {{item.commits.length}} |

## Reconciliation result

| Finding | Count | Disposition (from notes.json) |
| --- | --- | --- |
| Commits with no reference | {{summary.noReference}} | |
| Commits referencing other releases | {{summary.unknownReference}} | |
| Items claimed with no code | {{summary.itemsWithoutCommits}} | |
| Incomplete ranges | {{summary.rangeDivergence}} | |
| Commits ignored by rule | {{summary.commitsIgnored}} | |

## Risk

State the risk implied by the reconciliation result. An unresolved
`unknown-reference` is an unassessed change in the release and must be named here.
An incomplete range means the artifact does not describe everything that shipped.

## Rollback

(Operator-supplied. Do not invent.)

## Evidence

(Operator-supplied test evidence. Do not invent.)
