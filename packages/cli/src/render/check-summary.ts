import type { VerifiedChangesetV2 } from '../types.js';

const MAX_FINDING_LINES = 20;

/** A short human summary of a check result. The artifact remains the record. */
export function renderCheckSummary(verified: VerifiedChangesetV2, outPath: string): string {
  const { summary } = verified;
  const counts = [
    `items linked ${summary.itemsLinked}/${summary.items}`,
    `commits ${summary.commits}`,
    `ignored ${summary.commitsIgnored}`
  ];
  if (summary.indeterminateCommits > 0 || summary.indeterminateItems > 0) {
    counts.push(`indeterminate ${summary.indeterminateCommits} commits/${summary.indeterminateItems} items`);
  }
  const violations = verified.violations.map((v) => `${v.finding}=${v.count}`).join(', ');
  const head = verified.verdict === 'pass'
    ? `PASS  ${verified.changeset.id}  ${counts.join(', ')}`
    : `FAIL  ${verified.changeset.id}  ${violations}; ${counts.join(', ')}`;

  const findings: string[] = [];
  for (const r of verified.ranges) {
    for (const f of r.findings) findings.push(`  ${f}  ${r.repo} ${r.base}..${r.head}`);
  }
  for (const c of verified.commits) {
    for (const f of c.findings) findings.push(`  ${f}  ${c.repo} ${c.sha.slice(0, 7)}  ${c.subject}`);
  }
  for (const i of verified.items) {
    for (const f of i.findings) findings.push(`  ${f}  ${i.id}  ${i.title}`);
  }
  const shown = findings.slice(0, MAX_FINDING_LINES);
  if (findings.length > shown.length) {
    shown.push(`  … and ${findings.length - shown.length} more in ${outPath}`);
  }

  return [head, ...shown, `Wrote ${outPath}`, ''].join('\n');
}
