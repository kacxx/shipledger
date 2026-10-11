import { usageError } from './errors.js';
import type {
  ItemNote, NoReferenceNote, NotesFile, RangeNote, UnknownReferenceNote, VerifiedChangeset
} from './types.js';

const SEP = '\u0000';

export const commitKey = (repo: string, sha: string): string => `${repo}${SEP}${sha}`;

export const referenceKey = (
  repo: string, sha: string, matcher: string, token: string
): string => [repo, sha, matcher, token].join(SEP);

export interface NoteLookup {
  noReference: Map<string, NoReferenceNote>;
  /** Reference-level entries, by `referenceKey`. */
  unknownReference: Map<string, UnknownReferenceNote>;
  /** Commit-level entries (no matcher or token), by `commitKey`. */
  unknownReferenceByCommit: Map<string, UnknownReferenceNote>;
  items: Map<string, ItemNote>;
  ranges: Map<string, RangeNote>;
}

export function buildNoteLookup(notes: NotesFile): NoteLookup {
  const lookup: NoteLookup = {
    noReference: new Map(), unknownReference: new Map(), unknownReferenceByCommit: new Map(),
    items: new Map(), ranges: new Map()
  };
  for (const n of notes.noReference ?? []) lookup.noReference.set(commitKey(n.repo, n.sha), n);
  for (const n of notes.unknownReference ?? []) {
    if (n.matcher !== undefined && n.token !== undefined) {
      lookup.unknownReference.set(referenceKey(n.repo, n.sha, n.matcher, n.token), n);
    } else {
      lookup.unknownReferenceByCommit.set(commitKey(n.repo, n.sha), n);
    }
  }
  for (const n of notes.items ?? []) lookup.items.set(n.item, n);
  for (const n of notes.ranges ?? []) lookup.ranges.set(n.repo, n);
  return lookup;
}

/**
 * The note that covers one unresolved reference: its own entry, else its
 * commit's entry. `level` says which, so a renderer can show a commit-level
 * note once per commit.
 */
export function unknownReferenceNote(
  lookup: NoteLookup, repo: string, sha: string, matcher: string, token: string
): { entry: UnknownReferenceNote; level: 'reference' | 'commit' } | undefined {
  const own = lookup.unknownReference.get(referenceKey(repo, sha, matcher, token));
  if (own) return { entry: own, level: 'reference' };
  const shared = lookup.unknownReferenceByCommit.get(commitKey(repo, sha));
  return shared ? { entry: shared, level: 'commit' } : undefined;
}

