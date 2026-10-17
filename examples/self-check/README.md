# Self-check: shipledger's own v0.4.0 release

This example checks a real claim against real history: the
[v0.4.0 release notes](https://github.com/kacxx/shipledger/releases/tag/v0.4.0)
against the range `v0.3.5..v0.4.0` of this repository. `repos[0].path` is
`../..`, so the config points at the clone you run it from. Tags are protected,
so the range and its result can't move.

The range holds eight squash-merged commits on the first-parent history:

| Commit subject | In the notes? |
| --- | --- |
| `feat: add extendIgnore to add ignore rules without restating the preset (#63)` | yes |
| `feat: allow one unknownReference note to cover a whole commit (#64)` | yes |
| `fix: escape Markdown in changelog and release-notes output (#62)` | yes |
| `fix: include the README in the npm package (#57)` | yes |
| `test: give git-backed tests 30 s before timing out (#61)` | no, `test` is hidden |
| `docs(skill): map questions to commands and list what to leave to the user (#55)` | no, `docs` is hidden |
| `docs: guide the skill on claims built from generated release notes (#54)` | no, `docs` is hidden |
| `chore(main): release 0.4.0 (#58)` | no, and `github-oss@3` ignores it |

From the repository root, with the full history and tags (a plain `git clone`
has both):

```bash
npm ci && npm run build
node packages/cli/dist/cli/index.js check \
  --config examples/self-check/shipledger.config.json \
  --changeset examples/self-check/changeset.notes-only.json
```

`changeset.notes-only.json` claims the four pull requests the notes list. It
fails, exit code 1, on the three hidden ones:

```
FAIL  v0.4.0 release notes  unknown-reference=3; items linked 4/4, commits 8, ignored 1
  unknown-reference  shipledger 176e565  test: give git-backed tests 30 s before timing out (#61)
  unknown-reference  shipledger f71d610  docs(skill): map questions to commands and list what to leave to the user (#55)
  unknown-reference  shipledger 04194dc  docs: guide the skill on claims built from generated release notes (#54)
Wrote verified-changeset.json
```

`changeset.json` adds those three as items, after confirming that each one's
type is hidden and that none changes CLI code or output: `#61` changes the test
configuration, `#55` and `#54` the skill's documentation. It passes, exit
code 0:

```
PASS  v0.4.0 release notes + hidden sections  items linked 7/7, commits 8, ignored 1
Wrote verified-changeset.json
```

`#39`, `#44`, `#35` and `#56` appear only in commit bodies (`Closes #39`).
Each of those commits also has a claimed reference in its subject, so
`github-oss@3` treats the body reference as context, and the report marks it
`context, not claimed`.

`render report --verify-against-repos --config examples/self-check/shipledger.config.json`
then re-derives the artifact from git and renders it only if the two agree.
This is the same situation as [`../release-please/`](../release-please/), on a
real release instead of a synthetic one.
