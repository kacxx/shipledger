# Deterministic test fixtures

## What the fixture contains

`deterministic.bundle` is a git bundle containing a small repository with two
tags (`v1.0.0` and `v1.1.0`) and a handful of commits between them. The commits
exercise every code path in the reconciler: matched ticket keys, pull-request
references, unmatched references, commits with no reference at all, ignored
authors, and path-filtered packages.

## Determinism

All SHAs are deterministic because every input that affects them is fixed:

- author name and email (`Fixture` / `fixture@example.invalid`)
- committer name and email (same)
- author date and committer date (`2026-01-01T00:00:00+0000`)
- commit message (literal strings in the script)
- file content (the commit subject echoed into each file)
- parent chain (linear history, always on `main`)
- tree structure (fixed file paths)

As long as git uses the same object format (SHA-1), the SHAs will be identical
on any machine.

## Regenerating

Run the generator script from the repository root:

```bash
bash fixtures/make-bundle.sh
```

This overwrites both `deterministic.bundle` and `expected.json`. Commit both
files together.

## `expected.json`

This file is the committed source of truth for SHA assertions in the end-to-end
tests. Each entry records the full 40-character SHA, the author name, and the
commit subject. The test suite reads these SHAs at runtime and uses them to
verify that the reconciler resolves tags, walks commits, and links items to the
exact expected commits.
