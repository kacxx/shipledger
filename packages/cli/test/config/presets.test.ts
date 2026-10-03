import { describe, it, expect } from 'vitest';
import { resolvePreset } from '../../src/config/presets.js';
import { CliError } from '../../src/errors.js';

describe('resolvePreset', () => {
  it('resolves a pinned preset', () => {
    const p = resolvePreset('tracker-keys@1');
    expect(p.name).toBe('tracker-keys');
    expect(p.version).toBe(1);
  });

  it('rejects an unpinned preset by default', () => {
    expect(() => resolvePreset('tracker-keys')).toThrow(/pinned/);
  });

  it('allows an unpinned preset when explicitly permitted, for init, resolving the latest version', () => {
    expect(resolvePreset('tracker-keys', { allowUnpinned: true }).version).toBe(2);
    expect(resolvePreset('github-oss', { allowUnpinned: true }).version).toBe(3);
  });

  it('tracker-keys@1 fails on all four findings', () => {
    expect(resolvePreset('tracker-keys@1').defaults.policy.failOn).toEqual([
      'no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'
    ]);
  });

  it('github-oss@1 is fatal only on unknown-reference and range-divergence', () => {
    expect(resolvePreset('github-oss@1').defaults.policy.failOn).toEqual([
      'unknown-reference', 'range-divergence'
    ]);
  });

  it('github-oss@1 does not fail on findings that are normal open-source hygiene', () => {
    const { failOn } = resolvePreset('github-oss@1').defaults.policy;
    expect(failOn).not.toContain('no-reference');
    expect(failOn).not.toContain('item-without-commits');
  });

  it('ignore authors are exact names, not escaped regexes', () => {
    expect(resolvePreset('tracker-keys@1').defaults.ignore.authors).toContain('dependabot[bot]');
  });

  it('keeps version 1 matchers unchanged, so pinned configs are judged as before', () => {
    const pr = { id: 'pr-ref', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none' };
    expect(resolvePreset('github-oss@1').defaults.matchers).toEqual([pr]);
    expect(resolvePreset('tracker-keys@1').defaults.matchers[1]).toEqual(pr);
  });

  it('version 2 keeps the version 1 policy and ignore rules', () => {
    for (const name of ['tracker-keys', 'github-oss']) {
      const v1 = resolvePreset(`${name}@1`).defaults;
      const v2 = resolvePreset(`${name}@2`).defaults;
      expect(v2.policy).toEqual(v1.policy);
      expect(v2.ignore).toEqual(v1.ignore);
      expect(v2.history).toEqual(v1.history);
    }
  });

  it('github-oss@2 reads pull request references from the subject and the body', () => {
    expect(resolvePreset('github-oss@2').defaults.matchers.map((m) => m.sources)).toEqual([['subject', 'body']]);
  });

  it('tracker-keys@2 still reads pull request references from the subject only', () => {
    const pr = resolvePreset('tracker-keys@2').defaults.matchers.find((m) => m.id === 'pr-ref');
    expect(pr?.sources).toEqual(['subject']);
  });

  describe('version 2 pr-ref pattern', () => {
    const tokens = (text: string): string[] => {
      const pr = resolvePreset('github-oss@2').defaults.matchers[0];
      return [...text.matchAll(new RegExp(pr?.pattern ?? '', 'g'))].map((m) => m[1] ?? '');
    };

    it.each([
      ['fix: handle empty input (#12)', ['#12']],
      ['Merge PR#12 from fork', ['#12']],
      ['closes #9 and #10', ['#9', '#10']],
      ['#12,#13', ['#12', '#13']]
    ])('matches local references in %j', (text, expected) => {
      expect(tokens(text)).toEqual(expected);
    });

    it.each([
      ['broke the gateway (other-org/other-repo#115).'],
      ['see https://example.com/org/repo/issues/5#issuecomment-1'],
      ['an &#12; entity'],
      ['#12abc']
    ])('ignores references to something else in %j', (text) => {
      expect(tokens(text)).toEqual([]);
    });

    it('matches a local reference next to a cross-repository one', () => {
      expect(tokens('other-org/other-repo#3 and #4')).toEqual(['#4']);
    });
  });

  describe('github-oss@3', () => {
    const v2 = resolvePreset('github-oss@2').defaults;
    const v3 = resolvePreset('github-oss@3').defaults;

    it('keeps the version 2 matchers, history and failOn', () => {
      expect(v3.matchers).toEqual(v2.matchers);
      expect(v3.history).toEqual(v2.history);
      expect(v3.policy.failOn).toEqual(v2.policy.failOn);
    });

    it('treats unresolved body references as context, where version 2 stays strict', () => {
      expect(v3.policy.bodyReferences).toBe('context');
      expect(v2.policy.bodyReferences).toBeUndefined();
    });

    it('keeps the version 2 ignore rules and adds release automation commits', () => {
      expect(v3.ignore.authors).toEqual(v2.ignore.authors);
      expect(v3.ignore.subjects.slice(0, v2.ignore.subjects.length)).toEqual(v2.ignore.subjects);
    });

    const ignored = (subject: string): boolean => v3.ignore.subjects.some((p) => new RegExp(p).test(subject));

    it.each([
      ['chore(main): release 1.24.0 (#17662)'],
      ['chore: release 2.0.0'],
      ['chore(main): release my-pkg 1.2.3'],
      ['chore(master): release v3.1.0'],
      ['chore(release): 1.2.3 [skip ci]']
    ])('ignores the release commit %j', (subject) => {
      expect(ignored(subject)).toBe(true);
    });

    it.each([
      ['chore: release notes typo'],
      ['chore(ci): release workflow uses node 22'],
      ['fix: release 1.2.3 regression (#12)'],
      ['chore(release): bump tooling']
    ])('does not ignore %j', (subject) => {
      expect(ignored(subject)).toBe(false);
    });
  });

  it('rejects an unknown name', () => {
    expect(() => resolvePreset('nope@1')).toThrow(CliError);
  });

  it('rejects an unknown version', () => {
    expect(() => resolvePreset('github-oss@99')).toThrow(/version/);
  });
});
