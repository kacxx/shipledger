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

SKIP_FILES_RE='(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.tmp/|node_modules/|dist/|\.git/)'

# ---- state ----

fails=0
scanned=0

# ---- core ----

report_hit() {
  printf 'FAIL  [%s]  %s:%s\n' "$1" "$2" "$3"
  fails=$((fails + 1))
}

scan_content() {
  local file="$1"
  local target="${2:-$file}"

  # R1: tracker URLs
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local lineno="${match%%:*}"
    local line="${match#*:}"
    if ! printf '%s' "$line" | grep -qiE 'https?://example\.(atlassian\.net|shortcut\.com|dev\.azure\.com|youtrack\.[a-z]+)'; then
      report_hit "R1-tracker-url" "$file" "$lineno"
    fi
  done < <(grep -niE 'https?://[a-z0-9._-]*\.(atlassian\.net|shortcut\.com|dev\.azure\.com|youtrack\.[a-z]+)|https?://linear\.app/' "$target" 2>/dev/null || true)

  # R2: ticket keys
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local lineno="${match%%:*}"
    local line="${match#*:}"
    if ! printf '%s' "$line" | grep -qiE "\b(${SAFE_KEY_PREFIXES})-[0-9]{1,6}\b"; then
      if ! printf '%s' "$line" | grep -qE 'SAFE_KEY_PREFIXES|safe.key|safe.prefix|product.namespace|GENERICITY'; then
        report_hit "R2-ticket-key" "$file" "$lineno"
      fi
    fi
  done < <(grep -nE '\b[A-Z]{2,10}-[0-9]{1,6}\b' "$target" 2>/dev/null || true)

  # R3: absolute developer paths
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local lineno="${match%%:*}"
    local line="${match#*:}"
    if ! printf '%s' "$line" | grep -qiE "/(Users|home)/(${SAFE_DEV_USERS})/|\\\\Users\\\\(${SAFE_DEV_USERS})\\\\|/home/runner/"; then
      report_hit "R3-dev-path" "$file" "$lineno"
    fi
  done < <(grep -nE '/Users/[a-zA-Z][a-zA-Z0-9._-]+/|/home/[a-zA-Z][a-zA-Z0-9._-]+/|[A-Z]:\\Users\\[a-zA-Z][a-zA-Z0-9._-]+\\' "$target" 2>/dev/null || true)

  # R4: GitHub org/repo references (skip lockfiles entirely)
  if ! printf '%s' "$file" | grep -qE '(package-lock|pnpm-lock|yarn\.lock)'; then
    local safe_gh="kacxx/shipledger|example/|acme/|org/|other/|elsewhere/|actions/|github/"
    local wellknown="nodejs|npm/|isaacs|sindresorhus|epoberezkin|fastify|ajv-validator|eslint|vitest-dev|microsoft|jestjs|chaijs|mochajs|typescriptlang|chalk|yargs|DefinitelyTyped|sponsors|prettier|rollup|vitejs|facebook|vercel|lukeed|ljharb|es-shims|gulpjs|mdn|tc39|web-infra-dev|unjs|antfu|pnpm|webdriverio|standard|feross|substack|browserify|gruntjs|karma-runner|postcss|babel|webpack|lodash|expressjs|koajs|hapijs|angular|sveltejs|vuejs|remix-run|nextjs"
    while IFS= read -r match; do
      [ -z "$match" ] && continue
      local lineno="${match%%:*}"
      local line="${match#*:}"
      if ! printf '%s' "$line" | grep -qiE "github\\.com/(${safe_gh}|${wellknown})"; then
        report_hit "R4-org-repo-ref" "$file" "$lineno"
      fi
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
