import { usageError } from './errors.js';
import { canonicalStringify } from './core/canonical.js';
import { compileAll } from './core/compile.js';
import { reconcile } from './core/reconcile.js';
import { assertCommitExists, assertUsableRepo, rangeFactsFor, tryResolveRef } from './git/refs.js';
import { walkRange } from './git/log.js';
import { commitKey } from './notes.js';
import type {
  Changeset, CommitRecord, RangeResult, ResolvedConfig,
  VerifiedChangeset, VerifiedChangesetV1, VerifiedChangesetV2
} from './types.js';

/**
 * `generatedAt` is a timestamp and `configFingerprint` covers the repo paths as
 * written in the config, so both differ legitimately when a second person
 * verifies the same artifact from their own checkout. Everything else must
 * reproduce exactly.
 */
const NOT_COMPARED = new Set(['generatedAt', 'configFingerprint', 'links']);

const comparable = (v: VerifiedChangeset): string =>
  canonicalStringify(Object.fromEntries(Object.entries(v).filter(([k]) => !NOT_COMPARED.has(k))));

export interface GitVerification {
  /** Ref names that no longer resolve to the sha the artifact recorded. */
  movedRefs: string[];
  /** True when this config fingerprints differently, which repo paths alone can cause. */
  fingerprintDiffers: boolean;
}

const show = (c: { repo: string; sha: string }): string => `${c.repo} ${c.sha.slice(0, 8)}`;

/**
 * Projects a version-2 reconciliation down to the version-1 shape so it can be
 * compared against a stored v1 artifact. This is only sound for an all-linear run:
 * on a linear range attribution is uniformly `determinate` and no v2 field carries
 * information a v1 artifact lacks, so dropping the v2-only fields loses nothing.
 * A divergent run is never projected — it is rejected before reaching here.
 */
function projectToV1(v: VerifiedChangesetV2): VerifiedChangesetV1 {
  return {
    version: 1,
    ...(v.generatedAt === undefined ? {} : { generatedAt: v.generatedAt }),
    cliVersion: v.cliVersion,
    preset: v.preset,
    history: v.history,
    configFingerprint: v.configFingerprint,
    policy: v.policy,
    changeset: v.changeset,
    ...(v.links ? { links: v.links } : {}),
    ranges: v.ranges.map(({ effectiveDelta: _effectiveDelta, ...r }) => r),
    commits: v.commits.map(({ attribution: _attribution, ...c }) => c),
    items: v.items.map(({ attribution: _attribution, commits, ...i }) => ({
      ...i,
      commits: commits.map(({ attribution: _linkAttribution, ...l }) => l)
    })),
    summary: (({ indeterminateCommits: _ic, indeterminateItems: _ii, ...s }) => s)(v.summary),
    verdict: v.verdict,
    violations: v.violations
  };
}

function describeDifference(artifact: VerifiedChangeset, recomputed: VerifiedChangeset): string[] {
  const problems: string[] = [];

  const claimed = new Map(artifact.commits.map((c) => [commitKey(c.repo, c.sha), c]));
  const actual = new Map(recomputed.commits.map((c) => [commitKey(c.repo, c.sha), c]));

  for (const [key, commit] of actual) {
    if (!claimed.has(key)) problems.push(`${show(commit)} is in the range but missing from the artifact`);
  }
  for (const [key, commit] of claimed) {
    if (!actual.has(key)) problems.push(`${show(commit)} is in the artifact but not in the range`);
  }

  for (const [key, commit] of claimed) {
    const real = actual.get(key);
    if (!real) continue;
    for (const field of ['subject', 'body', 'author', 'committedAt'] as const) {
      if (commit[field] !== real[field]) {
        problems.push(
          `${show(commit)} records ${field} ${JSON.stringify(commit[field])} but git says ${JSON.stringify(real[field])}`
        );
      }
    }
  }

  // Anything left is a derived field: references, findings, attribution, items,
  // summary, verdict. Naming the key is enough, since the artifact is self-describing.
  if (problems.length === 0) {
    for (const key of Object.keys(recomputed) as Array<keyof VerifiedChangeset>) {
      if (NOT_COMPARED.has(key)) continue;
      if (canonicalStringify(artifact[key]) !== canonicalStringify(recomputed[key])) {
        problems.push(`"${key}" does not match what these repositories produce`);
      }
    }
  }

  return problems;
}

