export type Namespace = 'global' | 'repo';
export type Normalize = 'upper' | 'lower' | 'none';
export type HistoryMode = 'first-parent' | 'all';
export type CommitSource = 'subject' | 'body';

export type FindingName =
  | 'no-reference'
  | 'unknown-reference'
  | 'item-without-commits'
  | 'range-divergence';

/**
 * Whether a commit's or item's shipment provenance can be established from the
 * range. Linear ranges are `determinate`; a range whose base is not an ancestor
 * of head cannot prove what shipped, so its commits — and items resting on them
 * — are `indeterminate`. See ADR 0008.
 */
export type Attribution = 'determinate' | 'indeterminate';

/** The tree-to-tree statuses Shipledger represents. Rename detection is disabled. */
export type DeltaStatus = 'A' | 'M' | 'D' | 'T';

/** One constrained status per path — a file-list fact only, not commit ownership. */
export interface DeltaEntry { status: DeltaStatus; path: string }

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

export type RawReferenceTemplate = string | { url: string; stripPrefix?: string; stripSuffix?: string };

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
  stripPrefix?: string;
  stripSuffix?: string;
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

export interface Violation { finding: FindingName; count: number }

/*
 * Two serialized shapes, kept as distinct types rather than one interface with
 * optional additions: version 1 (pre-WP-012) and version 2 (divergent-range
 * attribution, ADR 0008). Reconciliation always produces version 2; version 1
 * is retained only for reading historical artifacts. The `*V1` sub-types are the
 * legacy read shape; the unsuffixed types are the version-2 working shape used
 * throughout the engine.
 */

// ---- version 1 (legacy read shape) ----

export interface CommitResultV1 {
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

export interface RangeResultV1 {
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

export interface ItemLinkV1 { repo: string; sha: string }

export interface ItemResultV1 {
  id: string;
  title: string;
  type: string;
  status: string;
  commits: ItemLinkV1[];
  findings: FindingName[];
}

export interface SummaryV1 {
  items: number;
  itemsLinked: number;
  commits: number;
  commitsIgnored: number;
  noReference: number;
  unknownReference: number;
  itemsWithoutCommits: number;
  rangeDivergence: number;
}

// ---- version 2 (working shape, ADR 0008) ----

export interface CommitResult extends CommitResultV1 { attribution: Attribution }

export interface RangeResult extends RangeResultV1 { effectiveDelta: DeltaEntry[] }

export interface ItemLink extends ItemLinkV1 { attribution: Attribution }

export interface ItemResult {
  id: string;
  title: string;
  type: string;
  status: string;
  commits: ItemLink[];
  attribution: Attribution;
  findings: FindingName[];
}

export interface Summary extends SummaryV1 {
  indeterminateCommits: number;
  indeterminateItems: number;
}

// ---- top level ----

export interface VerifiedChangesetBase {
  generatedAt?: string;
  cliVersion: string;
  preset: string;
  history: HistoryMode;
  configFingerprint: string;
  policy: PolicyConfig;
  changeset: { id: string; source: ChangesetSource; items: ChangesetItem[] };
  links?: ResolvedLinks;
  verdict: 'pass' | 'fail';
  violations: Violation[];
}

export interface VerifiedChangesetV1 extends VerifiedChangesetBase {
  version: 1;
  ranges: RangeResultV1[];
  commits: CommitResultV1[];
  items: ItemResultV1[];
  summary: SummaryV1;
}

export interface VerifiedChangesetV2 extends VerifiedChangesetBase {
  version: 2;
  ranges: RangeResult[];
  commits: CommitResult[];
  items: ItemResult[];
  summary: Summary;
}

export type VerifiedChangeset = VerifiedChangesetV1 | VerifiedChangesetV2;

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

export const IMPACT_VALUES = ['test-only', 'no-runtime-impact'] as const;

export type NoReferenceClassification = (typeof NO_REFERENCE_CLASSIFICATIONS)[number];
export type UnknownReferenceClassification = (typeof UNKNOWN_REFERENCE_CLASSIFICATIONS)[number];
export type ItemClassification = (typeof ITEM_CLASSIFICATIONS)[number];
export type RangeClassification = (typeof RANGE_CLASSIFICATIONS)[number];
export type Impact = (typeof IMPACT_VALUES)[number];

export interface NoReferenceNote {
  repo: string;
  sha: string;
  classification: NoReferenceClassification;
  impact?: Impact;
  note: string;
}

export interface UnknownReferenceNote {
  repo: string;
  sha: string;
  matcher: string;
  token: string;
  classification: UnknownReferenceClassification;
  impact?: Impact;
  note: string;
}

export interface ItemNote {
  item: string;
  classification: ItemClassification;
  impact?: Impact;
  note: string;
}

export interface RangeNote {
  repo: string;
  classification: RangeClassification;
  impact?: Impact;
  note: string;
}

export interface NotesFile {
  version: 1 | 2;
  noReference?: NoReferenceNote[];
  unknownReference?: UnknownReferenceNote[];
  items?: ItemNote[];
  ranges?: RangeNote[];
}
