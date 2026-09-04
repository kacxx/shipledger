import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { envError } from '../errors.js';
import { gitOut, gitStatus } from './exec.js';
import { isGitSha } from './sha.js';
import type { RangeResult, RangeSpec } from '../types.js';

/**
 * Two paths for the same directory must compare equal even when they reach it
 * differently. `git rev-parse --show-toplevel` prints forward slashes on
 * Windows while Node hands back backslashes, and a Windows temp directory
 * often arrives as an 8.3 short name (RUNNER~1), so the raw strings differ for
 * the same directory. realpathSync.native resolves short names and symlinks;
 * the separator and case folding then make the comparison platform-correct.
 */
const normalize = (p: string): string => {
  let resolved: string;
  try {
    resolved = realpathSync.native(p);
  } catch {
    try { resolved = realpathSync(p); } catch { resolved = p; }
  }
  resolved = resolve(resolved);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
};

export interface DirtyTreeResult {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export function dirtyTree(repoPath: string, includePaths: string[]): DirtyTreeResult {
  const args = [
    '-c', 'core.fsmonitor=false',
    '-c', 'status.renames=copies',
    '--no-optional-locks',
    'status', '--porcelain', '-z', '-u'
  ];
  if (includePaths.length > 0) args.push('--', ...includePaths);
  const out = gitStatus(args, repoPath);
  if (out.code !== 0) {
    throw envError(`git status failed in ${repoPath} (exit ${out.code}): ${out.stderr}`);
  }

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const entries = out.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string;
    if (entry.length < 3) continue;
    const x = entry[0] as string;
    const y = entry[1] as string;
    const file = entry.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
    } else {
      if (x !== ' ' && x !== '?') staged.push(file);
      if (y !== ' ' && y !== '?') unstaged.push(file);
      if ('RC'.includes(x) || 'RC'.includes(y)) i++;
    }
  }
  return { staged, unstaged, untracked };
}

export function assertUsableRepo(repoPath: string, repoName: string): void {
  if (!existsSync(repoPath)) {
    throw envError(`Repo "${repoName}" is configured at ${repoPath}, which does not exist. Clone it there or fix "path" in the config.`);
  }
  const inTree = gitStatus(['rev-parse', '--is-inside-work-tree'], repoPath);
  if (inTree.code !== 0 || inTree.stdout.trim() !== 'true') {
    throw envError(`Repo "${repoName}" at ${repoPath} is not a git work tree.`);
  }
  const toplevel = gitOut(['rev-parse', '--show-toplevel'], repoPath).trim();
  if (normalize(toplevel) !== normalize(repoPath)) {
    throw envError(`Repo "${repoName}" path ${repoPath} is inside a git repository but is not its root (root is ${toplevel}). Point "path" at the repository root so include pathspecs resolve correctly.`);
  }
  if (gitOut(['rev-parse', '--is-shallow-repository'], repoPath).trim() === 'true') {
    throw envError(`Repo "${repoName}" at ${repoPath} is a shallow clone, so a commit range cannot be walked. Run: git -C ${repoPath} fetch --unshallow`);
  }
}

/**
 * Git resolves a bare name by searching these namespaces in order, and
 * `--quiet` silences its ambiguity warning, so without this check a name
 * matching several of them resolves to whichever git happens to prefer.
 */
const REF_NAMESPACES = ['refs/', 'refs/tags/', 'refs/heads/', 'refs/remotes/'];

function assertUnambiguous(ref: string, repoPath: string, repoName: string): void {
  // Only a bare name can be ambiguous; a revision expression resolves one way.
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return;

  const matches: string[] = [];
  const shas = new Set<string>();
  for (const namespace of REF_NAMESPACES) {
    const out = gitStatus(['rev-parse', '--verify', '--quiet', `${namespace}${ref}^{commit}`], repoPath);
    const sha = out.stdout.trim();
    if (out.code === 0 && isGitSha(sha)) {
      matches.push(`${namespace}${ref} (${sha.slice(0, 12)})`);
      shas.add(sha);
    }
  }

  if (shas.size > 1) {
    throw envError(
      `Ref "${ref}" is ambiguous in repo "${repoName}" (${repoPath}): it matches ${matches.join(' and ')}, which are different commits. ` +
      `Name it in full — "refs/tags/${ref}" or "refs/heads/${ref}" — so the range cannot depend on git's resolution order.`
    );
  }
}