/**
 * Re-derives the artifact from the given repositories and requires the result
 * to match. This is what binds the artifact to git: `assertVerifiedSemantics`
 * only proves an artifact agrees with itself, so an edit that also repairs the
 * summary passes it. Here the commits, their content, the range facts and
 * every derived field have to come back identical.
 *
 * Version routing (ADR 0008): reconciliation now produces version 2. A v2 artifact
 * is re-derived and compared as v2. A linear v1 artifact is re-derived and compared
 * against a v1 projection of the result. A divergent v1 artifact cannot establish a
 * new or current trusted reconciliation — it is rejected and must be regenerated as
 * v2, because v1 cannot express the indeterminacy the divergence requires.
 *
 * The tracker's claim is still taken on trust — it is embedded in the artifact
 * and nothing local can confirm it.
 */
export function assertVerifiedAgainstGit(
  verified: VerifiedChangeset,
  config: ResolvedConfig,
  configFingerprint: string,
  cliVersion: string
): GitVerification {
  if (verified.cliVersion !== cliVersion) {
    throw usageError(
      `This artifact was produced by shipledger ${verified.cliVersion} and cannot be verified by ${cliVersion}. ` +
      `Reconciliation is only reproducible within one version — install ${verified.cliVersion} to verify it.`
    );
  }

  if (verified.version === 1 && verified.ranges.some((r) => !r.baseIsAncestorOfHead)) {
    throw usageError(
      'This is a version-1 artifact describing a divergent range. It remains viewable as ' +
      'historical evidence, but a version-1 artifact cannot express indeterminate attribution, ' +
      'so it cannot establish a new or current trusted reconciliation. Regenerate it as ' +
      'version 2 (re-run `shipledger check`) to verify it against the repositories.'
    );
  }

  const configured = new Map(config.repos.map((r) => [r.name, r.path]));
  const missing = verified.ranges.map((r) => r.repo).filter((name) => !configured.has(name));
  if (missing.length > 0) {
    throw usageError(
      `The artifact covers repo(s) ${missing.join(', ')}, which this config does not define. ` +
      `Verification needs a config naming every repo in the artifact so it knows where each one is.`
    );
  }

  const movedRefs: string[] = [];
  const ranges: RangeResult[] = [];
  const commits: CommitRecord[] = [];

  for (const recorded of verified.ranges) {
    const repoPath = configured.get(recorded.repo) as string;
    assertUsableRepo(repoPath, recorded.repo);
    assertCommitExists(recorded.baseSha, repoPath, recorded.repo, 'base');
    assertCommitExists(recorded.headSha, repoPath, recorded.repo, 'head');

    for (const [label, name, sha] of [
      ['base', recorded.base, recorded.baseSha],
      ['head', recorded.head, recorded.headSha]
    ] as const) {
      const now = tryResolveRef(name, repoPath);
      if (now !== null && now !== sha) {
        movedRefs.push(
          `${recorded.repo} ${label} "${name}" now points at ${now.slice(0, 8)}, not the ${sha.slice(0, 8)} recorded here`
        );
      }
    }

    const range = rangeFactsFor(recorded, recorded.baseSha, recorded.headSha, repoPath);
    ranges.push(range);
    commits.push(...walkRange(range, repoPath, verified.history));
  }

  const changeset: Changeset = {
    version: 1,
    id: verified.changeset.id,
    source: verified.changeset.source,
    items: verified.changeset.items,
    ranges: verified.ranges.map((r) => ({
      repo: r.repo, base: r.base, head: r.head, include: r.include
    }))
  };

  const recomputedV2 = reconcile({
    config, compiled: compileAll(config), changeset, commits, ranges,
    cliVersion, configFingerprint
  });

  if (verified.version === 1) {
    // The stored artifact claims linearity; if the repositories now diverge, a v1
    // reconciliation can no longer be re-derived honestly and must be regenerated.
    if (recomputedV2.ranges.some((r) => !r.baseIsAncestorOfHead)) {
      throw usageError(
        'The repositories now show a divergent range for this version-1 artifact. A version-1 ' +
        'reconciliation cannot express the indeterminate attribution divergence requires — ' +
        'regenerate the artifact as version 2 (re-run `shipledger check`).'
      );
    }
    const recomputed = projectToV1(recomputedV2);
    if (comparable(verified) !== comparable(recomputed)) {
      const problems = describeDifference(verified, recomputed);
      throw usageError(
        `Artifact does not match the repositories:\n${problems.map((p) => `  ${p}`).join('\n')}`
      );
    }
  } else if (comparable(verified) !== comparable(recomputedV2)) {
    const problems = describeDifference(verified, recomputedV2);
    throw usageError(
      `Artifact does not match the repositories:\n${problems.map((p) => `  ${p}`).join('\n')}`
    );
  }

  if (canonicalStringify(verified.links) !== canonicalStringify(config.links)) {
    throw usageError(
      'Artifact link metadata does not match the config. ' +
      'A changed link destination or strip rule cannot pass verification.'
    );
  }

  return { movedRefs, fingerprintDiffers: verified.configFingerprint !== configFingerprint };
}
