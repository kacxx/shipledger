#!/usr/bin/env bash
# Builds fixtures/deterministic.bundle and fixtures/expected.json.
# Every input is fixed, so the commit SHAs are reproducible on any machine with
# the same git object format. Re-run only when the fixture shape must change,
# then commit both outputs.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$HERE/deterministic.bundle"
EXPECTED="$HERE/expected.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_AUTHOR_DATE='2026-01-01T00:00:00+0000'
export GIT_COMMITTER_DATE='2026-01-01T00:00:00+0000'
export GIT_AUTHOR_NAME='Fixture'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

R="$TMP/repo"
git init -q "$R"
git -C "$R" checkout -q -b main 2>/dev/null || true
git -C "$R" config user.name  "$GIT_AUTHOR_NAME"
git -C "$R" config user.email "$GIT_AUTHOR_EMAIL"
git -C "$R" config commit.gpgsign false

commit() { # subject path [author]
  local subject="$1" path="$2" author="${3:-$GIT_AUTHOR_NAME}"
  mkdir -p "$R/$(dirname "$path")"
  printf '%s\n' "$subject" > "$R/$path"
  git -C "$R" add "$path"
  GIT_AUTHOR_NAME="$author" git -C "$R" commit -q -m "$subject"
}

commit 'initial commit' 'file.txt'
git -C "$R" tag v1.0.0

commit 'PROJ-1: add the widget (#11)'       'packages/a/widget.txt'
commit 'PROJ-2: fix the gadget (#12)'       'packages/a/gadget.txt'
commit 'PROJ-9: unrelated work (#13)'       'packages/a/other.txt'
commit 'chore: reformat everything'         'packages/a/format.txt'
commit 'docs: only touches package b (#14)' 'packages/b/readme.txt'
commit 'chore(deps): bump left-pad'         'packages/a/vendor.txt' 'dependabot[bot]'
git -C "$R" tag v1.1.0

git -C "$R" bundle create "$BUNDLE" --all

git -C "$R" log --reverse --format='%H%x09%an%x09%s' v1.0.0..v1.1.0 | awk -F'\t' '
  BEGIN { print "{"; print "  \"tags\": { \"base\": \"v1.0.0\", \"head\": \"v1.1.0\" },"; print "  \"commits\": [" }
  {
    s = $3; gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s);
    a = $2; gsub(/\\/, "\\\\", a); gsub(/"/, "\\\"", a);
    rows[NR] = sprintf("    { \"sha\": \"%s\", \"author\": \"%s\", \"subject\": \"%s\" }", $1, a, s)
  }
  END {
    for (i = 1; i <= NR; i++) printf "%s%s\n", rows[i], (i < NR ? "," : "");
    print "  ]"; print "}"
  }' > "$EXPECTED"

echo "Wrote $BUNDLE"
echo "Wrote $EXPECTED"
cat "$EXPECTED"
