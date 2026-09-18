import { envError } from '../errors.js';
import { gitOut } from './exec.js';
import type { DeltaEntry, DeltaStatus } from '../types.js';

const SUPPORTED: ReadonlySet<string> = new Set<DeltaStatus>(['A', 'M', 'D', 'T']);

/**
 * Parses `git diff --name-status -z` output into one constrained status per path.
 * The stream is `<status>\0<path>\0` repeated, so records are status/path pairs;
 * `--no-renames` upstream guarantees a single path per record. Rename detection
 * is not decoded here — an `R`/`C` status is treated as unknown and rejected, so
 * a caller that forgot `--no-renames` fails loudly rather than silently dropping
 * the second path. Any status outside the supported set, or a dangling token,
 * takes the environment-error path: the delta cannot be trusted, so nothing is
 * reported.
 */
export function parseNameStatusZ(raw: string, repo: string, repoPath: string): DeltaEntry[] {
  const fail = (why: string): never => {
    throw envError(`Unparseable git diff output for repo "${repo}" in ${repoPath}: ${why}. This is a bug, a git version difference, or rename detection left enabled — the delta cannot be trusted, so nothing is reported.`);
  };

  if (raw === '') return [];

  const parts = raw.split('\0');
  const tail = parts.pop();
  if (tail !== undefined && tail !== '') {
    fail(`unexpected trailing data after the final record (${JSON.stringify(tail.slice(0, 40))})`);
  }
  if (parts.length % 2 !== 0) {
    fail(`got ${parts.length} token(s), which is not a whole number of status/path pairs`);
  }

  const out: DeltaEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i] as string;
    const path = parts[i + 1] as string;
    if (!SUPPORTED.has(status)) {
      fail(`unsupported status ${JSON.stringify(status.slice(0, 16))} for a path`);
    }
    if (path === '') fail(`empty path for status ${status}`);
    out.push({ status: status as DeltaStatus, path });
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * The effective file-list delta of two trees, network-free and read-only:
 * `git diff --name-status --no-renames -z --end-of-options <base> <head> -- <include...>`.
 * A file-list fact only — it never reconstructs which commit authored a change.
 */
export function effectiveDeltaFor(
  baseSha: string, headSha: string, include: string[], repo: string, repoPath: string
): DeltaEntry[] {
  const args = ['diff', '--name-status', '--no-renames', '-z', '--end-of-options', baseSha, headSha];
  if (include.length > 0) args.push('--', ...include);
  return parseNameStatusZ(gitOut(args, repoPath), repo, repoPath);
}
