/**
 * A full git object name is 40 lowercase hex digits under SHA-1 and 64 under
 * SHA-256. Repositories created with `git init --object-format=sha256` produce
 * the longer form, so anything that validates a sha must accept both or those
 * repositories become unusable.
 */
export const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isGitSha = (sha: string): boolean => GIT_SHA_RE.test(sha);
