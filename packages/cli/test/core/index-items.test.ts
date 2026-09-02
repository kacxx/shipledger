import { describe, it, expect } from 'vitest';
import { buildItemIndex, resolveReferences, scopeKeyFor } from '../../src/core/index-items.js';
import { compileMatchers } from '../../src/core/compile.js';
import { extractReferences } from '../../src/core/tokens.js';
import type { Changeset, ChangesetItem, CommitRecord, MatcherConfig } from '../../src/types.js';

const ticketKey: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};
const prRef: MatcherConfig = {
  id: 'pr-ref', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none'
};
const matchers = [ticketKey, prRef];
const compiled = compileMatchers(matchers);

const item = (id: string, tokens: ChangesetItem['tokens']): ChangesetItem =>
  ({ id, title: 't', type: 'story', status: 'done', tokens });

function changeset(items: ChangesetItem[]): Changeset {
  return {
    version: 1, id: 'r', source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
    items, ranges: [{ repo: 'repo-a', base: 'a', head: 'b' }]
  };
}

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    repo: 'repo-a', sha: 'a'.repeat(40), subject: '', body: '',
    author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
  };
}

describe('scopeKeyFor', () => {
  it('is the literal global for global matchers', () => {
    expect(scopeKeyFor('global', 'repo-a')).toBe('global');
  });

  it('is the repo name for repo matchers', () => {
    expect(scopeKeyFor('repo', 'repo-a')).toBe('repo-a');
  });
});

describe('buildItemIndex + resolveReferences', () => {
  it('does not match an item id that is not declared as a token', () => {
    const index = buildItemIndex(changeset([item('PROJ-42', [{ matcher: 'pr-ref', token: '#1', repo: 'repo-a' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42 fix' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual([]);
  });

  it('matches an explicitly declared global token', () => {
    const index = buildItemIndex(changeset([item('PROJ-42', [{ matcher: 'ticket-key', token: 'PROJ-42' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42 fix' }), compiled);
    const out = resolveReferences(refs, 'repo-a', index);
    expect(out.references[0]?.resolvesTo).toEqual(['PROJ-42']);
    expect(out.links).toEqual([{ itemId: 'PROJ-42' }]);
  });

  it('normalises the declared token with the matcher rule', () => {
    const index = buildItemIndex(changeset([item('x', [{ matcher: 'ticket-key', token: 'proj-42' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual(['x']);
  });

  it('scopes a repo token to its repo', () => {
    const index = buildItemIndex(changeset([item('I1', [{ matcher: 'pr-ref', token: '#123', repo: 'repo-a' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'squash (#123)' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual(['I1']);
  });

  it('does not match a repo token from another repo', () => {
    const index = buildItemIndex(changeset([item('I1', [{ matcher: 'pr-ref', token: '#123', repo: 'repo-a' }])]), matchers);
    const refs = extractReferences(commit({ repo: 'repo-b', subject: 'squash (#123)' }), compiled);
    expect(resolveReferences(refs, 'repo-b', index).references[0]?.resolvesTo).toEqual([]);
  });

  it('does not match across matchers with a coincidentally equal token', () => {
    const index = buildItemIndex(changeset([item('I1', [{ matcher: 'ticket-key', token: '#5' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'x (#5)' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual([]);
  });

  it('resolves one token to every matching item, in changeset order', () => {
    const shared = { matcher: 'pr-ref' as const, token: '#9', repo: 'repo-a' };
    const index = buildItemIndex(changeset([item('B', [shared]), item('A', [shared])]), matchers);
    const refs = extractReferences(commit({ subject: 'x (#9)' }), compiled);
    const out = resolveReferences(refs, 'repo-a', index);
    expect(out.references[0]?.resolvesTo).toEqual(['B', 'A']);
    expect(out.links).toEqual([{ itemId: 'B' }, { itemId: 'A' }]);
  });

  it('keeps an unresolved reference alongside a resolved one', () => {
    const index = buildItemIndex(changeset([item('PROJ-42', [{ matcher: 'ticket-key', token: 'PROJ-42' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42 and PROJ-99' }), compiled);
    const out = resolveReferences(refs, 'repo-a', index);
    expect(out.references.map((r) => r.resolvesTo)).toEqual([['PROJ-42'], []]);
    expect(out.links).toEqual([{ itemId: 'PROJ-42' }]);
  });

  it('reports each linked item once even when two references hit it', () => {
    const index = buildItemIndex(changeset([
      item('I1', [{ matcher: 'ticket-key', token: 'PROJ-1' }, { matcher: 'ticket-key', token: 'PROJ-2' }])
    ]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-1 PROJ-2' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).links).toEqual([{ itemId: 'I1' }]);
  });
});
