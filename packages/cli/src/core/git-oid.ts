/**
 * Canonical Git object-id (commit) validator — the single source of truth for
 * what counts as a well-formed commit id anywhere in the CLI.
 *
 * Git supports two object formats:
 *   - SHA-1   → 40 lowercase hex characters
 *   - SHA-256 → 64 lowercase hex characters
 *
 * Both are accepted. Any other shape (short ids, uppercase, refs, error text,
 * empty) is rejected so callers never treat unverified junk as a commit.
 */
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isGitOid(value: unknown): value is string {
  return typeof value === 'string' && GIT_OID_PATTERN.test(value);
}
