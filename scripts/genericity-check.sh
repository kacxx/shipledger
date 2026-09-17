#!/usr/bin/env bash
# genericity-check.sh — detect adopter-specific content in product repositories.
# Reports rule ID, file, and line number only — never echoes matched content.
#
# Usage:
#   ./scripts/genericity-check.sh              # scan all tracked files
#   ./scripts/genericity-check.sh --diff REF   # scan lines changed since REF
#   echo "text" | ./scripts/genericity-check.sh --stdin label
#
# Environment:
#   GENERICITY_DENY_PATTERNS  newline-separated extra regex patterns (optional)
#   GENERICITY_EXTRA_SAFE_KEYS  extra pipe-separated safe ticket prefixes (optional)
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# ---- safe-list configuration ----

SAFE_KEY_PREFIXES="PROJ|SL|WP|SHIP|OTHER|TEST|DEMO|EXAMPLE|OPS|DEV|APP|HOTEL|CONCIERGE|SYN|JIRA|ITEM|CLI|STATUS|ADR|RC|SHA|PR|GHOST|RENAMED|UTF|ISO|RFC|HTTP|TCP|UDP|TLS|SSL|LICENSE|APACHE|MIT|BSD|MPL|GPL|LGPL|CC"
if [ -n "${GENERICITY_EXTRA_SAFE_KEYS:-}" ]; then
  SAFE_KEY_PREFIXES="${SAFE_KEY_PREFIXES}|${GENERICITY_EXTRA_SAFE_KEYS}"
fi

SAFE_DEV_USERS="alice|bob|ci|test|example|runner|actions|user"
SAFE_GITHUB_OWNERS="kacxx|example|acme|org|other|elsewhere|actions|github|nodejs|npm|isaacs|sindresorhus|epoberezkin|fastify|ajv-validator|eslint|vitest-dev|microsoft|jestjs|chaijs|mochajs|typescriptlang|chalk|yargs|DefinitelyTyped|sponsors|prettier|rollup|vitejs|facebook|vercel|lukeed|ljharb|es-shims|gulpjs|mdn|tc39|web-infra-dev|unjs|antfu|pnpm|webdriverio|standard|feross|substack|browserify|gruntjs|karma-runner|postcss|babel|webpack|lodash|expressjs|koajs|hapijs|angular|sveltejs|vuejs|remix-run|nextjs"

SKIP_FILES_RE='(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.tmp/|node_modules/|dist/|\.git/)'

# ---- state ----

fails=0
scanned=0

# ---- helpers ----

report_hit() {
  printf 'FAIL  [%s]  %s:%s\n' "$1" "$2" "$3"
  fails=$((fails + 1))
}

# Validate R5 patterns eagerly: an invalid regex must fail closed.
validate_deny_patterns() {
  if [ -z "${GENERICITY_DENY_PATTERNS:-}" ]; then
    return 0
  fi
  local bad=0
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    local grc
    printf '' | grep -iE "$pat" >/dev/null 2>&1 && grc=$? || grc=$?
    if [ "$grc" -eq 2 ]; then
      printf 'ERROR  [R5-deny-pattern]  invalid regex: (pattern not printed)\n'
      bad=1
    fi
  done <<< "$GENERICITY_DENY_PATTERNS"
  if [ "$bad" -ne 0 ]; then
    printf 'FATAL  invalid GENERICITY_DENY_PATTERNS — failing closed\n'
    exit 1
  fi
}

# ---- per-rule file scanning (per-token validation) ----

