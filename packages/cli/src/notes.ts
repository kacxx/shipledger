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
  unknownReference: Map<string, UnknownReferenceNote>;
  items: Map<string, ItemNote>;
  ranges: Map<string, RangeNote>;
}

export function buildNoteLookup(notes: NotesFile): NoteLookup {
  const lookup: NoteLookup = {
    noReference: new Map(), unknownReference: new Map(), items: new Map(), ranges: new Map()
  };
  for (const n of notes.noReference ?? []) lookup.noReference.set(commitKey(n.repo, n.sha), n);
  for (const n of notes.unknownReference ?? []) {
    lookup.unknownReference.set(referenceKey(n.repo, n.sha, n.matcher, n.token), n);
  }
  for (const n of notes.items ?? []) lookup.items.set(n.item, n);
  for (const n of notes.ranges ?? []) lookup.ranges.set(n.repo, n);
  return lookup;
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

  const unresolved = new Set<string>();
  const resolved = new Set<string>();
  for (const commit of verified.commits) {
    for (const ref of commit.references) {
      const key = referenceKey(commit.repo, commit.sha, ref.matcher, ref.token);
      (ref.resolvesTo.length === 0 ? unresolved : resolved).add(key);
    }
  }
  const showRef = (key: string): string => {
    const [repo, sha, matcher, token] = key.split(SEP);
    return `${repo} ${sha} ${matcher}=${token}`;
  };
  section(
    'unknownReference', notes.unknownReference ?? [],
    (n) => referenceKey(n.repo, n.sha, n.matcher, n.token), showRef, unresolved,
    (key) => resolved.has(key)
      ? `unknownReference names ${showRef(key)}, a reference that resolved`
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
