import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheck } from '../src/cli/check.js';
import { runRender } from '../src/cli/render.js';
import { loadConfig } from '../src/config/load.js';
import { validateVerified } from '../src/config/validate.js';
import { assertVerifiedAgainstGit } from '../src/verify-git.js';
import { CLI_VERSION } from '../src/cli/version.js';
import { CliError } from '../src/errors.js';
import { makeRepo, type FixtureRepo } from './helpers/repo.js';
import type { VerifiedChangeset } from '../src/types.js';

let repo: FixtureRepo | undefined;
let work: string | undefined;
let configPath: string;
let outPath: string;

const changeset = {
  version: 1,
  id: 'release 1',
  source: { kind: 'manual', ref: 'r', fetchedAt: '2026-09-01T00:00:00Z' },
  items: [{
    id: 'i1', title: 'Two', type: 'issue', status: 'closed',
    tokens: [{ matcher: 'pr-ref', token: '#2', repo: 'r' }]
  }],
  ranges: [{ repo: 'r', base: 'base', head: 'main' }]
};

function silence(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

/** The artifact runCheck produced, parsed and validated. */
function artifact(): VerifiedChangeset {
  return validateVerified(JSON.parse(readFileSync(outPath, 'utf8')));
}

function verify(mutated: VerifiedChangeset): ReturnType<typeof assertVerifiedAgainstGit> {
  const { config, configFingerprint } = loadConfig(configPath, CLI_VERSION);
  return assertVerifiedAgainstGit(mutated, config, configFingerprint, CLI_VERSION);
}

beforeEach(() => {
  repo = makeRepo();
  repo.commit('feat: one (#1)');
  repo.tag('base');
  repo.commit('feat: two (#2)');
  repo.commit('chore: reformat');

  work = mkdtempSync(join(tmpdir(), 'shipledger-vg-'));
  configPath = join(work, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    version: 1, preset: 'github-oss@1', repos: [{ name: 'r', path: repo.path }]
  }));
  writeFileSync(join(work, 'changeset.json'), JSON.stringify(changeset));
  outPath = join(work, 'verified.json');

  silence();
  const code = runCheck(
    ['--config', configPath, '--changeset', join(work, 'changeset.json'), '--out', outPath],
    work
  );
  if (code !== 0) throw new Error(`fixture check failed with ${code}`);
});

afterEach(() => {
  repo?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
  repo = undefined;
  work = undefined;
  vi.restoreAllMocks();
});