scan_content() {
  local file="$1"
  local target="${2:-$file}"

  # R1: tracker URLs — extract each URL token, check independently
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local lineno="${match%%:*}"
    local line="${match#*:}"
    local urls
    urls=$(printf '%s' "$line" | grep -oiE 'https?://[a-z0-9._-]*\.(atlassian\.net|shortcut\.com|dev\.azure\.com|youtrack\.[a-z]+)[^ ]*|https?://linear\.app/[^ ]*' 2>/dev/null || true)
    while IFS= read -r url; do
      [ -z "$url" ] && continue
      if ! printf '%s' "$url" | grep -qiE '://example\.(atlassian\.net|shortcut\.com|dev\.azure\.com|youtrack\.[a-z]+)'; then
        report_hit "R1-tracker-url" "$file" "$lineno"
        break
      fi
    done <<< "$urls"
  done < <(grep -niE 'atlassian\.net|shortcut\.com|dev\.azure\.com|youtrack\.|linear\.app/' "$target" 2>/dev/null || true)

  # R2: ticket keys — extract each token, check independently
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local lineno="${match%%:*}"
    local line="${match#*:}"
    local keys
    keys=$(printf '%s' "$line" | grep -oE '\b[A-Z]{2,10}-[0-9]{1,6}\b' 2>/dev/null || true)
    while IFS= read -r key; do
      [ -z "$key" ] && continue
      if ! printf '%s' "$key" | grep -qiE "^(${SAFE_KEY_PREFIXES})-[0-9]{1,6}$"; then
        report_hit "R2-ticket-key" "$file" "$lineno"
        break
      fi
    done <<< "$keys"
  done < <(grep -nE '\b[A-Z]{2,10}-[0-9]{1,6}\b' "$target" 2>/dev/null || true)

  # R3: developer paths — extract each path token, check independently
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local lineno="${match%%:*}"
    local line="${match#*:}"
    local paths
    paths=$(printf '%s' "$line" | grep -oE '/Users/[a-zA-Z][a-zA-Z0-9._-]+/|/home/[a-zA-Z][a-zA-Z0-9._-]+/|[A-Z]:\\Users\\[a-zA-Z][a-zA-Z0-9._-]+\\' 2>/dev/null || true)
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      if ! printf '%s' "$p" | grep -qiE "/(Users|home)/(${SAFE_DEV_USERS})/|\\\\Users\\\\(${SAFE_DEV_USERS})\\\\|/home/runner/"; then
        report_hit "R3-dev-path" "$file" "$lineno"
        break
      fi
    done <<< "$paths"
  done < <(grep -nE '/Users/[a-zA-Z][a-zA-Z0-9._-]+/|/home/[a-zA-Z][a-zA-Z0-9._-]+/|[A-Z]:\\Users\\[a-zA-Z][a-zA-Z0-9._-]+\\' "$target" 2>/dev/null || true)

  # R4: GitHub org/repo references — extract owner, exact match against allowlist
  if ! printf '%s' "$file" | grep -qE '(package-lock|pnpm-lock|yarn\.lock)'; then
    while IFS= read -r match; do
      [ -z "$match" ] && continue
      local lineno="${match%%:*}"
      local line="${match#*:}"
      local refs
      refs=$(printf '%s' "$line" | grep -oE 'github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+' 2>/dev/null || true)
      while IFS= read -r ref; do
        [ -z "$ref" ] && continue
        local owner
        owner=$(printf '%s' "$ref" | sed 's|.*github\.com/||' | cut -d/ -f1)
        if ! printf '%s' "$owner" | grep -qiE "^(${SAFE_GITHUB_OWNERS})$"; then
          report_hit "R4-org-repo-ref" "$file" "$lineno"
          break
        fi
      done <<< "$refs"
    done < <(grep -nE 'github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+' "$target" 2>/dev/null || true)
  fi

  # R5: private deny patterns
  if [ -n "${GENERICITY_DENY_PATTERNS:-}" ]; then
    while IFS= read -r pat; do
      [ -z "$pat" ] && continue
      while IFS= read -r match; do
        [ -z "$match" ] && continue
        local lineno="${match%%:*}"
        report_hit "R5-deny-pattern" "$file" "$lineno"
      done < <(grep -niE "$pat" "$target" 2>/dev/null || true)
    done <<< "$GENERICITY_DENY_PATTERNS"
  fi
}

# ---- modes ----

scan_tracked() {
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    [ ! -f "$file" ] && continue
    printf '%s' "$file" | grep -qE "$SKIP_FILES_RE" && continue
    if file --mime-type "$file" 2>/dev/null | grep -qvE 'text/|application/json|application/javascript'; then
      continue
    fi
    scanned=$((scanned + 1))
    scan_content "$file"
  done < <(git ls-files -- . | grep -vE "$SKIP_FILES_RE" || true)
}

scan_diff() {
  local ref="$1"
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    [ ! -f "$file" ] && continue
    printf '%s' "$file" | grep -qE "$SKIP_FILES_RE" && continue
    scanned=$((scanned + 1))
    local tmpf
    tmpf=$(mktemp)
    git diff "$ref" -- "$file" 2>/dev/null \
      | grep '^+[^+]' \
      | sed 's/^+//' > "$tmpf"
    if [ -s "$tmpf" ]; then
      scan_content "$file" "$tmpf"
    fi
    rm -f "$tmpf"
  done < <(git diff --name-only --diff-filter=d "$ref" -- . \
    | grep -vE "$SKIP_FILES_RE" || true)
}

scan_stdin() {
  local label="${1:-stdin}"
  local tmpf
  tmpf=$(mktemp)
  cat > "$tmpf"
  if [ -s "$tmpf" ]; then
    scan_content "$label" "$tmpf"
  fi
  rm -f "$tmpf"
}

# ---- main ----

validate_deny_patterns

printf '== genericity check ==\n'

case "${1:-}" in
  --diff)
    [ -z "${2:-}" ] && { printf 'error: --diff requires a ref\n'; exit 2; }
    scan_diff "$2"
    ;;
  --stdin)
    scan_stdin "${2:-stdin}"
    ;;
  *)
    scan_tracked
    ;;
esac

printf '\nScanned %d file(s). ' "$scanned"
if [ "$fails" -ne 0 ]; then
  printf '%d genericity violation(s) found.\n' "$fails"
  exit 1
fi
printf 'No genericity violations found.\n'
exit 0
