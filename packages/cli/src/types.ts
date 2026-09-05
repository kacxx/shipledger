export type Namespace = 'global' | 'repo';
export type Normalize = 'upper' | 'lower' | 'none';
export type HistoryMode = 'first-parent' | 'all';
export type CommitSource = 'subject' | 'body';

export type FindingName =
  | 'no-reference'
  | 'unknown-reference'
  | 'item-without-commits'
  | 'range-divergence';

export interface MatcherConfig {
  id: string;
  sources: CommitSource[];
  pattern: string;
  namespace: Namespace;
  normalize: Normalize;
}

export interface RepoConfig { name: string; path: string }

/** `authors` are exact `%an` values. `subjects` are regular expressions. */
export interface IgnoreConfig { authors: string[]; subjects: string[] }

export interface PolicyConfig { failOn: FindingName[] }

export interface RawConfig {
  version: 1;
  /** Required. Must be pinned (`name@version`) for check and doctor. */
  preset: string;
  repos: RepoConfig[];
  matchers?: MatcherConfig[];
  history?: HistoryMode;
  ignore?: IgnoreConfig;
  policy?: PolicyConfig;
  links?: RawLinks;
}

export interface ResolvedConfig {
  version: 1;
  presetName: string;
  presetVersion: number;
  /** `path` is absolute; `sourcePath` is the original config string. */
  repos: Array<{ name: string; path: string; sourcePath: string }>;
  matchers: MatcherConfig[];
  history: HistoryMode;
  ignore: IgnoreConfig;
  policy: PolicyConfig;
  links?: ResolvedLinks;
}

export interface ItemToken { matcher: string; token: string; repo?: string }

export interface ChangesetItem {
  id: string;
  title: string;
  type: string;
  status: string;
  url?: string;
  /** At least one. The `id` is never implicitly matchable. */
  tokens: ItemToken[];
}

export interface RangeSpec { repo: string; base: string; head: string; include?: string[] }
export interface ChangesetSource { kind: string; ref: string; fetchedAt: string }

export interface Changeset {
  version: 1;
  id: string;
  source: ChangesetSource;
  items: ChangesetItem[];
  ranges: RangeSpec[];
}

export type RawReferenceTemplate = string | { url: string; tokenReplace?: [string, string] };

export interface RawRepoLinks {
  commit?: string;
  references?: Record<string, RawReferenceTemplate>;
}

export interface RawLinks {
  references?: Record<string, RawReferenceTemplate>;
  repos?: Record<string, RawRepoLinks>;
}

export interface ResolvedReferenceLink {
  url: string;
  tokenReplace?: [string, string];
}

export interface ResolvedRepoLinks {
  commit?: string;
  references?: Record<string, ResolvedReferenceLink>;
}

export interface ResolvedLinks {
  references?: Record<string, ResolvedReferenceLink>;
  repos?: Record<string, ResolvedRepoLinks>;
}

export interface CommitRecord {
  repo: string;
  sha: string;
  subject: string;
  body: string;
  /** Exact `%an`. */
  author: string;
  committedAt: string;
}

export interface Reference {
  matcher: string;
  token: string;
  namespace: Namespace;
  /** Every field this tuple appeared in, in `subject`, `body` order. */
  sources: CommitSource[];
  /** Matching item ids in changeset order. Empty means unresolved. */
  resolvesTo: string[];
}

export interface CommitResult {
  repo: string;
  sha: string;
  subject: string;
  body: string;
  author: string;
  committedAt: string;
  ignored: { rule: string } | null;
  references: Reference[];
  findings: FindingName[];
}

export interface RangeResult {
  repo: string;
  base: string;
  baseSha: string;
  head: string;
  headSha: string;
  include: string[];
  mergeBase: string | null;
  baseIsAncestorOfHead: boolean;
  commitsOnlyInBase: number;
  findings: FindingName[];
}

export interface ItemResult {
  id: string;
  title: string;
  type: string;
  status: string;
  commits: Array<{ repo: string; sha: string }>;
  findings: FindingName[];
}

export interface Summary {
  items: number;
  itemsLinked: number;
  commits: number;
  commitsIgnored: number;
  noReference: number;
  unknownReference: number;
  itemsWithoutCommits: number;
  rangeDivergence: number;
}

export interface Violation { finding: FindingName; count: number }

export interface VerifiedChangeset {
  version: 1;
  generatedAt?: string;
  cliVersion: string;
  preset: string;
  history: HistoryMode;
  configFingerprint: string;
  policy: PolicyConfig;
  changeset: { id: string; source: ChangesetSource; items: ChangesetItem[] };
  links?: ResolvedLinks;
  ranges: RangeResult[];
  commits: CommitResult[];
  items: ItemResult[];
  summary: Summary;
  verdict: 'pass' | 'fail';
  violations: Violation[];
}

export const NO_REFERENCE_CLASSIFICATIONS = [
  'revert', 'dependency-bump', 'hotfix-already-released', 'tooling-or-ci', 'process-miss'
] as const;
export const UNKNOWN_REFERENCE_CLASSIFICATIONS = [
  'other-release', 'typo', 'wrongly-omitted'
] as const;
export const ITEM_CLASSIFICATIONS = [
  'configuration-only', 'documentation-only', 'landed-earlier', 'wrongly-tagged', 'not-done'
] as const;
export const RANGE_CLASSIFICATIONS = ['expected-divergence', 'wrong-base'] as const;

export type NoReferenceClassification = (typeof NO_REFERENCE_CLASSIFICATIONS)[number];
export type UnknownReferenceClassification = (typeof UNKNOWN_REFERENCE_CLASSIFICATIONS)[number];
export type ItemClassification = (typeof ITEM_CLASSIFICATIONS)[number];
export type RangeClassification = (typeof RANGE_CLASSIFICATIONS)[number];

export interface NoReferenceNote {
  repo: string;
  sha: string;
  classification: NoReferenceClassification;
  note: string;
}

export interface UnknownReferenceNote {
  repo: string;
  sha: string;
  matcher: string;
  token: string;
  classification: UnknownReferenceClassification;
  note: string;
}

export interface ItemNote {
  item: string;
  classification: ItemClassification;
  note: string;
}

export interface RangeNote {
  repo: string;
  classification: RangeClassification;
  note: string;
}

export interface NotesFile {
  version: 1;
  noReference?: NoReferenceNote[];
  unknownReference?: UnknownReferenceNote[];
  items?: ItemNote[];
  ranges?: RangeNote[];
}
