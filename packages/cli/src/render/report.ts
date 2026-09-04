import { buildNoteLookup, commitKey, referenceKey } from '../notes.js';
import type { NotesFile, VerifiedChangeset } from '../types.js';

const short = (sha: string): string => sha.slice(0, 8);

function suffix(entry: { classification: string; note: string } | undefined): string {
  return entry ? ` [${entry.classification}: ${entry.note}]` : '';
}

export function renderReport(verified: VerifiedChangeset, notes?: NotesFile): string {
  const out: string[] = [];
  const s = verified.summary;
  const lookup = buildNoteLookup(notes ?? { version: 1 });

  out.push(`shipledger report — ${verified.changeset.id}`);
  out.push(`verdict: ${verified.verdict.toUpperCase()}   preset: ${verified.preset}   history: ${verified.history}`);
  if (verified.violations.length > 0) {
    out.push(`violations: ${verified.violations.map((v) => `${v.finding}=${v.count}`).join(', ')}`);
  }
  out.push(`items ${s.itemsLinked}/${s.items} linked · commits ${s.commits} (${s.commitsIgnored} ignored)`);
  if (notes === undefined) out.push('triage: UNTRIAGED — no notes supplied');
  out.push('');

  for (const range of verified.ranges) {
    if (range.baseIsAncestorOfHead) {
      out.push(`OK   range ${range.repo} ${range.base}..${range.head}`);
    } else {
      out.push(
        `WARN range ${range.repo} ${range.base}..${range.head} — refs diverge; ${range.commitsOnlyInBase} commit(s) reachable from base but not head are invisible${suffix(lookup.ranges.get(range.repo))}`
      );
    }
  }

  const unknown = verified.commits.filter((c) => c.findings.includes('unknown-reference'));
  if (unknown.length > 0) {
    out.push('');
    out.push(`Commits referencing work outside this release (${unknown.length}):`);
    for (const c of unknown) {
      out.push(`  ${c.repo} ${short(c.sha)} · ${c.subject}`);
      for (const ref of c.references.filter((r) => r.resolvesTo.length === 0)) {
        const entry = lookup.unknownReference.get(referenceKey(c.repo, c.sha, ref.matcher, ref.token));
        out.push(`    → ${ref.token} (${ref.matcher}, seen in ${ref.sources.join('+')})${suffix(entry)}`);
      }
      const linked = c.references.flatMap((r) => r.resolvesTo);
      if (linked.length > 0) out.push(`    also linked to ${[...new Set(linked)].join(', ')}`);
    }
  }

  const bare = verified.commits.filter((c) => c.findings.includes('no-reference'));
  if (bare.length > 0) {
    out.push('');
    out.push(`Commits with no reference (${bare.length}):`);
    for (const c of bare) {
      out.push(`  ${c.repo} ${short(c.sha)} · ${c.subject}${suffix(lookup.noReference.get(commitKey(c.repo, c.sha)))}`);
    }
  }

  const orphans = verified.items.filter((i) => i.findings.includes('item-without-commits'));
  if (orphans.length > 0) {
    out.push('');
    out.push(`Items claimed with no commits (${orphans.length}):`);
    for (const i of orphans) {
      out.push(`  ${i.id} · ${i.title}${i.status ? ` (${i.status})` : ''}${suffix(lookup.items.get(i.id))}`);
    }
  }

  const ignored = verified.commits.filter((c) => c.ignored !== null);
  if (ignored.length > 0) {
    out.push('');
    out.push(`Ignored (${ignored.length}):`);
    for (const c of ignored) {
      out.push(`  ${c.repo} ${short(c.sha)} · ${c.subject} — ${c.ignored?.rule}`);
    }
  }

  return `${out.join('\n')}\n`;
}
