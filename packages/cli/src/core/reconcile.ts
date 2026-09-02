import { extractReferences } from './tokens.js';
import { buildItemIndex, resolveReferences } from './index-items.js';
import { commitFindings, decideVerdict, matchIgnoreRule, summarise } from './findings.js';
import type { CompiledIgnore, CompiledMatcher } from './compile.js';
import type {
  Changeset, CommitRecord, CommitResult, ItemResult, RangeResult,
  ResolvedConfig, VerifiedChangeset
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

export function reconcile(input: ReconcileInput): VerifiedChangeset {
  const { config, changeset, compiled } = input;
  const index = buildItemIndex(changeset, config.matchers);
  const repoOrder = new Map(config.repos.map((r, i) => [r.name, i]));

  const linksByItem = new Map<string, Array<{ repo: string; sha: string }>>();
  for (const item of changeset.items) linksByItem.set(item.id, []);

  const commits: CommitResult[] = input.commits.map((commit) => {
    const base = {
      repo: commit.repo, sha: commit.sha, subject: commit.subject, body: commit.body,
      author: commit.author, committedAt: commit.committedAt
    };

    const rule = matchIgnoreRule(commit, compiled.ignore);
    if (rule !== null) {
      return { ...base, ignored: { rule }, references: [], findings: [] };
    }

    const { references, links } = resolveReferences(
      extractReferences(commit, compiled.matchers), commit.repo, index
    );
    for (const { itemId } of links) {
      const bucket = linksByItem.get(itemId);
      if (!bucket) continue;
      if (!bucket.some((c) => c.repo === commit.repo && c.sha === commit.sha)) {
        bucket.push({ repo: commit.repo, sha: commit.sha });
      }
    }
    return { ...base, ignored: null, references, findings: commitFindings(references, false) };
  });

  const items: ItemResult[] = changeset.items.map((item) => {
    const linked = linksByItem.get(item.id) ?? [];
    return {
      id: item.id, title: item.title, type: item.type, status: item.status,
      commits: linked,
      findings: linked.length === 0 ? ['item-without-commits'] : []
    };
  });

  const ranges = [...input.ranges].sort(
    (a, b) => (repoOrder.get(a.repo) ?? 0) - (repoOrder.get(b.repo) ?? 0)
  );

  const sets = { commits, items, ranges };
  const { verdict, violations } = decideVerdict({ ...sets, policy: config.policy });

  return {
    version: 1,
    ...(input.now === undefined ? {} : { generatedAt: input.now }),
    cliVersion: input.cliVersion,
    preset: `${config.presetName}@${config.presetVersion}`,
    history: config.history,
    configFingerprint: input.configFingerprint,
    policy: config.policy,
    changeset: { id: changeset.id, source: changeset.source, items: changeset.items },
    ranges,
    commits,
    items,
    summary: summarise(sets),
    verdict,
    violations
  };
}
