import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheck } from '../src/cli/check.js';
import { loadConfig, mergeConfig } from '../src/config/load.js';
import { validateConfig, validateVerified } from '../src/config/validate.js';
import { assertVerifiedSemantics } from '../src/verify.js';
import { assertVerifiedAgainstGit } from '../src/verify-git.js';
import { renderReport } from '../src/render/report.js';
import { CLI_VERSION } from '../src/cli/version.js';
import { CliError } from '../src/errors.js';
import { makeRepo, type FixtureRepo } from './helpers/repo.js';
import type {
  VerifiedChangesetV1, VerifiedChangesetV2
} from '../src/types.js';

/*
 * A synthetic squash/merge-back fixture with no adopter identifiers (ADR 0008 /
 * WP-012). One repo diverges (previous release and candidate reconciled off a
 * common base, the release change re-applied as a distinct commit); a second repo
 * has an ordinary linear range in the same run.
 */

const APP_CONTENT = 'package main\n\nfunc main() {}\n';

let app: FixtureRepo;
let lib: FixtureRepo;
let work: string;
let configPath: string;
let changesetPath: string;
let outPath: string;

let d1Sha: string; // divergent commit that re-applies app.go and carries item refs
let d2Sha: string; // divergent commit that adds go.mod

function silence(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function readV2(): VerifiedChangesetV2 {
  const v = validateVerified(JSON.parse(readFileSync(outPath, 'utf8')));
  if (v.version !== 2) throw new Error(`expected version 2, got ${v.version}`);
  return v;
}

beforeAll(() => {
  // ---- app: the divergent repo ----
  app = makeRepo();
  const c0 = app.commit('SYN-0: seed', { file: 'README.md' });

  // previous release branch: adds app.go
  app.run(['checkout', '-q', '-b', 'previous']);
  app.commit('SYN-9: previous release only', { file: 'app.go', content: APP_CONTENT });

  // candidate branch off the common base: re-applies the SAME app.go content as a
  // distinct commit, then adds go.mod. base is NOT an ancestor of head → divergent.
  app.run(['checkout', '-q', '-b', 'candidate', c0]);
  d1Sha = app.commit('SYN-1: add app', { file: 'app.go', content: APP_CONTENT, body: 'relates SYN-5' });
  d2Sha = app.commit('bump go.mod deps', { file: 'go.mod', content: 'module app\n\ngo 1.22\n' });

  // ---- lib: an ordinary linear repo ----
  lib = makeRepo();
  lib.commit('SYN-8: lib seed', { file: 'README.md' });
  lib.tag('libbase');
  lib.commit('SYN-4: lib feature', { file: 'feat.go' });
  lib.commit('cleanup formatting', { file: 'cleanup.go' });
  lib.commit('SYN-5: shared work', { file: 'shared.go' });
  lib.commit('OTHER-99: from another release', { file: 'other.go' });

  work = mkdtempSync(join(tmpdir(), 'shipledger-wp012-'));
  configPath = join(work, 'config.json');
  changesetPath = join(work, 'changeset.json');
  outPath = join(work, 'verified.json');

  writeFileSync(configPath, JSON.stringify({
    version: 1, preset: 'tracker-keys@1',
    repos: [{ name: 'app', path: app.path }, { name: 'lib', path: lib.path }]
  }));
  writeFileSync(changesetPath, JSON.stringify({
    version: 1, id: 'release syn-1.0',
    source: { kind: 'manual', ref: 'r', fetchedAt: '2026-09-01T00:00:00Z' },
    items: [
      { id: 'SYN-1', title: 'App', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'SYN-1' }] },
      { id: 'SYN-3', title: 'Unlinked but in a divergent run', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'SYN-3' }] },
      { id: 'SYN-4', title: 'Lib feature', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'SYN-4' }] },
      { id: 'SYN-5', title: 'Shared', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'SYN-5' }] }
    ],
    ranges: [
      { repo: 'app', base: 'previous', head: 'candidate' },
      { repo: 'lib', base: 'libbase', head: 'main' }
    ]
  }));

  silence();
  runCheck(['--config', configPath, '--changeset', changesetPath, '--out', outPath], work);
  vi.restoreAllMocks();
});

