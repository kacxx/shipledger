#!/usr/bin/env bash
# Tests for genericity-check.sh.
#
# Forbidden synthetic examples are built from fragments at runtime so that
# no complete forbidden value appears in this tracked file.
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
  local output rc
  output=$(printf '%s\n' "$input" | bash "$SCANNER" --stdin "$label" 2>&1) && rc=$? || rc=$?
  if printf '%s' "$output" | grep -qiE '^ERROR|^FATAL'; then
    printf 'FAIL  unexpected ERROR/FATAL for violation: %s\n' "$label"
    printf '      got: %s\n' "$output"
    fail=$((fail + 1))
  elif printf '%s' "$output" | grep -q 'FAIL' && printf '%s' "$output" | grep -q "$expected_rule"; then
    pass=$((pass + 1))
  else
    printf 'FAIL  expected violation [%s]: %s\n' "$expected_rule" "$label"
    printf '      got: %s\n' "$output"
    fail=$((fail + 1))
  fi
}

assert_fatal() {
  local label="$1" input="$2"
  local output rc
  output=$(printf '%s\n' "$input" | bash "$SCANNER" --stdin "$label" 2>&1) && rc=$? || rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$output" | grep -qi 'FATAL\|invalid'; then
    pass=$((pass + 1))
  else
    printf 'FAIL  expected fatal exit: %s\n' "$label"
    printf '      got rc=%s: %s\n' "$rc" "$output"
    fail=$((fail + 1))
  fi
}

# Build forbidden values from fragments at runtime so no complete forbidden
# value (URL, ticket key, path, org reference) appears as a literal here.
# Fragments are chosen so no single fragment matches any scanner rule.
_j1="https://exampleco.atla"     ; _j2="ssian.net/browse/thing"
_l1="https://lin"                ; _l2="ear.app/exampleco/issue/42"
_sc1="https://app.short"         ; _sc2="cut.com/exampleco/story/12345"
_sj1="https://example.atla"     ; _sj2="ssian.net/browse/PROJ-1"
_tk1="ACM"                         ; _tk2="E"    ; _tk3="-1234"
_tk4="MYO"                         ; _tk5="RG"   ; _tk6="-99"
_pm1="/Users/re"                   ; _pm2="aldev/projects/thing"
_pl1="/home/develo"                ; _pl2="per/.config/app"
_pw1='C:\Users\re'                 ; _pw2='aldev\Documents\proj'
_gh1="https://github.com/re"      ; _gh2="alcorp/private-service"
_pc1="https://github.com/example"  ; _pc2="corp/private-service"
_pc3="https://github.com/nodejs"   ; _pc4="evil/backdoor"
_pc5="https://github.com/kacxx"    ; _pc6="leak/stolen-data"

printf '== genericity-check tests ==\n\n'

# ---- R1: tracker URLs ----
assert_violation "R1-jira-url" \
  "see ${_j1}${_j2}" \
  "R1-tracker-url"

assert_violation "R1-linear-url" \
  "tracked at ${_l1}${_l2}" \
  "R1-tracker-url"

assert_violation "R1-shortcut-url" \
  "link: ${_sc1}${_sc2}" \
  "R1-tracker-url"

assert_clean "R1-safe-example-domain" \
  "see ${_sj1}${_sj2}"

# ---- R2: ticket keys ----
assert_violation "R2-unknown-prefix" \
  "fixes ${_tk1}${_tk2}${_tk3} in production" \
  "R2-ticket-key"

assert_violation "R2-unknown-prefix-2" \
  "see ${_tk4}${_tk5}${_tk6} for details" \
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

# ---- R2: mixed safe + unsafe on same line ----
assert_violation "R2-mixed-safe-unsafe" \
  "see PROJ-1 and also ${_tk1}${_tk2}${_tk3}" \
  "R2-ticket-key"

# ---- R2: regression — unsafe key hidden beside GENERICITY text ----
assert_violation "R2-genericity-bypass-regression" \
  "GENERICITY setting ${_tk1}${_tk2}${_tk3}" \
  "R2-ticket-key"

# ---- R3: developer paths ----
assert_violation "R3-macos-path" \
  "config at ${_pm1}${_pm2}" \
  "R3-dev-path"

assert_violation "R3-linux-path" \
  "stored in ${_pl1}${_pl2}" \
  "R3-dev-path"

assert_violation "R3-windows-path" \
  "found at ${_pw1}${_pw2}" \
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

# ---- R3: mixed safe + unsafe on same line ----
assert_violation "R3-mixed-safe-unsafe" \
  "/Users/alice/ok and also ${_pm1}${_pm2}" \
  "R3-dev-path"

# ---- R4: GitHub org/repo references ----
assert_violation "R4-unknown-org" \
  "see ${_gh1}${_gh2}" \
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

# ---- R4: mixed safe + unsafe on same line ----
assert_violation "R4-mixed-safe-unsafe" \
  "https://github.com/kacxx/shipledger and ${_gh1}${_gh2}" \
  "R4-org-repo-ref"

# ---- R4: prefix-collision negative tests ----
assert_violation "R4-prefix-collision-examplecorp" \
  "${_pc1}${_pc2}" \
  "R4-org-repo-ref"

assert_violation "R4-prefix-collision-nodejsevil" \
  "${_pc3}${_pc4}" \
  "R4-org-repo-ref"

assert_violation "R4-prefix-collision-kacxxleak" \
  "${_pc5}${_pc6}" \
  "R4-org-repo-ref"

# ---- R5: private deny patterns ----
_r5a="example"  ; _r5b="co-secret"
GENERICITY_DENY_PATTERNS="${_r5a}${_r5b}" \
  assert_violation "R5-env-pattern" \
  "mentions ${_r5a}${_r5b}-thing" \
  "R5-deny-pattern"

GENERICITY_DENY_PATTERNS="${_r5a}${_r5b}" \
  assert_clean "R5-valid-pattern-no-match" \
  "totally unrelated content here"

GENERICITY_DENY_PATTERNS="" \
  assert_clean "R5-no-env-pattern" \
  "mentions ${_r5a}${_r5b}-thing"

# ---- R5: invalid regex fails closed ----
GENERICITY_DENY_PATTERNS='[invalid((' \
  assert_fatal "R5-invalid-regex" \
  "harmless content"

# ---- R1+R2 mixed: tracker URL + safe key on same line ----
assert_violation "R1-mixed-with-safe-key" \
  "PROJ-1 see ${_j1}${_j2}" \
  "R1-tracker-url"

# ---- summary ----
printf '\n%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
printf 'all tests passed\n'
