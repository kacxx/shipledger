import { buildNoteLookup, commitKey, referenceKey } from '../notes.js';
import type { NotesFile, VerifiedChangeset } from '../types.js';

function classificationLabel(n: { classification: string; impact?: string }): string {
  return n.impact ? `${n.classification} (${n.impact})` : n.classification;
}

export function renderChangelog(verified: VerifiedChangeset, notes?: NotesFile): string {
  const lookup = buildNoteLookup(notes ?? { version: 1 });
  const out: string[] = [`# ${verified.changeset.id}`, ''];

  // Only determinately-satisfied items are presented as changes; an
  // indeterminate-linked item has commits but unprovable attribution (ADR 0008)
  // and is surfaced separately rather than claimed as shipped. `attribution` is
  // absent on a v1 artifact, so v1 rendering is unchanged.
  const items = verified.items as Array<{
    id: string; title: string; status: string; commits: unknown[];
    findings: string[]; attribution?: string;
  }>;
  const isIndeterminate = (i: { attribution?: string }): boolean => i.attribution === 'indeterminate';
  const linked = items.filter((i) => i.commits.length > 0 && !isIndeterminate(i));
  if (linked.length > 0) {
    out.push('## Changes', '');
    for (const item of linked) {
      const n = item.commits.length;
      out.push(`- **${item.id}** ${item.title} (${n} commit${n === 1 ? '' : 's'})`);
    }
    out.push('');
  }

  const indeterminate = items.filter(isIndeterminate);
  if (indeterminate.length > 0) {
    out.push('## Attribution indeterminate (divergent range)', '');
    for (const i of indeterminate) {
      const n = i.commits.length;
      out.push(`- **${i.id}** ${i.title}${n > 0 ? ` (${n} indeterminate commit${n === 1 ? '' : 's'})` : ''}`);
    }
    out.push('');
  }

  const unaccounted = verified.commits.filter(
    (c) => c.findings.includes('unknown-reference') || c.findings.includes('no-reference')
  );
  if (unaccounted.length > 0) {
    out.push('## Unaccounted commits', '');
    for (const c of unaccounted) {
      const unresolved = c.references.filter((r) => r.resolvesTo.length === 0);
      const dispositions = unresolved
        .map((r) => lookup.unknownReference.get(referenceKey(c.repo, c.sha, r.matcher, r.token)))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map((n) => classificationLabel(n));
      const bare = lookup.noReference.get(commitKey(c.repo, c.sha));
      const tags = [...dispositions, ...(bare ? [classificationLabel(bare)] : [])];
      const refs = unresolved.length > 0 ? ` (refs ${unresolved.map((r) => r.token).join(', ')})` : '';
      out.push(`- \`${c.repo} ${c.sha.slice(0, 8)}\` ${c.subject}${refs}${tags.length > 0 ? ` — ${tags.join(', ')}` : ''}`);
    }
    out.push('');
  }

  const orphans = verified.items.filter((i) => i.findings.includes('item-without-commits'));
  if (orphans.length > 0) {
    out.push('## Claimed but not found in git', '');
    for (const i of orphans) {
      const note = lookup.items.get(i.id);
      out.push(`- **${i.id}** ${i.title}${i.status ? ` [${i.status}]` : ''}${note ? ` — ${classificationLabel(note)}` : ''}`);
    }
    out.push('');
  }

  const diverged = verified.ranges.filter((r) => r.findings.includes('range-divergence'));
  if (diverged.length > 0) {
    out.push('## Incomplete ranges', '');
    for (const r of diverged) {
      const note = lookup.ranges.get(r.repo);
      out.push(`- \`${r.repo}\` ${r.base}..${r.head} — ${r.commitsOnlyInBase} commit(s) only in base are not represented${note ? ` — ${classificationLabel(note)}` : ''}`);
    }
    out.push('');
  }

  const n = verified.summary.commitsIgnored;
  const triage = notes === undefined ? ' Findings are untriaged.' : '';
  out.push(`_Generated from a verified changeset (${verified.configFingerprint}, preset ${verified.preset}). ${n} commit${n === 1 ? '' : 's'} ignored by configured rules.${triage}_`);
  return `${out.join('\n')}\n`;
}
