import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileInput } from '../../src/core/reconcile.js';
import { compileAll } from '../../src/core/compile.js';
import { mergeConfig } from '../../src/config/load.js';
import type { Changeset, CommitRecord, RangeResult } from '../../src/types.js';

const config = mergeConfig({
  version: 1, preset: 'tracker-keys@1',
  repos: [{ name: 'repo-a', path: '../a' }, { name: 'repo-b', path: '../b' }],
  policy: { failOn: [] }
}, '/tmp');

const compiled = compileAll(config);

const changeset: Changeset = {
  version: 1, id: 'release 1.4.0',
  source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
  items: [
    { id: 'PROJ-42', title: 'first', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-42' }] },
    { id: 'PROJ-77', title: 'second', type: 'bug', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-77' }] }
  ],
  ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
};

const SHA_BASE = 'b'.repeat(40);
const SHA_HEAD = 'e'.repeat(40);
const SHA_MERGE = 'c'.repeat(40);
const FINGERPRINT = `sha256:${'0'.repeat(64)}`;

const range = (repo: string, over: Partial<RangeResult> = {}): RangeResult => ({
  repo, base: 'v1', baseSha: SHA_BASE, head: 'v2', headSha: SHA_HEAD,
  include: [], mergeBase: SHA_MERGE, baseIsAncestorOfHead: true, commitsOnlyInBase: 0,
  findings: [], ...over
});

const commit = (over: Partial<CommitRecord>): CommitRecord => ({
  repo: 'repo-a', sha: '1'.repeat(40), subject: '', body: '',
  author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
});

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  config, compiled, changeset,
  commits: [commit({ subject: 'PROJ-42 and PROJ-99' })],
  ranges: [range('repo-a')],
  cliVersion: '0.1.0',
  configFingerprint: FINGERPRINT,
  ...over
});

describe('reconcile', () => {
  it('links a commit and keeps its unknown reference', () => {
    const out = reconcile(input());
    expect(out.commits[0]?.findings).toEqual(['unknown-reference']);
    expect(out.items.find((i) => i.id === 'PROJ-42')?.commits).toHaveLength(1);
  });

  it('flags an item with no commits', () => {
    expect(reconcile(input()).items.find((i) => i.id === 'PROJ-77')?.findings).toEqual(['item-without-commits']);
  });

  it('carries item metadata into the output', () => {
    const item = reconcile(input()).items[0];
    expect(item).toMatchObject({ id: 'PROJ-42', title: 'first', type: 'story', status: 'done' });
  });

  it('records preset, history and the full changeset in the output', () => {
    const out = reconcile(input());
    expect(out.preset).toBe('tracker-keys@1');
    expect(out.history).toBe('first-parent');
    expect(out.changeset.items).toHaveLength(2);
    expect(out.changeset.source.kind).toBe('k');
  });

  it('retains the commit body', () => {
    const out = reconcile(input({ commits: [commit({ subject: 'PROJ-42', body: 'context line' })] }));
    expect(out.commits[0]?.body).toBe('context line');
  });

  it('marks an ignored commit, extracts nothing, and excludes it from findings', () => {
    const out = reconcile(input({ commits: [commit({ subject: 'Merge branch PROJ-42' })] }));
    expect(out.commits[0]?.ignored?.rule).toBe('subjects:^Merge branch');
    expect(out.commits[0]?.references).toEqual([]);
    expect(out.commits[0]?.findings).toEqual([]);
    expect(out.summary.noReference).toBe(0);
    expect(out.items.find((i) => i.id === 'PROJ-42')?.commits).toEqual([]);
  });

  it('deduplicates item commit links by repo and sha', () => {
    const twice = commit({ subject: 'PROJ-42 PROJ-42', sha: '9'.repeat(40) });
    const out = reconcile(input({ commits: [twice] }));
    expect(out.items.find((i) => i.id === 'PROJ-42')?.commits).toHaveLength(1);
  });

  it('orders ranges by config repo order', () => {
    const out = reconcile(input({ ranges: [range('repo-b'), range('repo-a')] }));
    expect(out.ranges.map((r) => r.repo)).toEqual(['repo-a', 'repo-b']);
  });

  it('orders items in changeset order', () => {
    expect(reconcile(input()).items.map((i) => i.id)).toEqual(['PROJ-42', 'PROJ-77']);
  });

  it('omits generatedAt when now is absent and includes it when present', () => {
    expect(reconcile(input()).generatedAt).toBeUndefined();
    expect(reconcile(input({ now: '2026-09-01T00:00:00Z' })).generatedAt).toBe('2026-09-01T00:00:00Z');
  });

  it('is byte-identical for identical input', () => {
    expect(JSON.stringify(reconcile(input()))).toBe(JSON.stringify(reconcile(input())));
  });

  it('propagates a range finding into the verdict when policy fails on it', () => {
    const failing = mergeConfig({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../a' }]
    }, '/tmp');
    const out = reconcile(input({
      config: failing,
      ranges: [range('repo-a', { baseIsAncestorOfHead: false, findings: ['range-divergence'] })]
    }));
    expect(out.verdict).toBe('fail');
    expect(out.violations).toContainEqual({ finding: 'range-divergence', count: 1 });
  });

  it('produces output that satisfies the published verified-changeset schema', async () => {
    const { validateVerified } = await import('../../src/config/validate.js');
    const out = reconcile(input({ now: '2026-09-01T00:00:00Z' }));
    expect(() => validateVerified(JSON.parse(JSON.stringify(out)))).not.toThrow();
  });

  it('satisfies the schema with generatedAt absent', async () => {
    const { validateVerified } = await import('../../src/config/validate.js');
    expect(() => validateVerified(JSON.parse(JSON.stringify(reconcile(input()))))).not.toThrow();
  });
});
