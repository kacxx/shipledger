import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotesCoverFindings, buildNoteLookup, commitKey, referenceKey } from '../src/notes.js';
import { validateVerified } from '../src/config/validate.js';
import type { NotesFile } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const verified = validateVerified(
  JSON.parse(readFileSync(join(here, 'fixtures', 'verified-example.json'), 'utf8'))
);

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';

const complete = (): NotesFile => ({
  version: 1,
  noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', note: 'lint config only' }],
  unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
  items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
  ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
});

describe('key builders', () => {
  it('separate fields with NUL, which no field value can contain', () => {
    expect(commitKey('repo-a', C)).toBe(`repo-a\u0000${C}`);
    expect(referenceKey('repo-a', B, 'ticket-key', 'PROJ-9')).toBe(`repo-a\u0000${B}\u0000ticket-key\u0000PROJ-9`);
  });

  it('cannot be collided by a token containing the old colon delimiter', () => {
    const a = referenceKey('r', A, 'm', 'x:y');
    const b = referenceKey('r', A, 'm:x', 'y');
    expect(a).not.toBe(b);
  });
});

describe('assertNotesCoverFindings', () => {
  it('accepts a complete triage', () => {
    expect(() => assertNotesCoverFindings(complete(), verified)).not.toThrow();
  });

  it('rejects a missing no-reference entry', () => {
    const notes = complete();
    notes.noReference = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/missing/i);
  });

  it('rejects a missing unknown-reference entry, naming the tuple', () => {
    const notes = complete();
    notes.unknownReference = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/PROJ-9/);
  });

  it('rejects a missing item entry', () => {
    const notes = complete();
    notes.items = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/PROJ-2/);
  });

  it('rejects a missing range entry', () => {
    const notes = complete();
    notes.ranges = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/repo-a/);
  });

  it('rejects an omitted section as missing coverage rather than treating it as untriaged', () => {
    const { noReference: _noReference, ...rest } = complete();
    expect(() => assertNotesCoverFindings(rest as NotesFile, verified)).toThrow(/missing/i);
  });

  it('rejects an entry for a commit with no no-reference finding', () => {
    const notes = complete();
    notes.noReference?.push({ repo: 'repo-a', sha: A, classification: 'revert', note: 'x' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/does not carry/);
  });

  it('rejects an entry for a reference that resolved', () => {
    const notes = complete();
    notes.unknownReference?.push({ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-1', classification: 'typo', note: 'x' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/resolved/);
  });

  it('rejects an entry for a reference tuple that does not exist at all', () => {
    const notes = complete();
    notes.unknownReference?.push({ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-77', classification: 'typo', note: 'x' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/PROJ-77/);
  });

  it('rejects a duplicate entry for one finding', () => {
    const notes = complete();
    notes.items?.push({ item: 'PROJ-2', classification: 'wrongly-tagged', note: 'second opinion' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/more than one/);
  });

  it('rejects a whitespace-only sentence even though the shape is right', () => {
    const notes = complete();
    (notes.items as Array<{ note: string }>)[0]!.note = '   ';
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/whitespace/);
  });

  it('permits the same sentence on several entries', () => {
    const twoBare = {
      ...verified,
      commits: [
        ...verified.commits,
        { ...verified.commits.find((c) => c.sha === C)!, sha: 'e'.repeat(40) }
      ]
    };
    const notes = complete();
    notes.noReference?.push({ repo: 'repo-a', sha: 'e'.repeat(40), classification: 'tooling-or-ci', note: 'lint config only' });
    expect(() => assertNotesCoverFindings(notes, twoBare)).not.toThrow();
  });

  it('lets two unknown references on one commit take different dispositions', () => {
    const two = {
      ...verified,
      commits: verified.commits.map((c) => c.sha === B
        ? { ...c, references: [...c.references, { matcher: 'ticket-key', token: 'PROJ-8', namespace: 'global' as const, sources: ['subject' as const], resolvesTo: [] }] }
        : c)
    };
    const notes = complete();
    notes.unknownReference?.push({ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-8', classification: 'typo', note: 'meant PROJ-1' });
    expect(() => assertNotesCoverFindings(notes, two)).not.toThrow();
  });

  it('reports every problem in one error', () => {
    const notes: NotesFile = { version: 1 };
    try {
      assertNotesCoverFindings(notes, verified);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch('PROJ-9');
      expect(msg).toMatch('PROJ-2');
      expect(msg).toMatch(C);
    }
  });
});

describe('buildNoteLookup', () => {
  it('indexes entries so renderers can find them by finding', () => {
    const lookup = buildNoteLookup(complete());
    expect(lookup.noReference.get(commitKey('repo-a', C))?.classification).toBe('tooling-or-ci');
    expect(lookup.unknownReference.get(referenceKey('repo-a', B, 'ticket-key', 'PROJ-9'))?.note).toBe('shipped in 1.3');
    expect(lookup.items.get('PROJ-2')?.classification).toBe('not-done');
    expect(lookup.ranges.get('repo-a')?.classification).toBe('expected-divergence');
  });

  it('returns empty maps for empty notes', () => {
    const lookup = buildNoteLookup({ version: 1 });
    expect(lookup.items.size).toBe(0);
  });
});
