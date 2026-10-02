import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotesCoverFindings, buildNoteLookup, commitKey, referenceKey } from '../src/notes.js';
import { validateNotes, validateVerified } from '../src/config/validate.js';
import { renderReport } from '../src/render/report.js';
import { reconcile } from '../src/core/reconcile.js';
import { compileAll } from '../src/core/compile.js';
import { mergeConfig } from '../src/config/load.js';
import {
  ITEM_CLASSIFICATIONS, NO_REFERENCE_CLASSIFICATIONS, RANGE_CLASSIFICATIONS, UNKNOWN_REFERENCE_CLASSIFICATIONS
} from '../src/types.js';
import type { CommitRecord, NotesFile, RangeResult, VerifiedChangesetV2 } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const verified = validateVerified(
  JSON.parse(readFileSync(join(here, 'fixtures', 'verified-example.json'), 'utf8'))
);

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';

function reconcileUnclaimed(subjects: string[], ranges: RangeResult[] = []): VerifiedChangesetV2 {
  const config = mergeConfig({
    version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../a' }]
  }, '/tmp');
  const commits: CommitRecord[] = subjects.map((subject, i) => ({
    repo: 'repo-a', sha: String(i + 1).repeat(40), subject, body: '', author: 'Dev', committedAt: '2026-01-01T00:00:00Z'
  }));
  return reconcile({
    config, compiled: compileAll(config),
    changeset: {
      version: 1, id: 'r', source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [{ id: 'PROJ-1', title: 't', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-1' }] }],
      ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
    },
    commits, ranges,
    cliVersion: '0.3.0', configFingerprint: `sha256:${'0'.repeat(64)}`
  });
}

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

  it('needs no entry for an unclaimed reference on an ignored commit', () => {
    const v = reconcileUnclaimed(['PROJ-1 fix', 'Merge branch PROJ-99']);
    expect(v.commits[1]?.ignored).not.toBeNull();
    expect(() => assertNotesCoverFindings({ version: 1, noReference: [], unknownReference: [], items: [], ranges: [] }, v))
      .not.toThrow();
  });

  it('rejects an entry for an unclaimed reference on an ignored commit', () => {
    const v = reconcileUnclaimed(['PROJ-1 fix', 'Merge branch PROJ-99']);
    const notes: NotesFile = {
      version: 1, noReference: [], items: [], ranges: [],
      unknownReference: [{ repo: 'repo-a', sha: '2'.repeat(40), matcher: 'ticket-key', token: 'PROJ-99', classification: 'typo', note: 'x' }]
    };
    expect(() => assertNotesCoverFindings(notes, v)).toThrow(/does not carry an unknown-reference finding/);
  });

  it('needs no entry for an unclaimed reference on a commit in a divergent range', () => {
    const divergent: RangeResult = {
      repo: 'repo-a', base: 'v1', baseSha: 'b'.repeat(40), head: 'v2', headSha: 'e'.repeat(40),
      include: [], mergeBase: 'c'.repeat(40), baseIsAncestorOfHead: false, commitsOnlyInBase: 1,
      effectiveDelta: [], findings: ['range-divergence']
    };
    const v = reconcileUnclaimed(['PROJ-1 and PROJ-99'], [divergent]);
    expect(v.commits[0]?.findings).toEqual([]);
    const notes: NotesFile = {
      version: 1, noReference: [], unknownReference: [], items: [],
      ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
    };
    expect(() => assertNotesCoverFindings(notes, v)).not.toThrow();
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

  it('preserves impact annotations', () => {
    const notes: NotesFile = {
      version: 2,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', impact: 'test-only', note: 'CI only' }],
    };
    const lookup = buildNoteLookup(notes);
    expect(lookup.noReference.get(commitKey('repo-a', C))?.impact).toBe('test-only');
  });
});

describe('impact axis (WP-001)', () => {
  const notesWithImpact = JSON.parse(
    readFileSync(join(here, 'fixtures', 'notes-with-impact.json'), 'utf8')
  );

  it('validates a notes file with impact annotations against the schema', () => {
    expect(() => validateNotes(notesWithImpact)).not.toThrow();
  });

  it('validates a dual-axis note: tooling-or-ci cause with test-only impact', () => {
    const dual: NotesFile = {
      version: 2,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', impact: 'test-only', note: 'CI config lint' }],
      unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
      items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
      ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }],
    };
    expect(() => validateNotes(dual)).not.toThrow();
    expect(() => assertNotesCoverFindings(dual, verified)).not.toThrow();
  });

  it('validates a notes file without any impact fields (backwards compat)', () => {
    const v2NoImpact = {
      version: 2,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', note: 'lint config only' }],
      unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
      items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
      ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }],
    };
    expect(() => validateNotes(v2NoImpact)).not.toThrow();
  });

  it('still validates version 1 notes without impact (backwards compat)', () => {
    expect(() => validateNotes(complete())).not.toThrow();
  });

  it('shows impact annotations in the rendered report', () => {
    const notes: NotesFile = {
      version: 2,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', impact: 'test-only', note: 'CI config lint' }],
      unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
      items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
      ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }],
    };
    const report = renderReport(verified, notes);
    expect(report).toContain('tooling-or-ci (test-only)');
  });

  it('does not show impact parenthetical when impact is absent', () => {
    const report = renderReport(verified, complete());
    expect(report).toContain('tooling-or-ci:');
    expect(report).not.toContain('tooling-or-ci (');
  });

  it('range-growth stability: extending head does not re-key existing triage', () => {
    const notes = complete();
    // C's no-reference triage resolves against the original changeset.
    expect(renderReport(verified, notes)).toContain('tooling-or-ci');

    // Grow the changeset with an extra commit, as if head advanced. A commit's
    // key is (repo, sha) only, so C's existing note must still resolve — if the
    // key ever incorporated range/head state, this triage would silently drop.
    const grown = {
      ...verified,
      commits: [
        ...verified.commits,
        { ...verified.commits.find((c) => c.sha === A)!, sha: 'f'.repeat(40) },
      ],
    };
    expect(renderReport(grown, notes)).toContain('tooling-or-ci');
  });

  it('determinism: triage-note ordering does not change the report', () => {
    const E = 'e'.repeat(40);
    const twoBare = {
      ...verified,
      commits: [
        ...verified.commits,
        { ...verified.commits.find((c) => c.sha === C)!, sha: E },
      ],
    };
    // Two no-reference findings, both triaged. The renderer keys notes by
    // (repo, sha), so the order of the noReference array must not affect output.
    const forward: NotesFile = {
      ...complete(),
      noReference: [
        { repo: 'repo-a', sha: C, classification: 'tooling-or-ci', note: 'first' },
        { repo: 'repo-a', sha: E, classification: 'revert', note: 'second' },
      ],
    };
    const reversed: NotesFile = {
      ...forward,
      noReference: [...forward.noReference!].reverse(),
    };
    expect(renderReport(twoBare, forward)).toBe(renderReport(twoBare, reversed));
  });
});

