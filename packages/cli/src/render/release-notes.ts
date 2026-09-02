import type { NotesFile, VerifiedChangeset } from '../types.js';

export function renderReleaseNotes(verified: VerifiedChangeset, notes?: NotesFile): string {
  const out: string[] = [`## ${verified.changeset.id}`, ''];

  const byType = new Map<string, typeof verified.items>();
  for (const item of verified.items.filter((i) => i.commits.length > 0)) {
    const bucket = byType.get(item.type) ?? [];
    bucket.push(item);
    byType.set(item.type, bucket);
  }

  for (const [type, items] of byType) {
    out.push(`### ${type}`, '');
    for (const item of items) out.push(`* ${item.title} (${item.id})`);
    out.push('');
  }

  const s = verified.summary;
  const caveats: string[] = [];
  if (s.unknownReference > 0) caveats.push(`${s.unknownReference} commit(s) reference other releases`);
  if (s.noReference > 0) caveats.push(`${s.noReference} unreferenced`);
  if (s.itemsWithoutCommits > 0) caveats.push(`${s.itemsWithoutCommits} claimed with no code`);
  if (s.rangeDivergence > 0) caveats.push(`${s.rangeDivergence} incomplete range(s)`);
  if ((notes?.items ?? []).some((n) => n.classification === 'not-done')) {
    caveats.push('at least one claimed item was not done');
  }
  if (notes === undefined) caveats.push('findings untriaged');

  out.push(`<sub>${s.itemsLinked}/${s.items} claimed items verified against git · ${s.commits} commits${caveats.length > 0 ? ` · ${caveats.join(' · ')}` : ''}</sub>`);
  return `${out.join('\n')}\n`;
}