describe('assertVerifiedAgainstGit', () => {
  it('accepts the artifact check just produced', () => {
    expect(() => verify(artifact())).not.toThrow();
  });

  it('reports no moved refs and no fingerprint difference for the original config', () => {
    const result = verify(artifact());
    expect(result.movedRefs).toEqual([]);
    expect(result.fingerprintDiffers).toBe(false);
  });

  // This is the case assertVerifiedSemantics cannot catch: the artifact agrees
  // with itself, so only git can contradict it.
  it('catches every commit being removed and the summary repaired to match', () => {
    const forged = artifact();
    forged.commits = [];
    forged.summary.commits = 0;
    forged.summary.commitsIgnored = 0;
    forged.summary.noReference = 0;
    forged.summary.itemsLinked = 0;
    forged.items[0]!.commits = [];
    forged.items[0]!.findings = ['item-without-commits'];
    forged.summary.itemsWithoutCommits = 1;

    expect(() => verify(forged)).toThrow(/is in the range but missing from the artifact/);
  });

  it('catches a single commit being dropped', () => {
    const forged = artifact();
    const dropped = forged.commits.find((c) => c.subject === 'chore: reformat');
    forged.commits = forged.commits.filter((c) => c.subject !== 'chore: reformat');
    forged.summary.commits -= 1;
    forged.summary.noReference -= 1;

    expect(() => verify(forged)).toThrow(new RegExp(dropped!.sha.slice(0, 8)));
  });

  it('catches a doctored subject and quotes both versions', () => {
    const forged = artifact();
    forged.commits[0]!.subject = 'fix: nothing to see here';
    try {
      verify(forged);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/records subject "fix: nothing to see here"/);
      expect((err as Error).message).toMatch(/but git says/);
    }
  });

  it('catches a doctored author, which ignore rules key on', () => {
    const forged = artifact();
    forged.commits[0]!.author = 'dependabot[bot]';
    expect(() => verify(forged)).toThrow(/records author/);
  });

  // Commit text intact, reference relabelled. Nothing about the commit itself
  // is wrong, so this is caught only by re-deriving the references from git.
  it('catches a reference being relabelled while the commit text is left alone', () => {
    const forged = artifact();
    const withRef = forged.commits.find((c) => c.references.length > 0);
    withRef!.references[0]!.token = '#99';
    expect(() => verify(forged)).toThrow(/"commits" does not match/);
  });

  it('fails with exit 2 when the artifact does not match', () => {
    const forged = artifact();
    forged.commits[0]!.body = 'invented';
    try {
      verify(forged);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('reports a ref that has moved on without failing', () => {
    repo!.commit('feat: four (#4)');
    const result = verify(artifact());
    expect(result.movedRefs).toHaveLength(1);
    expect(result.movedRefs[0]).toMatch(/head "main" now points at/);
  });

  it('still verifies the recorded shas after the ref has moved', () => {
    repo!.commit('feat: four (#4)');
    // The walk uses immutable shas, so the later commit must not appear.
    expect(() => verify(artifact())).not.toThrow();
  });

  it('rejects a checkout that does not contain the recorded commits with exit 3', () => {
    const other = makeRepo();
    try {
      writeFileSync(configPath, JSON.stringify({
        version: 1, preset: 'github-oss@1', repos: [{ name: 'r', path: other.path }]
      }));
      other.commit('unrelated');
      try {
        verify(artifact());
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as CliError).exitCode).toBe(3);
        expect((err as Error).message).toMatch(/is not a commit in repo "r"/);
      }
    } finally {
      other.cleanup();
    }
  });

  it('refuses an artifact from a different CLI version and names it', () => {
    const older = artifact();
    older.cliVersion = '0.0.1-not-this-one';
    try {
      verify(older);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
      expect((err as Error).message).toMatch(/0\.0\.1-not-this-one/);
      expect((err as Error).message).toMatch(new RegExp(CLI_VERSION.replace(/\./g, '\\.')));
    }
  });

  it('refuses when the config does not define a repo the artifact covers', () => {
    writeFileSync(configPath, JSON.stringify({
      version: 1, preset: 'github-oss@1', repos: [{ name: 'other', path: repo!.path }]
    }));
    expect(() => verify(artifact())).toThrow(/which this config does not define/);
  });

  it('tolerates a config that differs only in how the repo path is written', () => {
    writeFileSync(configPath, JSON.stringify({
      version: 1, preset: 'github-oss@1', repos: [{ name: 'r', path: `${repo!.path}/.` }]
    }));
    const result = verify(artifact());
    // Same repo, different spelling: the fingerprint moves, the artifact does not.
    expect(result.fingerprintDiffers).toBe(true);
  });
});

describe('render --verify-against-repos', () => {
  it('exits 0 and still renders when the artifact matches', () => {
    expect(runRender(
      ['report', '--input', outPath, '--config', configPath, '--verify-against-repos'],
      work as string
    )).toBe(0);
  });

  it('exits 2 without rendering when the artifact does not match', () => {
    const forged = artifact();
    forged.commits[0]!.subject = 'invented';
    const forgedPath = join(work as string, 'forged.json');
    writeFileSync(forgedPath, JSON.stringify(forged));
    expect(runRender(
      ['report', '--input', forgedPath, '--config', configPath, '--verify-against-repos'],
      work as string
    )).toBe(2);
  });

  it('does not touch the repositories unless asked', () => {
    // No --config given and none on disk: without the flag that must not matter.
    expect(runRender(['report', '--input', outPath], work as string)).toBe(0);
  });
});
