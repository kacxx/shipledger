import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { envError } from '../errors.js';
import { gitOut, gitStatus } from './exec.js';
import type { RangeResult, RangeSpec } from '../types.js';

const normalize = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

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

function resolveRef(ref: string, repoPath: string, repoName: string): string {
  const out = gitStatus(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath);
  const sha = out.stdout.trim();
  if (out.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw envError(`Ref "${ref}" does not resolve to a commit in repo "${repoName}" (${repoPath}). Refs are read locally and never fetched — fetch it yourself if it is missing.`);
  }
  return sha;
}

export function resolveRange(spec: RangeSpec, repoPath: string): RangeResult {
  const baseSha = resolveRef(spec.base, repoPath, spec.repo);
  const headSha = resolveRef(spec.head, repoPath, spec.repo);

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
    include: spec.include ?? [],
    mergeBase,
    baseIsAncestorOfHead,
    commitsOnlyInBase,
    findings: baseIsAncestorOfHead ? [] : ['range-divergence']
  };
}