afterAll(() => {
  app?.cleanup();
  lib?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('divergent range facts', () => {
  it('records the app range as divergent and the lib range as linear', () => {
    const v = readV2();
    const appRange = v.ranges.find((r) => r.repo === 'app')!;
    const libRange = v.ranges.find((r) => r.repo === 'lib')!;
    expect(appRange.baseIsAncestorOfHead).toBe(false);
    expect(appRange.findings).toEqual(['range-divergence']);
    expect(libRange.baseIsAncestorOfHead).toBe(true);
    expect(libRange.findings).toEqual([]);
  });

  it('emits version 2 that validates against the v2 schema', () => {
    const v = readV2();
    expect(v.version).toBe(2);
    expect(() => validateVerified(JSON.parse(readFileSync(outPath, 'utf8')))).not.toThrow();
  });

  it('effectiveDelta of the divergent range contains only go.mod', () => {
    const appRange = readV2().ranges.find((r) => r.repo === 'app')!;
    expect(appRange.effectiveDelta).toEqual([{ status: 'A', path: 'go.mod' }]);
  });
});

describe('divergent commit attribution', () => {
  it('the re-applied commit is reachable through base..head', () => {
    const shas = readV2().commits.filter((c) => c.repo === 'app').map((c) => c.sha);
    expect(shas).toContain(d1Sha);
    expect(shas).toContain(d2Sha);
  });

  it('marks every divergent commit indeterminate with no no-reference / unknown-reference', () => {
    const appCommits = readV2().commits.filter((c) => c.repo === 'app');
    for (const c of appCommits) {
      expect(c.attribution).toBe('indeterminate');
      expect(c.findings).toEqual([]);
    }
    // d2 has no reference at all: under linear rules that is no-reference; here it is
    // suppressed because reachability does not prove shipment across divergence.
    const d2 = appCommits.find((c) => c.sha === d2Sha)!;
    expect(d2.references).toEqual([]);
    expect(d2.findings).toEqual([]);
  });

  it('retains the divergent commit references for display', () => {
    const d1 = readV2().commits.find((c) => c.sha === d1Sha)!;
    expect(d1.references.map((r) => r.token).sort()).toEqual(['SYN-1', 'SYN-5']);
  });

  it('keeps linear commit attribution determinate and finding behaviour unchanged', () => {
    const libCommits = readV2().commits.filter((c) => c.repo === 'lib');
    for (const c of libCommits) expect(c.attribution).toBe('determinate');
    const noRef = libCommits.find((c) => c.subject === 'cleanup formatting')!;
    expect(noRef.findings).toEqual(['no-reference']);
    const unknownRef = libCommits.find((c) => c.subject.startsWith('OTHER-99'))!;
    expect(unknownRef.findings).toEqual(['unknown-reference']);
  });
});

describe('item links and attribution', () => {
  it('retains the divergent link and annotates it indeterminate', () => {
    const syn1 = readV2().items.find((i) => i.id === 'SYN-1')!;
    expect(syn1.commits).toEqual([{ repo: 'app', sha: d1Sha, attribution: 'indeterminate' }]);
  });

  it('an item linked only through a divergent commit is indeterminate, not satisfied, not item-without-commits', () => {
    const syn1 = readV2().items.find((i) => i.id === 'SYN-1')!;
    expect(syn1.attribution).toBe('indeterminate');
    expect(syn1.findings).toEqual([]);
  });

  it('a no-link item is indeterminate because the run contains a divergent range', () => {
    const syn3 = readV2().items.find((i) => i.id === 'SYN-3')!;
    expect(syn3.commits).toEqual([]);
    expect(syn3.attribution).toBe('indeterminate');
    expect(syn3.findings).toEqual([]);
  });

  it('a determinately-linked item stays satisfied and determinate', () => {
    const syn4 = readV2().items.find((i) => i.id === 'SYN-4')!;
    expect(syn4.attribution).toBe('determinate');
    expect(syn4.findings).toEqual([]);
    expect(syn4.commits.every((l) => l.attribution === 'determinate')).toBe(true);
  });

  it('a mixed item is satisfied only through its determinate link', () => {
    const syn5 = readV2().items.find((i) => i.id === 'SYN-5')!;
    const attributions = syn5.commits.map((l) => l.attribution).sort();
    expect(attributions).toEqual(['determinate', 'indeterminate']);
    expect(syn5.attribution).toBe('determinate');
    expect(syn5.findings).toEqual([]);
  });
});

describe('summary and verdict', () => {
  it('counts indeterminate commits and items', () => {
    const s = readV2().summary;
    expect(s.indeterminateCommits).toBe(2);
    expect(s.indeterminateItems).toBe(2);
    expect(s.itemsWithoutCommits).toBe(0);
    expect(s.noReference).toBe(1);
    expect(s.unknownReference).toBe(1);
    expect(s.rangeDivergence).toBe(1);
  });

  it('suppressed secondary findings never appear in violations', () => {
    const v = readV2();
    // The divergent range fails the standard preset; suppressed no-reference on the
    // divergent commit is absent, but the linear repo's own no-reference remains.
    expect(v.violations).toContainEqual({ finding: 'range-divergence', count: 1 });
    expect(v.verdict).toBe('fail');
    const divergentCommitFindings = v.commits.filter((c) => c.repo === 'app').flatMap((c) => c.findings);
    expect(divergentCommitFindings).toEqual([]);
  });
});

describe('repository-backed verification', () => {
  const cfg = (): ReturnType<typeof loadConfig> => loadConfig(configPath, CLI_VERSION);

  it('re-derives every v2 fact and accepts a faithful artifact', () => {
    const { config, configFingerprint } = cfg();
    expect(() => assertVerifiedAgainstGit(readV2(), config, configFingerprint, CLI_VERSION)).not.toThrow();
  });

  it('rejects a divergent commit relabelled determinate', () => {
    const { config, configFingerprint } = cfg();
    const forged = readV2();
    forged.commits.find((c) => c.sha === d1Sha)!.attribution = 'determinate';
    expect(() => assertVerifiedAgainstGit(forged, config, configFingerprint, CLI_VERSION)).toThrow(CliError);
  });

  it('rejects a tampered effectiveDelta', () => {
    const { config, configFingerprint } = cfg();
    const forged = readV2();
    forged.ranges.find((r) => r.repo === 'app')!.effectiveDelta = [];
    expect(() => assertVerifiedAgainstGit(forged, config, configFingerprint, CLI_VERSION)).toThrow(/does not match the repositories/);
  });

  it('the internal-consistency check also rejects a relabelled commit', () => {
    const forged = readV2();
    forged.commits.find((c) => c.sha === d1Sha)!.attribution = 'determinate';
    expect(() => assertVerifiedSemantics(forged)).toThrow(/attribution/);
  });
});

describe('report rendering', () => {
  const report = (): string => renderReport(readV2());

  it('shows the effective file-list delta for the divergent range', () => {
    expect(report()).toMatch(/Effective file\\?-list delta \| A `go\.mod`/);
  });

  it('labels the divergent commits as attribution-indeterminate, never shipped work', () => {
    const text = report();
    expect(text).toMatch(/indeterminate — divergent range, not attributable/);
    expect(text).not.toMatch(/shipped/i);
  });

  it('does not list indeterminate commits in the unresolved shipped-work section', () => {
    const text = report();
    const unresolved = text.slice(text.indexOf('## Unresolved'));
    expect(unresolved).not.toContain(d1Sha.slice(0, 8));
    expect(unresolved).not.toContain(d2Sha.slice(0, 8));
    // the genuine linear no-reference commit is still listed
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('shows an item whose shipment attribution is indeterminate', () => {
    expect(report()).toMatch(/SYN-1.*attribution\\?-indeterminate/);
  });
});

describe('all-linear run keeps item-without-commits and reads back as v1', () => {
  let linearOut: string;
  let linearWork: string;

  beforeAll(() => {
    linearWork = mkdtempSync(join(tmpdir(), 'shipledger-wp012-lin-'));
    const cfgPath = join(linearWork, 'config.json');
    const csPath = join(linearWork, 'changeset.json');
    linearOut = join(linearWork, 'verified.json');
    writeFileSync(cfgPath, JSON.stringify({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'lib', path: lib.path }]
    }));
    writeFileSync(csPath, JSON.stringify({
      version: 1, id: 'lib linear',
      source: { kind: 'manual', ref: 'r', fetchedAt: '2026-09-01T00:00:00Z' },
      items: [
        { id: 'SYN-4', title: 'Lib feature', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'SYN-4' }] },
        { id: 'SYN-404', title: 'Claimed, no code', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'SYN-404' }] }
      ],
      ranges: [{ repo: 'lib', base: 'libbase', head: 'main' }]
    }));
    silence();
    runCheck(['--config', cfgPath, '--changeset', csPath, '--out', linearOut], linearWork);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (linearWork) rmSync(linearWork, { recursive: true, force: true });
  });

  const readLinear = (): VerifiedChangesetV2 => {
    const v = validateVerified(JSON.parse(readFileSync(linearOut, 'utf8')));
    if (v.version !== 2) throw new Error('expected v2');
    return v;
  };

  it('a no-link item in an all-linear run still produces item-without-commits', () => {
    const v = readLinear();
    const syn404 = v.items.find((i) => i.id === 'SYN-404')!;
    expect(syn404.attribution).toBe('determinate');
    expect(syn404.findings).toEqual(['item-without-commits']);
    expect(v.summary.indeterminateItems).toBe(0);
    expect(v.summary.indeterminateCommits).toBe(0);
  });

  it('a linear v2 artifact projected to v1 stays readable and internally consistent', () => {
    const v1 = stripToV1(readLinear());
    const parsed = validateVerified(v1);
    expect(parsed.version).toBe(1);
    expect(() => assertVerifiedSemantics(parsed)).not.toThrow();
    expect(() => renderReport(parsed)).not.toThrow();
  });
});

