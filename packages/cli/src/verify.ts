import { usageError } from './errors.js';
import { FINDING_ORDER, summarise } from './core/findings.js';
import { canonicalStringify } from './core/canonical.js';
import type { FindingName, VerifiedChangeset } from './types.js';

export function assertVerifiedSemantics(verified: VerifiedChangeset): void {
  const problems: string[] = [];

  const commitIds = new Set(verified.commits.map((c) => `${c.repo}\u0000${c.sha}`));
  const itemIds = new Set(verified.items.map((i) => i.id));

  const changesetIds = verified.changeset.items.map((i) => i.id);
  if (canonicalStringify(changesetIds) !== canonicalStringify(verified.items.map((i) => i.id))) {
    problems.push('items do not match the embedded changeset items, in id or in order');
  }

  for (const commit of verified.commits) {
    const where = `commit ${commit.repo} ${commit.sha.slice(0, 8)}`;

    if (commit.ignored !== null) {
      if (commit.findings.length > 0) problems.push(`${where} is ignored but carries findings`);
      if (commit.references.length > 0) problems.push(`${where} is ignored but carries references`);
    }

    for (const ref of commit.references) {
      for (const id of ref.resolvesTo) {
        if (!itemIds.has(id)) problems.push(`${where} resolves ${ref.token} to "${id}", which is not an item`);
      }
    }

    const expected: FindingName[] = commit.ignored !== null
      ? []
      : commit.references.length === 0
        ? ['no-reference']
        : commit.references.some((r) => r.resolvesTo.length === 0) ? ['unknown-reference'] : [];
    if (canonicalStringify(commit.findings) !== canonicalStringify(expected)) {
      problems.push(`${where} declares findings [${commit.findings.join(', ')}] but its references imply [${expected.join(', ')}]`);
    }
  }

  for (const item of verified.items) {
    for (const link of item.commits) {
      if (!commitIds.has(`${link.repo}\u0000${link.sha}`)) {
        problems.push(`item "${item.id}" links ${link.repo} ${link.sha.slice(0, 8)}, which is not present in commits`);
      }
    }
    const expected: FindingName[] = item.commits.length === 0 ? ['item-without-commits'] : [];
    if (canonicalStringify(item.findings) !== canonicalStringify(expected)) {
      problems.push(`item "${item.id}" declares findings [${item.findings.join(', ')}] but has ${item.commits.length} commit(s), implying [${expected.join(', ')}]`);
    }
  }

  for (const range of verified.ranges) {
    const expected: FindingName[] = range.baseIsAncestorOfHead ? [] : ['range-divergence'];
    if (canonicalStringify(range.findings) !== canonicalStringify(expected)) {
      problems.push(`range "${range.repo}" declares findings [${range.findings.join(', ')}] but baseIsAncestorOfHead=${range.baseIsAncestorOfHead} implies [${expected.join(', ')}]`);
    }
  }

  const recomputed = summarise(verified);
  if (canonicalStringify(recomputed) !== canonicalStringify(verified.summary)) {
    problems.push(`summary does not match the commits, items, and ranges it describes (recomputed ${canonicalStringify(recomputed)})`);
  }

  const actual = new Map<FindingName, number>();
  for (const finding of FINDING_ORDER) {
    const count = verified.commits.filter((c) => c.findings.includes(finding)).length
      + verified.items.filter((i) => i.findings.includes(finding)).length
      + verified.ranges.filter((r) => r.findings.includes(finding)).length;
    actual.set(finding, count);
  }
  for (const violation of verified.violations) {
    if (actual.get(violation.finding) !== violation.count) {
      problems.push(`violation "${violation.finding}" claims count ${violation.count} but ${actual.get(violation.finding)} finding(s) are present`);
    }
  }
  const expectedVerdict = verified.violations.length > 0 ? 'fail' : 'pass';
  if (verified.verdict !== expectedVerdict) {
    problems.push(`verdict "${verified.verdict}" contradicts ${verified.violations.length} violation(s)`);
  }

  if (problems.length > 0) {
    throw usageError(`Verified changeset is internally inconsistent:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
