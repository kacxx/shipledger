import { describe, it, expect } from 'vitest';
import { renderCheckSummary } from '../../src/render/check-summary.js';
import type { CommitResult, FindingName, ItemResult, RangeResult, VerifiedChangesetV2 } from '../../src/types.js';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function range(findings: FindingName[] = []): RangeResult {
  return {
    repo: 'repo-a', base: 'v1', baseSha: SHA, head: 'v2', headSha: SHA, include: [],
    mergeBase: SHA, baseIsAncestorOfHead: findings.length === 0, commitsOnlyInBase: 0,
    findings, effectiveDelta: []
  };
}

function commit(subject: string, findings: FindingName[]): CommitResult {
  return {
    repo: 'repo-a', sha: SHA, subject, body: '', author: 'a', committedAt: '2026-01-01T00:00:00Z',
    ignored: null, references: [], findings, attribution: 'determinate'
  };
}

function item(id: string, title: string, findings: FindingName[]): ItemResult {
  return { id, title, type: 'story', status: 'done', commits: [], attribution: 'determinate', findings };
}

function verified(over: Partial<VerifiedChangesetV2> & { summary?: Partial<VerifiedChangesetV2['summary']> } = {}): VerifiedChangesetV2 {
  const { summary, ...rest } = over;
  return {
    version: 2, cliVersion: '0.2.0', preset: 'tracker-keys@1', history: 'first-parent',
    configFingerprint: 'sha256:x', policy: { failOn: ['unknown-reference'] },
    changeset: { id: 'rel', source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' }, items: [] },
    verdict: 'pass', violations: [], ranges: [range()], commits: [], items: [],
    ...rest,
    summary: {
      items: 0, itemsLinked: 0, commits: 0, commitsIgnored: 0, noReference: 0, unknownReference: 0,
      itemsWithoutCommits: 0, rangeDivergence: 0, indeterminateCommits: 0, indeterminateItems: 0,
      ...summary
    }
  };
}

const lines = (s: string) => s.split('\n');

describe('renderCheckSummary', () => {
  it('lists findings that are not policy violations under a PASS header', () => {
    const out = renderCheckSummary(verified({ commits: [commit('tidy up', ['no-reference'])] }), 'out.json');
    expect(lines(out)).toEqual([
      'PASS  rel  items linked 0/0, commits 0, ignored 0',
      '  no-reference  repo-a abcdef0  tidy up',
      'Wrote out.json',
      ''
    ]);
  });

  it('prints range findings as repo base..head, before commits and items', () => {
    const out = renderCheckSummary(verified({
      verdict: 'fail',
      violations: [{ finding: 'range-divergence', count: 1 }],
      ranges: [range(['range-divergence'])],
      commits: [commit('c', ['no-reference'])],
      items: [item('PROJ-1', 't', ['item-without-commits'])]
    }), 'out.json');
    expect(lines(out).slice(1, 4)).toEqual([
      '  range-divergence  repo-a v1..v2',
      '  no-reference  repo-a abcdef0  c',
      '  item-without-commits  PROJ-1  t'
    ]);
  });

  it('adds the indeterminate segment only when something is indeterminate', () => {
    expect(lines(renderCheckSummary(verified(), 'o'))[0]).not.toContain('indeterminate');
    const out = renderCheckSummary(verified({ summary: { indeterminateCommits: 2, indeterminateItems: 1 } }), 'o');
    expect(lines(out)[0]).toBe('PASS  rel  items linked 0/0, commits 0, ignored 0, indeterminate 2 commits/1 items');
  });

  it('shows exactly 20 findings without a remainder line', () => {
    const commits = Array.from({ length: 20 }, (_, n) => commit(`c${n}`, ['no-reference']));
    const out = lines(renderCheckSummary(verified({ commits }), 'out.json'));
    expect(out).toHaveLength(23);
    expect(out[20]).toBe('  no-reference  repo-a abcdef0  c19');
    expect(out[21]).toBe('Wrote out.json');
  });

  it('caps at 20 findings and points at the artifact for the rest', () => {
    const commits = Array.from({ length: 23 }, (_, n) => commit(`c${n}`, ['no-reference']));
    const out = lines(renderCheckSummary(verified({ commits }), 'out.json'));
    expect(out).toHaveLength(24);
    expect(out[20]).toBe('  no-reference  repo-a abcdef0  c19');
    expect(out[21]).toBe('  … and 3 more in out.json');
  });

  it('replaces control characters from tracker and commit text', () => {
    const out = renderCheckSummary(verified({
      verdict: 'fail',
      violations: [{ finding: 'unknown-reference', count: 1 }],
      changeset: { id: 'rel\x1b]0;pwned\x07', source: { kind: 't', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' }, items: [] },
      commits: [commit('fix\nPASS  rel  all good\x1b[2J', ['unknown-reference'])],
      items: [item('PROJ-1', 'title\r\x9b31m', ['item-without-commits'])]
    }), 'out\n.json');
    expect(lines(out)).toEqual([
      'FAIL  rel?]0;pwned?  unknown-reference=1; items linked 0/0, commits 0, ignored 0',
      '  unknown-reference  repo-a abcdef0  fix?PASS  rel  all good?[2J',
      '  item-without-commits  PROJ-1  title??31m',
      'Wrote out?.json',
      ''
    ]);
  });
});
