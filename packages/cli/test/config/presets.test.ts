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

  it('allows an unpinned preset when explicitly permitted, for init', () => {
    expect(resolvePreset('tracker-keys', { allowUnpinned: true }).version).toBe(1);
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

  it('rejects an unknown name', () => {
    expect(() => resolvePreset('nope@1')).toThrow(CliError);
  });

  it('rejects an unknown version', () => {
    expect(() => resolvePreset('github-oss@99')).toThrow(/version/);
  });
});
