import { describe, it, expect } from 'vitest';
import { validateConfig, validateChangeset, validateNotes } from '../../src/config/validate.js';
import { CliError } from '../../src/errors.js';

const config = { version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../repo-a' }] };

const changeset = {
  version: 1, id: 'release 1.4.0',
  source: { kind: 'github-milestone', ref: 'https://example.invalid/m/7', fetchedAt: '2026-09-01T01:00:00Z' },
  items: [], ranges: [{ repo: 'repo-a', base: 'v1.3.0', head: 'v1.4.0' }]
};

const item = (over: Record<string, unknown> = {}) => ({
  id: 'PROJ-42', title: 't', type: 'story', status: 'done',
  tokens: [{ matcher: 'ticket-key', token: 'PROJ-42' }], ...over
});

describe('validateConfig', () => {
  it('accepts a minimal config', () => {
    expect(validateConfig(config).repos[0]?.name).toBe('repo-a');
  });

  it('requires preset', () => {
    const { preset: _preset, ...rest } = config;
    expect(() => validateConfig(rest)).toThrow(/preset/);
  });

  it('rejects an unknown top-level key', () => {
    expect(() => validateConfig({ ...config, failOn: [] })).toThrow(CliError);
  });

  it('rejects an unknown finding name in policy.failOn', () => {
    expect(() => validateConfig({ ...config, policy: { failOn: ['no-refernce'] } })).toThrow(/failOn/);
  });

  it('rejects a partial ignore object, since a present key replaces the preset value', () => {
    expect(() => validateConfig({ ...config, ignore: { authors: ['x'] } })).toThrow(/subjects/);
  });

  it('reports exit code 2', () => {
    try {
      validateConfig({});
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });
});

describe('validateChangeset', () => {
  it('accepts a minimal changeset', () => {
    expect(validateChangeset(changeset).ranges).toHaveLength(1);
  });

  it('rejects an item with no tokens', () => {
    expect(() => validateChangeset({ ...changeset, items: [item({ tokens: [] })] })).toThrow(/tokens/);
  });

  it('rejects an item missing tokens entirely', () => {
    const { tokens: _tokens, ...noTokens } = item();
    expect(() => validateChangeset({ ...changeset, items: [noTokens] })).toThrow(/tokens/);
  });

  it('rejects a bare-string token', () => {
    expect(() => validateChangeset({ ...changeset, items: [item({ tokens: ['#123'] })] })).toThrow(CliError);
  });

  it('rejects a malformed fetchedAt', () => {
    expect(() => validateChangeset({ ...changeset, source: { kind: 'k', ref: 'r', fetchedAt: 'yesterday' } })).toThrow(/fetchedAt/);
  });
});

describe('validateNotes', () => {
  const sha = 'a'.repeat(40);

  it('accepts structured entries with fixed-vocabulary classifications', () => {
    const notes = {
      version: 1,
      noReference: [{ repo: 'repo-a', sha, classification: 'revert', note: 'reverted in 1.3' }]
    };
    expect(validateNotes(notes).noReference?.[0]?.classification).toBe('revert');
  });

  it('accepts a reference note carrying its full tuple', () => {
    const notes = {
      version: 1,
      unknownReference: [{ repo: 'repo-a', sha, matcher: 'ticket-key', token: 'PROJ-9', classification: 'typo', note: 'meant PROJ-1' }]
    };
    expect(validateNotes(notes).unknownReference?.[0]?.token).toBe('PROJ-9');
  });

  it('rejects a classification outside the vocabulary', () => {
    const notes = { version: 1, noReference: [{ repo: 'r', sha, classification: 'meh', note: 'x' }] };
    expect(() => validateNotes(notes)).toThrow(/classification/);
  });

  it('rejects an empty note', () => {
    expect(() => validateNotes({ version: 1, items: [{ item: 'PROJ-1', classification: 'not-done', note: '' }] })).toThrow(/note/);
  });

  it('rejects a whitespace-only note', () => {
    expect(() => validateNotes({ version: 1, items: [{ item: 'PROJ-1', classification: 'not-done', note: '   \t' }] })).toThrow(/note/);
  });

  it('rejects a missing note', () => {
    expect(() => validateNotes({ version: 1, items: [{ item: 'PROJ-1', classification: 'not-done' }] })).toThrow(/note/);
  });

  it('rejects the old map-keyed shape outright', () => {
    expect(() => validateNotes({ version: 1, items: { 'PROJ-1': { classification: 'not-done', note: 'x' } } })).toThrow(CliError);
  });

  it('permits two entries reusing the same sentence', () => {
    const notes = {
      version: 1,
      noReference: [
        { repo: 'r', sha: 'a'.repeat(40), classification: 'dependency-bump', note: 'routine bump' },
        { repo: 'r', sha: 'b'.repeat(40), classification: 'dependency-bump', note: 'routine bump' }
      ]
    };
    expect(validateNotes(notes).noReference).toHaveLength(2);
  });
});
