import type {
  CommitRecord, FindingName, PolicyConfig, Reference, Summary, SummaryV1, Violation
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

/**
 * Negative attribution (`no-reference`/`unknown-reference`) is only honest on a
 * linear range: it asserts a reachable commit shipped without a resolvable
 * reference. On a divergent range reachability does not prove shipment, so no such
 * finding is emitted — the commit is marked indeterminate instead (ADR 0008).
 */
export function commitFindings(
  references: Reference[], ignored: boolean, divergent: boolean
): FindingName[] {
  if (ignored || divergent) return [];
  if (references.length === 0) return ['no-reference'];
  return references.some((r) => r.resolvesTo.length === 0) ? ['unknown-reference'] : [];
}

interface Findable { findings: FindingName[] }
interface SummariseCommit extends Findable { ignored: { rule: string } | null }
interface SummariseItem extends Findable { commits: readonly unknown[] }
interface Sets {
  commits: SummariseCommit[];
  items: SummariseItem[];
  ranges: Findable[];
}

function countFinding(
  sets: { commits: Findable[]; items: Findable[]; ranges: Findable[] }, finding: FindingName
): number {
  return sets.commits.filter((c) => c.findings.includes(finding)).length
    + sets.items.filter((i) => i.findings.includes(finding)).length
    + sets.ranges.filter((r) => r.findings.includes(finding)).length;
}

function summariseCommon(sets: Sets): SummaryV1 {
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

export function summariseV1(sets: Sets): SummaryV1 {
  return summariseCommon(sets);
}

interface Attributed { attribution: 'determinate' | 'indeterminate' }

interface AttributedItem extends SummariseItem, Attributed {
  commits: ReadonlyArray<{ attribution: 'determinate' | 'indeterminate' }>;
}

export function summarise(
  sets: {
    commits: Array<SummariseCommit & Attributed>;
    items: AttributedItem[];
    ranges: Findable[];
  }
): Summary {
  return {
    ...summariseCommon(sets),
    itemsLinked: sets.items.filter((i) => i.commits.some((c) => c.attribution === 'determinate')).length,
    indeterminateCommits: sets.commits.filter((c) => c.attribution === 'indeterminate' && c.ignored === null).length,
    indeterminateItems: sets.items.filter((i) => i.attribution === 'indeterminate').length
  };
}

export function decideVerdict(
  args: { commits: Findable[]; items: Findable[]; ranges: Findable[]; policy: PolicyConfig }
): { verdict: 'pass' | 'fail'; violations: Violation[] } {
  const violations: Violation[] = [];
  for (const finding of FINDING_ORDER) {
    if (!args.policy.failOn.includes(finding)) continue;
    const count = countFinding(args, finding);
    if (count > 0) violations.push({ finding, count });
  }
  return { verdict: violations.length > 0 ? 'fail' : 'pass', violations };
}
