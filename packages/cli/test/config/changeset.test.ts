import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertChangesetAgainstConfig, assertFetchedAtPlausible } from '../../src/config/changeset.js';
import { mergeConfig } from '../../src/config/load.js';
import type { Changeset, ChangesetItem } from '../../src/types.js';

const config = mergeConfig({
  version: 1, preset: 'tracker-keys@1',
  repos: [{ name: 'repo-a', path: '../a' }, { name: 'repo-b', path: '../b' }]
}, '/tmp');

const item = (over: Partial<ChangesetItem> = {}): ChangesetItem => ({
  id: 'PROJ-1', title: 't', type: 'story', status: 'done',
  tokens: [{ matcher: 'ticket-key', token: 'PROJ-1' }], ...over
});

function changeset(over: Partial<Changeset> = {}): Changeset {
  return {
    version: 1, id: 'release 1.4.0',
    source: { kind: 'k', ref: 'r', fetchedAt: '2026-09-01T01:00:00Z' },
    items: [item()],
    ranges: [{ repo: 'repo-a', base: 'v1.3.0', head: 'v1.4.0' }],
    ...over
  };
}

describe('assertChangesetAgainstConfig', () => {
  it('accepts a consistent changeset', () => {
    expect(() => assertChangesetAgainstConfig(changeset(), config)).not.toThrow();
  });

  it('rejects a range naming an undefined repo', () => {
    expect(() => assertChangesetAgainstConfig(changeset({ ranges: [{ repo: 'ghost', base: 'a', head: 'b' }] }), config)).toThrow(/ghost/);
  });

  it('rejects two ranges for the same repo', () => {
    const ranges = [
      { repo: 'repo-a', base: 'v1', head: 'v2' },
      { repo: 'repo-a', base: 'v2', head: 'v3' }
    ];
    expect(() => assertChangesetAgainstConfig(changeset({ ranges }), config)).toThrow(/one range per repo/i);
  });

  it('rejects duplicate item ids', () => {
    expect(() => assertChangesetAgainstConfig(changeset({ items: [item(), item()] }), config)).toThrow(/duplicate item/i);
  });

  it('rejects a token naming an unknown matcher', () => {
    const bad = item({ tokens: [{ matcher: 'nope', token: '#1', repo: 'repo-a' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/matcher "nope"/);
  });

  it('rejects a repo-namespaced token with no repo', () => {
    const bad = item({ tokens: [{ matcher: 'pr-ref', token: '#1' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/requires "repo"/);
  });

  it('rejects a global token carrying a repo', () => {
    const bad = item({ tokens: [{ matcher: 'ticket-key', token: 'PROJ-2', repo: 'repo-a' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/must not carry "repo"/);
  });

  it('rejects a token naming an undefined repo', () => {
    const bad = item({ tokens: [{ matcher: 'pr-ref', token: '#1', repo: 'ghost' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/ghost/);
  });

  it('allows one token tuple to belong to two items', () => {
    const shared = { matcher: 'pr-ref', token: '#9', repo: 'repo-a' };
    const items = [item({ id: 'A', tokens: [shared] }), item({ id: 'B', tokens: [shared] })];
    expect(() => assertChangesetAgainstConfig(changeset({ items }), config)).not.toThrow();
  });

  it('reports every problem in one error', () => {
    const bad = changeset({
      ranges: [{ repo: 'ghost', base: 'a', head: 'b' }],
      items: [item({ tokens: [{ matcher: 'nope', token: '#1' }] })]
    });
    try {
      assertChangesetAgainstConfig(bad, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/ghost/);
      expect((err as Error).message).toMatch(/nope/);
    }
  });
});

describe('assertFetchedAtPlausible', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a timestamp in the past', () => {
    expect(() => assertFetchedAtPlausible('2026-01-01T00:00:00Z')).not.toThrow();
  });

  it('accepts a timestamp within the clock-skew tolerance', () => {
    const nearFuture = new Date(Date.now() + 2 * 60_000).toISOString();
    expect(() => assertFetchedAtPlausible(nearFuture)).not.toThrow();
  });

  it('rejects a timestamp clearly in the future', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(() => assertFetchedAtPlausible(future)).toThrow(/future/i);
  });

  it('names the remedy in the error', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(() => assertFetchedAtPlausible(future)).toThrow(/actual UTC time/i);
  });
});
