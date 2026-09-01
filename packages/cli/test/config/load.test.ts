import { describe, it, expect } from 'vitest';
import { resolve, isAbsolute } from 'node:path';
import { mergeConfig, assertConfigIdentities, fingerprintConfig } from '../../src/config/load.js';
import type { RawConfig } from '../../src/types.js';

const base: RawConfig = {
  version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../repo-a' }]
};

describe('mergeConfig', () => {
  it('resolves repo paths relative to the config directory, not cwd', () => {
    const configDir = resolve('/tmp/proj/config');
    const merged = mergeConfig(base, configDir);
    expect(merged.repos[0]?.path).toBe(resolve(configDir, '../repo-a'));
    expect(merged.repos[0]?.sourcePath).toBe('../repo-a');
  });

  it('leaves an absolute path alone', () => {
    const absPath = resolve('/abs/repo-a');
    const merged = mergeConfig({ ...base, repos: [{ name: 'repo-a', path: absPath }] }, resolve('/tmp'));
    expect(merged.repos[0]?.path).toBe(absPath);
  });

  it('takes preset defaults when a key is absent', () => {
    const merged = mergeConfig(base, resolve('/tmp'));
    expect(merged.history).toBe('first-parent');
    expect(merged.matchers).toHaveLength(2);
  });

  it('replaces the matchers array wholesale', () => {
    const merged = mergeConfig({
      ...base,
      matchers: [{ id: 'only', sources: ['subject'], pattern: '(X-\\d+)', namespace: 'global', normalize: 'none' }]
    }, resolve('/tmp'));
    expect(merged.matchers.map((m) => m.id)).toEqual(['only']);
  });

  it('replaces the whole ignore object rather than merging its keys', () => {
    const merged = mergeConfig({ ...base, ignore: { authors: [], subjects: ['^WIP'] } }, resolve('/tmp'));
    expect(merged.ignore.authors).toEqual([]);
    expect(merged.ignore.subjects).toEqual(['^WIP']);
  });

  it('records the resolved preset name and version', () => {
    const merged = mergeConfig({ ...base, preset: 'github-oss@1' }, resolve('/tmp'));
    expect(merged.presetName).toBe('github-oss');
    expect(merged.presetVersion).toBe(1);
  });
});

describe('assertConfigIdentities', () => {
  it('rejects duplicate repo names', () => {
    const merged = mergeConfig({
      ...base, repos: [{ name: 'r', path: '../a' }, { name: 'r', path: '../b' }]
    }, resolve('/tmp'));
    expect(() => assertConfigIdentities(merged)).toThrow(/duplicate repo/i);
  });

  it('rejects duplicate matcher ids', () => {
    const m = { id: 'dup', sources: ['subject'] as const, pattern: '(A-\\d+)', namespace: 'global' as const, normalize: 'none' as const };
    const merged = mergeConfig({ ...base, matchers: [m, m] }, resolve('/tmp'));
    expect(() => assertConfigIdentities(merged)).toThrow(/duplicate matcher/i);
  });

  it('accepts a clean config', () => {
    expect(() => assertConfigIdentities(mergeConfig(base, resolve('/tmp')))).not.toThrow();
  });
});

describe('fingerprintConfig', () => {
  it('ignores where the checkout lives', () => {
    const a = fingerprintConfig(mergeConfig(base, resolve('/home/alice/proj')), '0.1.0');
    const b = fingerprintConfig(mergeConfig(base, resolve('/var/ci/build')), '0.1.0');
    expect(a).toBe(b);
  });

  it('changes when policy changes', () => {
    const a = fingerprintConfig(mergeConfig(base, resolve('/tmp')), '0.1.0');
    const b = fingerprintConfig(mergeConfig({ ...base, policy: { failOn: [] } }, resolve('/tmp')), '0.1.0');
    expect(a).not.toBe(b);
  });

  it('changes when the CLI version changes', () => {
    const c = mergeConfig(base, resolve('/tmp'));
    expect(fingerprintConfig(c, '0.1.0')).not.toBe(fingerprintConfig(c, '0.2.0'));
  });

  it('changes when the schema version participates', () => {
    const c = mergeConfig(base, resolve('/tmp'));
    const tampered = { ...c, version: 2 as unknown as 1 };
    expect(fingerprintConfig(c, '0.1.0')).not.toBe(fingerprintConfig(tampered, '0.1.0'));
  });
});
