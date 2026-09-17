#!/usr/bin/env bash
# Tests for genericity-check.sh using only synthetic identifiers.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCANNER="${SCRIPT_DIR}/genericity-check.sh"

pass=0
fail=0

assert_clean() {
  local label="$1" input="$2"
  if printf '%s\n' "$input" | bash "$SCANNER" --stdin "$label" >/dev/null 2>&1; then
    pass=$((pass + 1))
  else
    printf 'FAIL  expected clean: %s\n' "$label"
    fail=$((fail + 1))
  fi
}

assert_violation() {
  local label="$1" input="$2" expected_rule="$3"
  local output
  output=$(printf '%s\n' "$input" | bash "$SCANNER" --stdin "$label" 2>&1) || true
  if printf '%s' "$output" | grep -q "$expected_rule"; then
    pass=$((pass + 1))
  else
    printf 'FAIL  expected violation [%s]: %s\n' "$expected_rule" "$label"
    printf '      got: %s\n' "$output"
    fail=$((fail + 1))
  fi
}

printf '== genericity-check tests ==\n\n'

# ---- R1: tracker URLs ----
assert_violation "R1-jira-url" \
  "see https://exampleco.atlassian.net/browse/ABC-123" \
  "R1-tracker-url"

assert_violation "R1-linear-url" \
  "tracked at https://linear.app/exampleco/issue/EX-42" \
  "R1-tracker-url"

assert_violation "R1-shortcut-url" \
  "link: https://app.shortcut.com/exampleco/story/12345" \
  "R1-tracker-url"

assert_clean "R1-safe-example-domain" \
  "see https://example.atlassian.net/browse/PROJ-1"

# ---- R2: ticket keys ----
assert_violation "R2-unknown-prefix" \
  "fixes ACME-1234 in production" \
  "R2-ticket-key"

assert_violation "R2-unknown-prefix-2" \
  "see MYORG-99 for details" \
  "R2-ticket-key"

assert_clean "R2-safe-PROJ" \
  "related to PROJ-1234"

assert_clean "R2-safe-SHIP" \
  "implements SHIP-42"

assert_clean "R2-safe-WP" \
  "see WP-007 work package"

assert_clean "R2-safe-SL" \
  "ledger entry SL-100"

assert_clean "R2-safe-OPS" \
  "operational item OPS-2201"

assert_clean "R2-safe-DEV" \
  "development task DEV-3301"

assert_clean "R2-safe-HOTEL" \
  "fixture key HOTEL-1"

assert_clean "R2-safe-DEMO" \
  "demo ticket DEMO-5"

# ---- R3: developer paths ----
assert_violation "R3-macos-path" \
  "config at /Users/realdev/projects/thing" \
  "R3-dev-path"

assert_violation "R3-linux-path" \
  "stored in /home/developer/.config/app" \
  "R3-dev-path"

assert_violation "R3-windows-path" \
  'found at C:\Users\realdev\Documents\project' \
  "R3-dev-path"

assert_clean "R3-safe-alice" \
  "test path /Users/alice/project"

assert_clean "R3-safe-bob" \
  "fixture /home/bob/.config"

assert_clean "R3-safe-test" \
  "stored at /home/test/dossier/artifact.json"

assert_clean "R3-safe-ci" \
  "path /Users/ci/builds/output"

assert_clean "R3-safe-runner" \
  "GitHub Actions /home/runner/work/repo"

# ---- R4: GitHub org/repo references ----
assert_violation "R4-unknown-org" \
  "see https://github.com/realcorp/private-service" \
  "R4-org-repo-ref"

assert_clean "R4-safe-product-repo" \
  "see https://github.com/kacxx/shipledger"

assert_clean "R4-safe-product-repo-2" \
  "see https://github.com/kacxx/shipledger-release-control"

assert_clean "R4-safe-example-org" \
  "see https://github.com/example/repo-a"

assert_clean "R4-safe-acme" \
  "see https://github.com/acme/hotel-booking"

assert_clean "R4-safe-actions" \
  "uses: actions/checkout@v4"

# ---- R5: private deny patterns ----
GENERICITY_DENY_PATTERNS="exampleco-secret" \
  assert_violation "R5-env-pattern" \
  "mentions exampleco-secret-thing" \
  "R5-deny-pattern"

assert_clean "R5-no-env-pattern" \
  "mentions exampleco-secret-thing"

# ---- summary ----
printf '\n%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
printf 'all tests passed\n'
