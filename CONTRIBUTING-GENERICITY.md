# Genericity policy

Shipledger product repositories must remain **adopter-neutral**. Real adoption
evidence—organization names, tracker URLs, ticket keys, repository references,
developer paths—stays in the adopter's own repositories. Only sanitized
summaries and synthetic examples may be committed here.

## What the scanner checks

| Rule | Detects |
|------|---------|
| R1 | Tenant-specific tracker URLs (Jira, Linear, Shortcut, Azure DevOps, YouTrack) |
| R2 | Ticket-key patterns outside documented product/synthetic namespaces |
| R3 | Absolute developer home-directory paths |
| R4 | GitHub organization/repository references outside the product's own orgs |
| R5 | Private deny patterns supplied via `GENERICITY_DENY_PATTERNS` env var |

Violations report **rule ID, file, and line number only**—matched content is
never printed.

## Safe namespaces

The following ticket-key prefixes are recognized as product-owned or
intentionally synthetic and will not trigger R2:

`PROJ`, `SL`, `WP`, `SHIP`, `OTHER`, `TEST`, `DEMO`, `EXAMPLE`, `OPS`, `DEV`,
`APP`, `HOTEL`, `CONCIERGE`, `SYN`, `JIRA`, `ITEM`, `CLI`, `STATUS`, `ADR`,
`RC`, `SHA`, `PR`, `GHOST`, `RENAMED`, `UTF`, `ISO`, `RFC`, `HTTP`, `TCP`,
`UDP`, `TLS`, `SSL`, `LICENSE`, `APACHE`, `MIT`, `BSD`, `MPL`, `GPL`, `LGPL`,
`CC`

Use these prefixes (or add new ones to the scanner) for examples and test
fixtures.

## Safe GitHub organizations

References to these GitHub orgs/owners are allowed: `kacxx/shipledger*`,
`example/`, `acme/`, `org/`, `other/`, `elsewhere/`, plus common open-source
maintainer orgs.

## Running locally

```bash
bash scripts/genericity-check.sh
```

## Private deny patterns

Set `GENERICITY_DENY_PATTERNS` (newline-separated regexes) in your environment
or as a repository secret. The scanner checks each line against these patterns
but never prints matched content.

## Adding a new safe prefix

If a new synthetic namespace is needed for examples or tests, add it to the
`SAFE_KEY_PREFIXES` variable in `scripts/genericity-check.sh` and to the list
above.
