import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVerifiedSemantics } from '../src/verify.js';
import { validateVerified } from '../src/config/validate.js';
import { CliError } from '../src/errors.js';
import type { VerifiedChangeset } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (): VerifiedChangeset => validateVerified(
  JSON.parse(readFileSync(join(here, 'fixtures', 'verified-example.json'), 'utf8'))
);

describe('assertVerifiedSemantics', () => {
  it('accepts the reconciler-produced fixture', () => {
    expect(() => assertVerifiedSemantics(load())).not.toThrow();
  });

  it('rejects an item linked to a commit that is not in the commit list', () => {
    const v = load();
    v.items[0]!.commits = [{ repo: 'repo-a', sha: 'f'.repeat(40) }];
    expect(() => assertVerifiedSemantics(v)).toThrow(/not present in commits/);
  });

  it('rejects a reference resolving to an unknown item id', () => {
    const v = load();
    v.commits[0]!.references[0]!.resolvesTo = ['GHOST-1'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/GHOST-1/);
  });

  it('rejects a commit whose findings contradict its references', () => {
    const v = load();
    v.commits[0]!.findings = ['no-reference'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/no-reference/);
  });

  it('rejects an ignored commit that carries findings', () => {
    const v = load();
    const ignored = v.commits.find((c) => c.ignored !== null)!;
    ignored.findings = ['no-reference'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/ignored/);
  });

  it('rejects an item finding that contradicts its commit list', () => {
    const v = load();
    v.items[0]!.findings = ['item-without-commits'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/item-without-commits/);
  });

  it('rejects a range finding that contradicts its ancestry flag', () => {
    const v = load();
    v.ranges[0]!.baseIsAncestorOfHead = true;
    expect(() => assertVerifiedSemantics(v)).toThrow(/range-divergence/);
  });

  it('rejects a summary that does not match the commits', () => {
    const v = load();
    v.summary.noReference = 99;
    expect(() => assertVerifiedSemantics(v)).toThrow(/summary/);
  });

  it('rejects a verdict that contradicts the violations', () => {
    const v = load();
    v.verdict = 'pass';
    expect(() => assertVerifiedSemantics(v)).toThrow(/verdict/);
  });

  it('rejects a violation count that overstates the findings', () => {
    const v = load();
    v.violations = [{ finding: 'no-reference', count: 7 }];
    expect(() => assertVerifiedSemantics(v)).toThrow(/count/);
  });

  it('rejects item ids that disagree with the embedded changeset', () => {
    const v = load();
    v.items[0]!.id = 'RENAMED-1';
    expect(() => assertVerifiedSemantics(v)).toThrow(/changeset/);
  });

  it('reports semantic failures as usage errors', () => {
    const v = load();
    v.summary.commits = 0;
    try {
      assertVerifiedSemantics(v);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('accepts output produced by reconcile itself', async () => {
    const [{ reconcile }, { compileAll }, { mergeConfig }] = await Promise.all([
      import('../src/core/reconcile.js'),
      import('../src/core/compile.js'),
      import('../src/config/load.js')
    ]);
    const config = mergeConfig({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../a' }]
    }, '/tmp');
    const out = reconcile({
      config, compiled: compileAll(config),
      changeset: {
        version: 1, id: 'r', source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
        items: [{ id: 'PROJ-1', title: 't', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-1' }] }],
        ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
      },
      commits: [{ repo: 'repo-a', sha: 'a'.repeat(40), subject: 'PROJ-1 and PROJ-9', body: '', author: 'Dev', committedAt: '2026-01-01T00:00:00Z' }],
      ranges: [],
      cliVersion: '0.1.0', configFingerprint: `sha256:${'0'.repeat(64)}`
    });
    expect(() => assertVerifiedSemantics(out)).not.toThrow();
  });
});