describe('schema classification vocabulary', () => {
  const schema = JSON.parse(readFileSync(join(here, '..', 'schemas', 'notes.schema.json'), 'utf8'));
  const enumOf = (section: string): string[] => schema.properties[section].items.properties.classification.enum;

  it('matches the classification constants exactly', () => {
    expect(enumOf('noReference')).toEqual([...NO_REFERENCE_CLASSIFICATIONS]);
    expect(enumOf('unknownReference')).toEqual([...UNKNOWN_REFERENCE_CLASSIFICATIONS]);
    expect(enumOf('items')).toEqual([...ITEM_CLASSIFICATIONS]);
    expect(enumOf('ranges')).toEqual([...RANGE_CLASSIFICATIONS]);
  });

  it('accepts security-advisory and merged-via-another-change in version 1 notes', () => {
    expect(() => validateNotes({
      version: 1,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'security-advisory', note: 'fix for advisory GHSA-xxxx-xxxx-xxxx' }],
      items: [{ item: 'PROJ-2', classification: 'merged-via-another-change', note: 'merged into the feature branch' }]
    })).not.toThrow();
  });

  it('accepts security-advisory and merged-via-another-change in version 2 notes with impact', () => {
    expect(() => validateNotes({
      version: 2,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'security-advisory', impact: 'no-runtime-impact', note: 'fix for advisory GHSA-xxxx-xxxx-xxxx' }],
      items: [{ item: 'PROJ-2', classification: 'merged-via-another-change', impact: 'test-only', note: 'merged into the feature branch' }]
    })).not.toThrow();
  });
});

describe('schema gates impact to version 2', () => {
  it('rejects impact on a version 1 notes file', () => {
    const v1WithImpact = {
      version: 1,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', impact: 'test-only', note: 'CI only' }],
    };
    expect(() => validateNotes(v1WithImpact)).toThrow();
  });

  it('accepts impact on a version 2 notes file', () => {
    const v2WithImpact = {
      version: 2,
      noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', impact: 'test-only', note: 'CI only' }],
    };
    expect(() => validateNotes(v2WithImpact)).not.toThrow();
  });
});