function assertNotOption(ref: string): void {
  if (ref.startsWith('-')) {
    throw envError(`Ref "${ref}" starts with a dash and would be interpreted as a git option. Use a full ref path like "refs/tags/${ref}" or rename it.`);
  }
}

function resolveRef(ref: string, repoPath: string, repoName: string): string {
  assertNotOption(ref);
  assertUnambiguous(ref, repoPath, repoName);
  const out = gitStatus(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath);
  const sha = out.stdout.trim();
  if (out.code !== 0 || !isGitSha(sha)) {
    throw envError(`Ref "${ref}" does not resolve to a commit in repo "${repoName}" (${repoPath}). Refs are read locally and never fetched — fetch it yourself if it is missing.`);
  }
  return sha;
}

/**
 * Resolves a name if it unambiguously names one commit, and returns null
 * otherwise. Verification uses this to report whether a ref still points where
 * the artifact says, which is information rather than grounds for failure —
 * a branch moves on legitimately. Null covers both "gone" and "now ambiguous",
 * since neither supports a claim either way.
 */
export function tryResolveRef(ref: string, repoPath: string): string | null {
  if (ref.startsWith('-')) return null;
  try {
    assertUnambiguous(ref, repoPath, '');
  } catch {
    return null;
  }
  const out = gitStatus(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath);
  const sha = out.stdout.trim();
  return out.code === 0 && isGitSha(sha) ? sha : null;
}

/** Asserts a recorded sha is still a commit in this repo, for verification. */
export function assertCommitExists(sha: string, repoPath: string, repoName: string, label: string): void {
  const out = gitStatus(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], repoPath);
  if (out.code !== 0 || out.stdout.trim() !== sha) {
    throw envError(
      `The ${label} sha ${sha} recorded in the artifact is not a commit in repo "${repoName}" (${repoPath}). ` +
      `Either this is the wrong checkout or the commit has been removed from it.`
    );
  }
}

/**
 * The facts about a base/head pair, derived from the shas rather than the ref
 * names. Verification needs these for shas it already has, since the names may
 * legitimately have moved on since the artifact was produced.
 */
export function rangeFactsFor(
  spec: { repo: string; base: string; head: string; include: string[] },
  baseSha: string,
  headSha: string,
  repoPath: string
): RangeResult {
  const mergeBaseResult = gitStatus(['merge-base', baseSha, headSha], repoPath);
  if (mergeBaseResult.code !== 0 && mergeBaseResult.code !== 1) {
    throw envError(`git merge-base failed in ${repoPath} (status ${mergeBaseResult.code}): ${mergeBaseResult.stderr}`);
  }
  const mergeBase = mergeBaseResult.code === 0 ? mergeBaseResult.stdout.trim() : null;

  const ancestry = gitStatus(['merge-base', '--is-ancestor', baseSha, headSha], repoPath);
  if (ancestry.code !== 0 && ancestry.code !== 1) {
    throw envError(`git merge-base --is-ancestor failed in ${repoPath} (status ${ancestry.code}): ${ancestry.stderr}`);
  }
  const baseIsAncestorOfHead = ancestry.code === 0;

  const commitsOnlyInBase = Number(gitOut(['rev-list', '--count', `${headSha}..${baseSha}`], repoPath).trim());

  return {
    repo: spec.repo,
    base: spec.base, baseSha,
    head: spec.head, headSha,
    include: spec.include,
    mergeBase,
    baseIsAncestorOfHead,
    commitsOnlyInBase,
    findings: baseIsAncestorOfHead ? [] : ['range-divergence']
  };
}

export function resolveRange(spec: RangeSpec, repoPath: string): RangeResult {
  const baseSha = resolveRef(spec.base, repoPath, spec.repo);
  const headSha = resolveRef(spec.head, repoPath, spec.repo);
  return rangeFactsFor(
    { repo: spec.repo, base: spec.base, head: spec.head, include: spec.include ?? [] },
    baseSha, headSha, repoPath
  );
}
