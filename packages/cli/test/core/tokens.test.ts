import { describe, it, expect } from 'vitest';
import { compileMatchers } from '../../src/core/compile.js';
import { extractReferences } from '../../src/core/tokens.js';
import type { CommitRecord, MatcherConfig } from '../../src/types.js';

const ticketKey: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};
const prRef: MatcherConfig = {
  id: 'pr-ref', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none'
};
const compiled = compileMatchers([ticketKey, prRef]);

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    repo: 'repo-a', sha: 'a'.repeat(40), subject: '', body: '',
    author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
  };
}

describe('extractReferences', () => {
  it('takes capture group 1 verbatim, including the sigil', () => {
    const refs = extractReferences(commit({ subject: 'fix thing (#123)' }), compiled);
    expect(refs.find((r) => r.matcher === 'pr-ref')?.token).toBe('#123');
  });
  it('applies the normalize rule', () => {
    const lower = compileMatchers([{ ...ticketKey, pattern: '([A-Za-z][A-Za-z0-9]+-\\d+)' }]);
    expect(extractReferences(commit({ subject: 'proj-42 done' }), lower)[0]?.token).toBe('PROJ-42');
  });
  it('collapses one tuple seen in two sources into a single reference listing both', () => {
    const refs = extractReferences(commit({ subject: 'PROJ-1 fix', body: 'more on PROJ-1' }), compiled);
    const hit = refs.filter((r) => r.token === 'PROJ-1');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.sources).toEqual(['subject', 'body']);
  });
  it('records sources in subject-then-body order regardless of where it first appeared', () => {
    const refs = extractReferences(commit({ body: 'PROJ-1', subject: 'PROJ-1' }), compiled);
    expect(refs[0]?.sources).toEqual(['subject', 'body']);
  });
  it('collapses repeated captures within one source', () => {
    const refs = extractReferences(commit({ subject: 'PROJ-1 and again PROJ-1' }), compiled);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sources).toEqual(['subject']);
  });
  it('does not read a source the matcher did not declare', () => {
    const refs = extractReferences(commit({ body: 'mentions (#7)' }), compiled);
    expect(refs.some((r) => r.matcher === 'pr-ref')).toBe(false);
  });
  it('finds every distinct occurrence', () => {
    const refs = extractReferences(commit({ subject: 'PROJ-1 and PROJ-2' }), compiled);
    expect(refs.map((r) => r.token)).toEqual(['PROJ-1', 'PROJ-2']);
  });
  it('keeps different matchers separate even for an equal token string', () => {
    const both = compileMatchers([
      { id: 'a', sources: ['subject'], pattern: '(#\\d+)', namespace: 'global', normalize: 'none' },
      { id: 'b', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none' }
    ]);
    const refs = extractReferences(commit({ subject: 'x (#5)' }), both);
    expect(refs.map((r) => r.matcher)).toEqual(['a', 'b']);
  });
  it('does not trim or alter source text when matching a body with trailing whitespace', () => {
    const refs = extractReferences(commit({ body: '  PROJ-3  \n\n' }), compiled);
    expect(refs[0]?.token).toBe('PROJ-3');
  });
  it('returns an empty list when nothing matches', () => {
    expect(extractReferences(commit({ subject: 'tidy up' }), compiled)).toEqual([]);
  });
  it('leaves resolvesTo an empty array', () => {
    expect(extractReferences(commit({ subject: 'PROJ-1' }), compiled)[0]?.resolvesTo).toEqual([]);
  });
});
