import { oneLine } from './text.js';
import type { NotesFile, VerifiedChangeset } from '../types.js';

/**
 * True for a v2 item whose shipment attribution is indeterminate. A v1 item has no
 * attribution field, so it is never indeterminate — v1 rendering is unchanged.
 */
const isIndeterminate = (i: { attribution?: string }): boolean => i.attribution === 'indeterminate';

const entry = (i: { id: string; title: string }): string => `${oneLine(i.title)} (${oneLine(i.id)})`;

export function renderReleaseNotes(verified: VerifiedChangeset, notes?: NotesFile): string {
  const out: string[] = [`## ${oneLine(verified.changeset.id)}`, ''];

  // `attribution` is absent on a v1 artifact, so v1 rendering is unchanged.
  const items = verified.items as Array<{
    id: string; title: string; type: string; status: string; commits: unknown[];
    findings: string[]; attribution?: string;
  }>;

  // Only determinately-satisfied items are shipped work. An indeterminate-linked
  // item has commits but its attribution is unprovable, so it must not be listed as
  // shipped (ADR 0008) — it is surfaced separately below.
  const byType = new Map<string, Array<{ id: string; title: string }>>();
  let shippedCount = 0;
  for (const item of items) {
    if (item.commits.length === 0 || isIndeterminate(item)) continue;
    shippedCount++;
    const bucket = byType.get(item.type) ?? [];
    bucket.push({ id: item.id, title: item.title });
    byType.set(item.type, bucket);
  }

  for (const [type, items] of byType) {
    out.push(`### ${oneLine(type)}`, '');
    for (const item of items) out.push(`* ${entry(item)}`);
    out.push('');
  }

  const indeterminate = items.filter(isIndeterminate);
  if (indeterminate.length > 0) {
    out.push('### attribution indeterminate (divergent range)', '');
    for (const i of indeterminate) out.push(`* ${entry(i)}`);
    out.push('');
  }

  // Triage says these shipped inside another change, but git cannot confirm it, so
  // they are listed apart from both shipped work and work with no code.
  const viaOther = new Set(
    (notes?.items ?? []).filter((n) => n.classification === 'merged-via-another-change').map((n) => n.item)
  );
  const withoutCommits = items.filter((i) => i.findings.includes('item-without-commits'));
  const orphans = withoutCommits.filter((i) => !viaOther.has(i.id));
  const shippedInside = withoutCommits.filter((i) => viaOther.has(i.id));
  if (orphans.length > 0) {
    out.push('### claimed but not in git', '');
    for (const i of orphans) {
      out.push(`* ~${oneLine(i.title)}~ (${oneLine(i.id)})${i.status ? ` [${oneLine(i.status)}]` : ''}`);
    }
    out.push('');
  }
  if (shippedInside.length > 0) {
    out.push('### shipped inside another change (triaged, not verified against git)', '');
    for (const i of shippedInside) out.push(`* ${entry(i)}`);
    out.push('');
  }

  const s = verified.summary;
  const caveats: string[] = [];
  const noCode = s.itemsWithoutCommits - shippedInside.length;
  if (s.unknownReference > 0) caveats.push(`${s.unknownReference} commit(s) reference other releases`);
  if (s.noReference > 0) caveats.push(`${s.noReference} unreferenced`);
  if (noCode > 0) caveats.push(`${noCode} claimed with no code`);
  if (shippedInside.length > 0) caveats.push(`${shippedInside.length} triaged as shipped inside another change`);
  if ('indeterminateItems' in s && s.indeterminateItems > 0) {
    caveats.push(`${s.indeterminateItems} item(s) with indeterminate attribution`);
  }
  if (s.rangeDivergence > 0) caveats.push(`${s.rangeDivergence} incomplete range(s)`);
  if ((notes?.items ?? []).some((n) => n.classification === 'not-done')) {
    caveats.push('at least one claimed item was not done');
  }
  if (notes === undefined) caveats.push('findings untriaged');

  out.push(`<sub>${shippedCount}/${s.items} claimed items verified against git · ${s.commits} commits${caveats.length > 0 ? ` · ${caveats.join(' · ')}` : ''}</sub>`);
  return `${out.join('\n')}\n`;
}