export function assertNotesCoverFindings(notes: NotesFile, verified: VerifiedChangeset): void {
  const problems: string[] = [];

  const checkSentence = (label: string, note: string): void => {
    if (note.trim() === '') problems.push(`${label} has a whitespace-only note`);
  };

  const section = <T>(
    label: string,
    entries: T[],
    keyOf: (entry: T) => string,
    describeKey: (key: string) => string,
    expected: Set<string>,
    explainUnexpected: (key: string) => string,
    noteOf: (entry: T) => string
  ): void => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = keyOf(entry);
      checkSentence(`${label} entry ${describeKey(key)}`, noteOf(entry));
      if (seen.has(key)) {
        problems.push(`${label} has more than one entry for ${describeKey(key)}`);
        continue;
      }
      seen.add(key);
      if (!expected.has(key)) problems.push(explainUnexpected(key));
    }
    for (const key of expected) {
      if (!seen.has(key)) problems.push(`${label} is missing an entry for ${describeKey(key)}`);
    }
  };

  const bareCommits = new Set(
    verified.commits.filter((c) => c.findings.includes('no-reference')).map((c) => commitKey(c.repo, c.sha))
  );
  const showCommit = (key: string): string => key.split(SEP).join(' ');
  section(
    'noReference', notes.noReference ?? [],
    (n) => commitKey(n.repo, n.sha), showCommit, bareCommits,
    (key) => `noReference names ${showCommit(key)}, which does not carry a no-reference finding`,
    (n) => n.note
  );

  // Only commits carrying an unknown-reference finding need triage: ignored and
  // divergent commits keep unresolved references without raising the finding.
  const unresolved = new Set<string>();
  const unflagged = new Set<string>();
  const resolved = new Set<string>();
  for (const commit of verified.commits) {
    const flagged = commit.findings.includes('unknown-reference');
    for (const ref of commit.references) {
      const key = referenceKey(commit.repo, commit.sha, ref.matcher, ref.token);
      if (ref.resolvesTo.length > 0) resolved.add(key);
      else (flagged ? unresolved : unflagged).add(key);
    }
  }
  const showRef = (key: string): string => {
    const [repo, sha, matcher, token] = key.split(SEP);
    return `${repo} ${sha} ${matcher}=${token}`;
  };
  const refEntries = (notes.unknownReference ?? []).filter((n) => n.matcher !== undefined && n.token !== undefined);
  const commitEntries = (notes.unknownReference ?? []).filter((n) => n.matcher === undefined || n.token === undefined);
  const refKeyOf = (n: UnknownReferenceNote): string => referenceKey(n.repo, n.sha, n.matcher as string, n.token as string);

  // A reference-level entry takes precedence, so a commit-level entry covers
  // the commit's unresolved references that no reference-level entry names.
  const named = new Set(refEntries.map(refKeyOf));
  const commitOf = (key: string): string => key.split(SEP).slice(0, 2).join(SEP);
  const leftByCommit = new Map<string, number>();
  for (const key of unresolved) {
    if (!named.has(key)) leftByCommit.set(commitOf(key), (leftByCommit.get(commitOf(key)) ?? 0) + 1);
  }
  const flaggedCommits = new Set([...unresolved].map(commitOf));
  const unflaggedCommits = new Set([...unflagged].map(commitOf));
  const commitCovered = new Set<string>();
  for (const n of commitEntries) {
    const key = commitKey(n.repo, n.sha);
    checkSentence(`unknownReference entry ${showCommit(key)}`, n.note);
    if (commitCovered.has(key)) {
      problems.push(`unknownReference has more than one commit-level entry for ${showCommit(key)}`);
      continue;
    }
    commitCovered.add(key);
    if (!flaggedCommits.has(key)) {
      problems.push(unflaggedCommits.has(key)
        ? `unknownReference has a commit-level entry for ${showCommit(key)}, which does not carry an unknown-reference finding`
        : `unknownReference has a commit-level entry for ${showCommit(key)}, which has no unresolved references in this artifact`);
    } else if (!leftByCommit.has(key)) {
      problems.push(`unknownReference has a commit-level entry for ${showCommit(key)}, but reference-level entries already cover every unresolved reference on it`);
    }
  }

  section(
    'unknownReference', refEntries, refKeyOf, showRef,
    new Set([...unresolved].filter((key) => named.has(key) || !commitCovered.has(commitOf(key)))),
    (key) => resolved.has(key)
      ? `unknownReference names ${showRef(key)}, a reference that resolved`
      : unflagged.has(key)
        ? `unknownReference names ${showRef(key)}, on a commit that does not carry an unknown-reference finding`
        : `unknownReference names ${showRef(key)}, which is not a reference in this artifact`,
    (n) => n.note
  );

  const orphanItems = new Set(
    verified.items.filter((i) => i.findings.includes('item-without-commits')).map((i) => i.id)
  );
  section(
    'items', notes.items ?? [], (n) => n.item, (k) => k, orphanItems,
    (key) => `items names "${key}", which does not carry an item-without-commits finding`,
    (n) => n.note
  );

  const divergedRepos = new Set(
    verified.ranges.filter((r) => r.findings.includes('range-divergence')).map((r) => r.repo)
  );
  section(
    'ranges', notes.ranges ?? [], (n) => n.repo, (k) => k, divergedRepos,
    (key) => `ranges names "${key}", which does not carry a range-divergence finding`,
    (n) => n.note
  );

  if (problems.length > 0) {
    throw usageError(
      `Notes do not completely and exactly cover the findings:\n${problems.map((p) => `  ${p}`).join('\n')}\n\nOmit --notes to render an explicitly untriaged artifact instead.`
    );
  }
}
