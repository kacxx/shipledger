import { describe, it, expect } from 'vitest';
import { compileMatchers, compileIgnore, compileAll } from '../../src/core/compile.js';
import { mergeConfig } from '../../src/config/load.js';
import { CliError } from '../../src/errors.js';
import type { MatcherConfig } from '../../src/types.js';

const ok: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};

describe('compileMatchers', () => {
  it('compiles a valid matcher', () => {
    expect(compileMatchers([ok])[0]?.config.id).toBe('ticket-key');
  });
  it('rejects a pattern with no capture group', () => {
    expect(() => compileMatchers([{ ...ok, pattern: 'PROJ-\\d+' }])).toThrow(/exactly one/);
  });
  it('rejects a pattern with two capture groups', () => {
    expect(() => compileMatchers([{ ...ok, pattern: '([A-Z]+)-(\\d+)' }])).toThrow(/exactly one/);
  });
  it('counts one group for a pattern containing an alternation', () => {
    expect(compileMatchers([{ ...ok, pattern: '((?:ABC|XYZ)-\\d+)' }])).toHaveLength(1);
  });
  it('rejects an invalid regular expression with exit code 2', () => {
    try {
      compileMatchers([{ ...ok, pattern: '([' }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });
});

describe('compileIgnore', () => {
  it('treats authors as exact strings, not patterns', () => {
    const compiled = compileIgnore({ authors: ['dependabot[bot]'], subjects: [] });
    expect(compiled.authors.has('dependabot[bot]')).toBe(true);
  });
  it('compiles subjects as regular expressions', () => {
    expect(compileIgnore({ authors: [], subjects: ['^Merge branch'] }).subjects[0]?.regex.test('Merge branch x')).toBe(true);
  });
  it('rejects an invalid subject expression', () => {
    expect(() => compileIgnore({ authors: [], subjects: ['^('] })).toThrow(CliError);
  });
  it('does not treat an author with regex metacharacters as a pattern', () => {
    const compiled = compileIgnore({ authors: ['a.b'], subjects: [] });
    expect(compiled.authors.has('a.b')).toBe(true);
    expect(compiled.authors.has('axb')).toBe(false);
  });
});

describe('compileAll', () => {
  it('compiles everything from a resolved config in one call', () => {
    const config = mergeConfig({ version: 1, preset: 'tracker-keys@1', repos: [{ name: 'r', path: '.' }] }, '/tmp');
    const compiled = compileAll(config);
    expect(compiled.matchers).toHaveLength(2);
    expect(compiled.ignore.subjects).toHaveLength(2);
  });
  it('fails before any repository work, given a bad matcher', () => {
    const config = mergeConfig({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'r', path: '/nonexistent' }],
      matchers: [{ ...ok, pattern: '([' }]
    }, '/tmp');
    expect(() => compileAll(config)).toThrow(CliError);
  });
});