describe('divergent v1 compatibility', () => {
  // A version-1 artifact as older Shipledger would have produced it: a divergent
  // range whose commit was tagged no-reference under the old reachability semantics.
  const divergentV1: VerifiedChangesetV1 = {
    version: 1,
    cliVersion: CLI_VERSION,
    preset: 'tracker-keys@1',
    history: 'first-parent',
    configFingerprint: `sha256:${'0'.repeat(64)}`,
    policy: { failOn: ['no-reference', 'range-divergence'] },
    changeset: {
      id: 'legacy divergent',
      source: { kind: 'manual', ref: 'r', fetchedAt: '2026-09-01T00:00:00Z' },
      items: []
    },
    ranges: [{
      repo: 'app', base: 'previous', baseSha: 'a'.repeat(40), head: 'candidate', headSha: 'b'.repeat(40),
      include: [], mergeBase: 'c'.repeat(40), baseIsAncestorOfHead: false, commitsOnlyInBase: 1,
      findings: ['range-divergence']
    }],
    commits: [{
      repo: 'app', sha: 'd'.repeat(40), subject: 'reapplied', body: '', author: 'Dev',
      committedAt: '2026-01-01T00:00:00Z', ignored: null, references: [], findings: ['no-reference']
    }],
    items: [],
    summary: {
      items: 0, itemsLinked: 0, commits: 1, commitsIgnored: 0,
      noReference: 1, unknownReference: 0, itemsWithoutCommits: 0, rangeDivergence: 1
    },
    verdict: 'fail',
    violations: [{ finding: 'no-reference', count: 1 }, { finding: 'range-divergence', count: 1 }]
  };

  it('remains historically viewable — validates, is internally consistent, renders', () => {
    const parsed = validateVerified(JSON.parse(JSON.stringify(divergentV1)));
    expect(parsed.version).toBe(1);
    expect(() => assertVerifiedSemantics(parsed)).not.toThrow();
    expect(() => renderReport(parsed)).not.toThrow();
  });

  it('cannot establish a trusted reconciliation — requires v2 regeneration', () => {
    const config = mergeConfig(validateConfig({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'app', path: '../app' }]
    }), '/tmp');
    try {
      assertVerifiedAgainstGit(divergentV1, config, `sha256:${'0'.repeat(64)}`, CLI_VERSION);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).toMatch(/regenerate/i);
      expect((err as Error).message).toMatch(/version 2/i);
    }
  });
});

describe('unsupported versions', () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;

  it('rejects an unknown numeric version', () => {
    const bad = { ...base(), version: 3 };
    expect(() => validateVerified(bad)).toThrow(/unsupported version/i);
  });

  it('rejects a non-object', () => {
    expect(() => validateVerified('not an artifact')).toThrow(CliError);
  });
});

function stripToV1(v: VerifiedChangesetV2): VerifiedChangesetV1 {
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
    ranges: v.ranges.map(({ effectiveDelta: _d, ...r }) => r),
    commits: v.commits.map(({ attribution: _a, ...c }) => c),
    items: v.items.map(({ attribution: _a, commits, ...i }) => ({
      ...i, commits: commits.map(({ attribution: _la, ...l }) => l)
    })),
    summary: (({ indeterminateCommits: _ic, indeterminateItems: _ii, ...s }) => s)(v.summary),
    verdict: v.verdict,
    violations: v.violations
  };
}
