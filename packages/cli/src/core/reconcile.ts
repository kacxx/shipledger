import { extractReferences } from './tokens.js';
import { buildItemIndex, resolveReferences } from './index-items.js';
import { commitFindings, decideVerdict, matchIgnoreRule, summarise } from './findings.js';
import type { CompiledIgnore, CompiledMatcher } from './compile.js';
import type {
  Attribution, Changeset, CommitRecord, CommitResult, ItemLink, ItemResult, RangeResult,
  ResolvedConfig, VerifiedChangesetV2
} from '../types.js';

export interface ReconcileInput {
  config: ResolvedConfig;
  compiled: { matchers: CompiledMatcher[]; ignore: CompiledIgnore };
  changeset: Changeset;
  commits: CommitRecord[];
  ranges: RangeResult[];
  cliVersion: string;
  configFingerprint: string;
  now?: string;
}

export function reconcile(input: ReconcileInput): VerifiedChangesetV2 {
  const { config, changeset, compiled } = input;
  const index = buildItemIndex(changeset, config.matchers);
  const repoOrder = new Map(config.repos.map((r, i) => [r.name, i]));

  // A commit's attribution follows its range: reachability proves shipment only
  // where base is an ancestor of head. Any divergent range in the run also decides
  // how a no-link item is treated (ADR 0008 — run-level indeterminacy scope).
  const divergentRepos = new Set(
    input.ranges.filter((r) => !r.baseIsAncestorOfHead).map((r) => r.repo)
  );
  const divergentInRun = divergentRepos.size > 0;

  const linksByItem = new Map<string, ItemLink[]>();
  for (const item of changeset.items) linksByItem.set(item.id, []);

  const commits: CommitResult[] = input.commits.map((commit) => {
    const divergent = divergentRepos.has(commit.repo);
    const attribution: Attribution = divergent ? 'indeterminate' : 'determinate';
    const base = {
      repo: commit.repo, sha: commit.sha, subject: commit.subject, body: commit.body,
      author: commit.author, committedAt: commit.committedAt
    };

    const rule = matchIgnoreRule(commit, compiled.ignore);
    if (rule !== null) {
      return { ...base, attribution, ignored: { rule }, references: [], findings: [] };
    }

    const { references, links } = resolveReferences(
      extractReferences(commit, compiled.matchers), commit.repo, index
    );
    // References are retained on divergent commits for display and to keep every
    // item link; the link carries the commit's attribution so a divergent commit
    // never satisfies an item on its own.
    for (const { itemId } of links) {
      const bucket = linksByItem.get(itemId);
      if (!bucket) continue;
      if (!bucket.some((c) => c.repo === commit.repo && c.sha === commit.sha)) {
        bucket.push({ repo: commit.repo, sha: commit.sha, attribution });
      }
    }
    return {
      ...base, attribution, ignored: null, references,
      findings: commitFindings(references, false, divergent)
    };
  });

  const items: ItemResult[] = changeset.items.map((item) => {
    const linked = linksByItem.get(item.id) ?? [];
    const hasDeterminate = linked.some((l) => l.attribution === 'determinate');

    let attribution: Attribution;
    let findings: ItemResult['findings'];
    if (hasDeterminate) {
      // At least one determinate link ships the item, even alongside divergence.
      attribution = 'determinate';
      findings = [];
    } else if (linked.length === 0 && !divergentInRun) {
      attribution = 'determinate';
      findings = ['item-without-commits'];
    } else {
      // No determinate link, and either an indeterminate link (linked.length > 0)
      // or a divergent range in the run: the item cannot be safely called missing,
      // nor is it satisfied.
      attribution = 'indeterminate';
      findings = [];
    }

    return {
      id: item.id, title: item.title, type: item.type, status: item.status,
      commits: linked, attribution, findings
    };
  });

  const ranges = [...input.ranges].sort(
    (a, b) => (repoOrder.get(a.repo) ?? 0) - (repoOrder.get(b.repo) ?? 0)
  );

  const sets = { commits, items, ranges };
  const { verdict, violations } = decideVerdict({ ...sets, policy: config.policy });

  return {
    version: 2,
    ...(input.now === undefined ? {} : { generatedAt: input.now }),
    cliVersion: input.cliVersion,
    preset: `${config.presetName}@${config.presetVersion}`,
    history: config.history,
    configFingerprint: input.configFingerprint,
    policy: config.policy,
    changeset: { id: changeset.id, source: changeset.source, items: changeset.items },
    ...(config.links ? { links: config.links } : {}),
    ranges,
    commits,
    items,
    summary: summarise(sets),
    verdict,
    violations
  };
}
