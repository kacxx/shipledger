# Claims built from release-please notes

release-please writes release notes from conventional commit subjects, and
`changelog-sections` in `release-please-config.json` hides some types
(`docs`, `ci`, `chore` and others). A merged `docs:` PR therefore ships in the
range but is absent from the notes.

The range `v1.3.0..v1.4.0` in `repo-a` holds four squash-merged commits:

| Commit subject | In the notes? |
| --- | --- |
| `feat: add a summary line to check (#12)` | yes |
| `docs: explain the summary line (#13)` | no, `docs` is hidden |
| `fix: handle an empty range (#14)` | yes |
| `chore(main): release 1.4.0 (#15)` | no, and `github-oss@3` ignores it |

- `changeset.notes-only.json` claims what the notes list. `check` fails with
  `unknown-reference` on `#13`, and that finding is correct: the claim is
  incomplete.
- `changeset.json` adds `#13` as an item, after confirming that its type is
  hidden and that it changes no shipped code. `check` passes.

Adding the hidden PR is claim hygiene, not missing work. Don't add an ignore
rule for hidden types instead: a subject can't show that a `docs:` PR changes no
output. The skill's Step 1 describes the full procedure.
