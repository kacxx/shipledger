import { envError } from '../errors.js';
import { gitOut } from './exec.js';
import { isGitSha } from './sha.js';
import type { CommitRecord, HistoryMode, RangeResult } from '../types.js';

const FIELDS = 5;
const FORMAT = ['%H', '%an', '%cI', '%s', '%b'].join('%x00') + '%x00';

export function parseLogOutput(raw: string, repo: string, repoPath: string): CommitRecord[] {
  const fail = (why: string): never => {
    throw envError(`Unparseable git log output for repo "${repo}" in ${repoPath}: ${why}. This is a bug or a git version difference — the count cannot be trusted, so nothing is reported.`);
  };

  const parts = raw.split('\0');
  const tail = parts.pop();
  if (tail !== undefined && tail.trim() !== '') {
    fail(`unexpected trailing data after the final record (${JSON.stringify(tail.slice(0, 40))})`);
  }
  if (parts.length % FIELDS !== 0) {
    fail(`got ${parts.length} field(s), which is not a multiple of ${FIELDS}`);
  }

  const out: CommitRecord[] = [];
  for (let i = 0; i < parts.length; i += FIELDS) {
    const sha = (parts[i] as string).trim();
    if (!isGitSha(sha)) {
      fail(`expected a commit sha in field ${i}, got ${JSON.stringify(sha.slice(0, 48))}`);
    }
    out.push({
      repo,
      sha,
      author: parts[i + 1] as string,
      committedAt: parts[i + 2] as string,
      subject: parts[i + 3] as string,
      body: parts[i + 4] as string
    });
  }
  return out;
}

export function walkRange(range: RangeResult, repoPath: string, history: HistoryMode): CommitRecord[] {
  const args = ['log', `--format=${FORMAT}`];
  if (history === 'first-parent') args.push('--first-parent');
  args.push('--end-of-options', `${range.baseSha}..${range.headSha}`);
  if (range.include.length > 0) args.push('--', ...range.include);

  return parseLogOutput(gitOut(args, repoPath), range.repo, repoPath);
}
