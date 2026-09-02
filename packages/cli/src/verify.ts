import { usageError } from './errors.js';
import { decideVerdict, summarise } from './core/findings.js';
import { canonicalStringify } from './core/canonical.js';
import { commitKey } from './notes.js';
import type { FindingName, VerifiedChangeset } from './types.js';

export function assertVerifiedSemantics(verified: VerifiedChangeset): void {
  const problems: string[] = [];

  const commitIds = new Set(verified.commits.map((c) => commitKey(c.repo, c.sha)));
  const itemIds = new Set(verified.items.map((i) => i.id));

  const changesetIds = verified.changeset.items.map((i) => i.id);
  if (canonicalStringify(changesetIds) !== canonicalStringify(verified.items.map((i) => i.id))) {
    problems.push('items do not match the embedded changeset items, in id or in order');
  }

  for (const item of verified.items) {
    const csItem = verified.changeset.items.find((ci) => ci.id === item.id);
    if (csItem) {
      if (item.title !== csItem.title) problems.push(`item "${item.id}" title "${item.title}" differs from changeset "${csItem.title}"`);
      if (item.type !== csItem.type) problems.push(`item "${item.id}" type "${item.type}" differs from changeset "${csItem.type}"`);
      if (item.status !== csItem.status) problems.push(`item "${item.id}" status "${item.status}" differs from changeset "${csItem.status}"`);
    }
  }

  const derivedLinks = new Map<string, Array<{ repo: string; sha: string }>>();
  for (const item of verified.items) derivedLinks.set(item.id, []);

  for (const commit of verified.commits) {
    const where = `commit ${commit.repo} ${commit.sha.slice(0, 8)}`;

    if (commit.ignored !== null) {
      if (commit.findings.length > 0) problems.push(`${where} is ignored but carries findings`);
      if (commit.references.length > 0) problems.push(`${where} is ignored but carries references`);
    }

    for (const ref of commit.references) {
      for (const id of ref.resolvesTo) {
        if (!itemIds.has(id)) {
          problems.push(`${where} resolves ${ref.token} to "${id}", which is not an item`);
        } else {
          const bucket = derivedLinks.get(id)!;
          if (!bucket.some((c) => c.repo === commit.repo && c.sha === commit.sha)) {
            bucket.push({ repo: commit.repo, sha: commit.sha });
          }
        }
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
      if (!commitIds.has(commitKey(link.repo, link.sha))) {
        problems.push(`item "${item.id}" links ${link.repo} ${link.sha.slice(0, 8)}, which is not present in commits`);
      }
    }

    const derived = derivedLinks.get(item.id) ?? [];
    if (canonicalStringify(item.commits) !== canonicalStringify(derived)) {
      problems.push(`item "${item.id}" declares commits ${canonicalStringify(item.commits)} but references in commits imply ${canonicalStringify(derived)}`);
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

  const { verdict: expectedVerdict, violations: expectedViolations } = decideVerdict({
    commits: verified.commits, items: verified.items, ranges: verified.ranges,
    policy: verified.policy
  });
  if (canonicalStringify(verified.violations) !== canonicalStringify(expectedViolations)) {
    problems.push(`violations ${canonicalStringify(verified.violations)} do not match the policy and findings (expected ${canonicalStringify(expectedViolations)})`);
  }
  if (verified.verdict !== expectedVerdict) {
    problems.push(`verdict "${verified.verdict}" contradicts the policy and findings (expected "${expectedVerdict}")`);
  }

  if (problems.length > 0) {
    throw usageError(`Verified changeset is internally inconsistent:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
