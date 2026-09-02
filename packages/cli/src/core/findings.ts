import type {
  CommitRecord, CommitResult, FindingName, ItemResult,
  PolicyConfig, RangeResult, Reference, Summary, Violation
} from '../types.js';
import type { CompiledIgnore } from './compile.js';

export const FINDING_ORDER: FindingName[] = [
  'no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'
];

/** Authors compare by exact equality; subjects by regex. */
export function matchIgnoreRule(commit: CommitRecord, ignore: CompiledIgnore): string | null {
  if (ignore.authors.has(commit.author)) return `authors:${commit.author}`;
  for (const { pattern, regex } of ignore.subjects) {
    if (regex.test(commit.subject)) return `subjects:${pattern}`;
  }
  return null;
}

export function commitFindings(references: Reference[], ignored: boolean): FindingName[] {
  if (ignored) return [];
  if (references.length === 0) return ['no-reference'];
  return references.some((r) => r.resolvesTo.length === 0) ? ['unknown-reference'] : [];
}

interface Sets { commits: CommitResult[]; items: ItemResult[]; ranges: RangeResult[] }

function countFinding(sets: Sets, finding: FindingName): number {
  return sets.commits.filter((c) => c.findings.includes(finding)).length
    + sets.items.filter((i) => i.findings.includes(finding)).length
    + sets.ranges.filter((r) => r.findings.includes(finding)).length;
}

export function summarise(sets: Sets): Summary {
  return {
    items: sets.items.length,
    itemsLinked: sets.items.filter((i) => i.commits.length > 0).length,
    commits: sets.commits.length,
    commitsIgnored: sets.commits.filter((c) => c.ignored !== null).length,
    noReference: countFinding(sets, 'no-reference'),
    unknownReference: countFinding(sets, 'unknown-reference'),
    itemsWithoutCommits: countFinding(sets, 'item-without-commits'),
    rangeDivergence: countFinding(sets, 'range-divergence')
  };
}

export function decideVerdict(
  args: Sets & { policy: PolicyConfig }
): { verdict: 'pass' | 'fail'; violations: Violation[] } {
  const violations: Violation[] = [];
  for (const finding of FINDING_ORDER) {
    if (!args.policy.failOn.includes(finding)) continue;
    const count = countFinding(args, finding);
    if (count > 0) violations.push({ finding, count });
  }
  return { verdict: violations.length > 0 ? 'fail' : 'pass', violations };
}
