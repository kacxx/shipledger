import { describe, it, expect } from 'vitest';
import { matchIgnoreRule, commitFindings, summarise, decideVerdict } from '../../src/core/findings.js';
import { compileIgnore } from '../../src/core/compile.js';
import type { CommitRecord, CommitResult, ItemResult, RangeResult, Reference } from '../../src/types.js';

const ignore = compileIgnore({ authors: ['dependabot[bot]'], subjects: ['^Merge branch'] });

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    repo: 'repo-a', sha: 'a'.repeat(40), subject: 'tidy', body: '',
    author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
  };
}

const ref = (resolvesTo: string[]): Reference => ({
  matcher: 'ticket-key', token: 'PROJ-1', namespace: 'global', sources: ['subject'], resolvesTo
});

describe('matchIgnoreRule', () => {
  it('returns null when nothing matches', () => {
    expect(matchIgnoreRule(commit(), ignore)).toBeNull();
  });

  it('matches an author by exact name', () => {
    expect(matchIgnoreRule(commit({ author: 'dependabot[bot]' }), ignore)).toBe('authors:dependabot[bot]');
  });

  it('does not match an author by substring', () => {
    expect(matchIgnoreRule(commit({ author: 'not-dependabot[bot]-really' }), ignore)).toBeNull();
  });

  it('does not treat an author entry as a regex', () => {
    const dotIgnore = compileIgnore({ authors: ['a.c'], subjects: [] });
    expect(matchIgnoreRule(commit({ author: 'abc' }), dotIgnore)).toBeNull();
    expect(matchIgnoreRule(commit({ author: 'a.c' }), dotIgnore)).toBe('authors:a.c');
  });

  it('matches a subject by regex', () => {
    expect(matchIgnoreRule(commit({ subject: 'Merge branch main' }), ignore)).toBe('subjects:^Merge branch');
  });

  it('prefers the author rule when both match', () => {
    expect(matchIgnoreRule(commit({ author: 'dependabot[bot]', subject: 'Merge branch x' }), ignore))
      .toBe('authors:dependabot[bot]');
  });
});

describe('commitFindings', () => {
  it('flags no-reference for an empty reference list', () => {
    expect(commitFindings([], false)).toEqual(['no-reference']);
  });

  it('flags unknown-reference when any resolvesTo is empty', () => {
    expect(commitFindings([ref(['PROJ-1']), ref([])], false)).toEqual(['unknown-reference']);
  });

  it('returns nothing when every reference resolves', () => {
    expect(commitFindings([ref(['PROJ-1'])], false)).toEqual([]);
  });

  it('returns nothing for an ignored commit', () => {
    expect(commitFindings([], true)).toEqual([]);
  });
});

describe('summarise and decideVerdict', () => {
  const commits: CommitResult[] = [
    { repo: 'repo-a', sha: 'a', subject: 's', body: '', author: 'd', committedAt: 't', ignored: null, references: [ref(['PROJ-1']), ref([])], findings: ['unknown-reference'] },
    { repo: 'repo-a', sha: 'b', subject: 's', body: '', author: 'd', committedAt: 't', ignored: null, references: [], findings: ['no-reference'] },
    { repo: 'repo-a', sha: 'c', subject: 's', body: '', author: 'd', committedAt: 't', ignored: { rule: 'authors:x' }, references: [], findings: [] }
  ];
  const items: ItemResult[] = [
    { id: 'PROJ-1', title: 't', type: 'story', status: 'done', commits: [{ repo: 'repo-a', sha: 'a' }], findings: [] },
    { id: 'PROJ-2', title: 't', type: 'story', status: 'done', commits: [], findings: ['item-without-commits'] }
  ];
  const ranges: RangeResult[] = [
    { repo: 'repo-a', base: 'v1', baseSha: 'x', head: 'v2', headSha: 'y', include: [], mergeBase: 'z', baseIsAncestorOfHead: false, commitsOnlyInBase: 3, findings: ['range-divergence'] }
  ];

  it('counts each category', () => {
    expect(summarise({ commits, items, ranges })).toEqual({
      items: 2, itemsLinked: 1, commits: 3, commitsIgnored: 1,
      noReference: 1, unknownReference: 1, itemsWithoutCommits: 1, rangeDivergence: 1
    });
  });

  it('passes when failOn is empty', () => {
    expect(decideVerdict({ commits, items, ranges, policy: { failOn: [] } }).verdict).toBe('pass');
  });

  it('fails and counts only the findings named in failOn', () => {
    const out = decideVerdict({ commits, items, ranges, policy: { failOn: ['unknown-reference'] } });
    expect(out.verdict).toBe('fail');
    expect(out.violations).toEqual([{ finding: 'unknown-reference', count: 1 }]);
  });

  it('orders violations canonically regardless of failOn order', () => {
    const out = decideVerdict({
      commits, items, ranges,
      policy: { failOn: ['range-divergence', 'item-without-commits', 'no-reference', 'unknown-reference'] }
    });
    expect(out.violations.map((v) => v.finding)).toEqual([
      'no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'
    ]);
  });

  it('omits a finding that is in failOn but did not occur', () => {
    const clean = decideVerdict({ commits: [], items: [], ranges: [], policy: { failOn: ['no-reference'] } });
    expect(clean.violations).toEqual([]);
    expect(clean.verdict).toBe('pass');
  });
});
