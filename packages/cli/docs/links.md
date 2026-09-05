# Link Templates

Link templates turn commit SHAs and reference tokens in the reconciliation
report into clickable URLs. They are part of the adopter's configuration, not
the changeset, because they describe where the source code is hosted — a detail
the reconciliation engine does not infer.

## Config shape

Add a `links` object to `shipledger.config.json`:

```json
{
  "version": 1,
  "preset": "tracker-keys@1",
  "repos": [
    { "name": "backend", "path": "../backend" },
    { "name": "frontend", "path": "../frontend" }
  ],
  "links": {
    "references": {
      "ticket-key": "https://tracker.example.com/browse/{token}"
    },
    "repos": {
      "backend": {
        "commit": "https://github.com/example/backend/commit/{sha}",
        "references": {
          "pr-ref": {
            "url": "https://github.com/example/backend/pull/{token}",
            "tokenReplace": ["^#", ""]
          }
        }
      },
      "frontend": {
        "commit": "https://github.com/example/frontend/commit/{sha}"
      }
    }
  }
}
```

### Global vs repo-scoped references

Matcher namespace determines where a reference template belongs:

| Namespace | Placement | Example |
| --- | --- | --- |
| `global` | `links.references.<matcher>` | `ticket-key` — same tracker URL for all repos |
| `repo` | `links.repos.<repo>.references.<matcher>` | `pr-ref` — different forge per repo |

A global matcher placed under `links.repos` or a repo-scoped matcher at
`links.references` is rejected during config validation.

### String shorthand

A reference template can be a plain string (URL only) or an object with `url`
and optional `tokenReplace`:

```json
"ticket-key": "https://tracker.example.com/browse/{token}"
```

is equivalent to:

```json
"ticket-key": { "url": "https://tracker.example.com/browse/{token}" }
```

## Placeholders

Two placeholders are recognized:

| Placeholder | Used in | Substituted with |
| --- | --- | --- |
| `{sha}` | `repos.<repo>.commit` | The full 40-character commit SHA |
| `{token}` | `references.<matcher>` | The matched reference token |

Values are `encodeURIComponent`-encoded before interpolation to produce safe
URLs.

Every template must contain its expected placeholder. A static URL (no
placeholder) is rejected during config validation and ignored during rendering.

Unknown placeholders like `{branch}` are rejected. Malformed brace expressions
like `{sha-1}`, `{}`, or bare `{` are also rejected.

## tokenReplace

A `[pattern, replacement]` pair applied to the token value before URL
interpolation. The pattern is a JavaScript regular expression.

Common use case — PR references carry the `#` prefix (`#312`), but the forge URL
needs the bare number:

```json
"pr-ref": {
  "url": "https://github.com/example/repo/pull/{token}",
  "tokenReplace": ["^#", ""]
}
```

An invalid regex pattern is rejected during config validation. If an artifact
somehow carries an invalid pattern, the renderer falls back to plain text.

## Fingerprint and verified-artifact binding

Link templates participate in the config fingerprint (`configFingerprint` in the
verified changeset). Changing a link template changes the fingerprint.

When `--verify-against-repos` is used, the link metadata embedded in the
verified artifact is compared against the config's resolved links. A mismatch —
a changed destination URL or tokenReplace — fails verification, even when the
checkout paths differ.

Links are excluded from the reconciliation re-derivation comparison because they
are config metadata, not git-derived data. The separate binding check ensures
they cannot be tampered with in the artifact.

## HTTP/HTTPS and credential restrictions

Templates must use `http:` or `https:` protocol. Other protocols (`javascript:`,
`ftp:`, `data:`) are rejected during both config validation and rendering.

Templates must not contain credentials (`https://user:pass@host/...`).

Control characters in templates are rejected.

## Plain-text fallback

The renderer never errors on link metadata. If a template is missing, invalid,
or produces a URL that fails safety checks, the SHA or token is rendered as
plain text — the same output as if no links were configured.

Specifically, the renderer falls back to plain text when:

- No `links` object exists
- The repo or matcher has no template
- The template is static (no placeholder substitutions)
- The template contains malformed braces after expansion
- The expanded URL is not valid HTTP/HTTPS
- The tokenReplace pattern is an invalid regex

## Doctor output

When links are configured, `shipledger doctor` includes them in the effective
config output, marked as `[adopter]`:

```
effective config:
  matchers [preset]: [...]
  history  [preset]: "first-parent"
  ignore   [preset]: {...}
  policy   [adopter override]: {...}
  links    [adopter]: {"references":{"ticket-key":{"url":"https://.../{token}"}},...}
```

Links are always adopter configuration — presets do not define them.
