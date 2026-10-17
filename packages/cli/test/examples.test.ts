import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateConfig, validateChangeset } from '../src/config/validate.js';
import { mergeConfig, assertConfigIdentities } from '../src/config/load.js';
import { assertChangesetAgainstConfig } from '../src/config/changeset.js';
import { compileAll } from '../src/core/compile.js';
import { runCheck } from '../src/cli/check.js';
import { makeRepo, type FixtureRepo } from './helpers/repo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe.each(['tracker-keys', 'github-oss', 'release-please', 'self-check'])('examples/%s', (name) => {
  const dir = join(root, 'examples', name);
  const rawConfig = JSON.parse(readFileSync(join(dir, 'shipledger.config.json'), 'utf8'));
  const rawChangeset = JSON.parse(readFileSync(join(dir, 'changeset.json'), 'utf8'));

  it('has a schema-valid config with a pinned preset', () => {
    const parsed = validateConfig(rawConfig);
    expect(parsed.preset).toMatch(/@\d+$/);
  });

  it('has a policy that is either absent or complete, never partial', () => {
    const parsed = validateConfig(rawConfig);
    if (parsed.policy !== undefined) expect(Array.isArray(parsed.policy.failOn)).toBe(true);
  });

  it('has a schema-valid changeset', () => {
    expect(() => validateChangeset(rawChangeset)).not.toThrow();
  });

  it('resolves, compiles, and cross-checks cleanly', () => {
    const config = mergeConfig(validateConfig(rawConfig), dir);
    assertConfigIdentities(config);
    compileAll(config);
    expect(() => assertChangesetAgainstConfig(validateChangeset(rawChangeset), config)).not.toThrow();
  });
});

describe('examples/release-please against a matching history', () => {
  const dir = join(root, 'examples', 'release-please');
  let repo: FixtureRepo | undefined;
  let work: string | undefined;

  afterEach(() => {
    repo?.cleanup();
    if (work) rmSync(work, { recursive: true, force: true });
    repo = undefined; work = undefined;
    vi.restoreAllMocks();
  });

  function check(changeset: string): { code: number; out: { verdict: string; violations: { finding: string }[] } } {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    repo = makeRepo();
    repo.commit('chore: initial commit'); repo.tag('v1.3.0');
    repo.commit('feat: add a summary line to check (#12)');
    repo.commit('docs: explain the summary line (#13)');
    repo.commit('fix: handle an empty range (#14)');
    repo.commit('chore(main): release 1.4.0 (#15)'); repo.tag('v1.4.0');

    work = mkdtempSync(join(tmpdir(), 'shipledger-example-'));
    const config = JSON.parse(readFileSync(join(dir, 'shipledger.config.json'), 'utf8'));
    config.repos[0].path = repo.path;
    writeFileSync(join(work, 'config.json'), JSON.stringify(config));
    const out = join(work, 'out.json');
    const code = runCheck(['--config', join(work, 'config.json'), '--changeset', join(dir, changeset), '--out', out], process.cwd());
    return { code, out: JSON.parse(readFileSync(out, 'utf8')) };
  }

  it('fails a claim built from the notes alone on the hidden docs PR', () => {
    const { code, out } = check('changeset.notes-only.json');
    expect(code).toBe(1);
    expect(out.verdict).toBe('fail');
    expect(out.violations).toEqual([{ finding: 'unknown-reference', count: 1 }]);
  });

  it('passes once the hidden PR is claimed', () => {
    const { code, out } = check('changeset.json');
    expect(code).toBe(0);
    expect(out.verdict).toBe('pass');
  });

  it('has a schema-valid notes-only changeset', () => {
    expect(() => validateChangeset(JSON.parse(readFileSync(join(dir, 'changeset.notes-only.json'), 'utf8')))).not.toThrow();
  });
});

// The self-check example walks this repository's own v0.3.5..v0.4.0. CI's
// checkout is shallow and has no tags, so the walk runs only in a full clone.
function hasFullHistory(): boolean {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') return false;
    git(['rev-parse', '--verify', '--quiet', 'v0.3.5^{commit}']);
    git(['rev-parse', '--verify', '--quiet', 'v0.4.0^{commit}']);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFullHistory())('examples/self-check against this repository', () => {
  const dir = join(root, 'examples', 'self-check');
  let work: string | undefined;

  afterEach(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    work = undefined;
    vi.restoreAllMocks();
  });

  function check(changeset: string): { code: number; summary: string; out: { verdict: string; violations: { finding: string }[]; commits: { sha: string; findings: string[] }[] } } {
    let summary = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { summary += String(chunk); return true; });
    work = mkdtempSync(join(tmpdir(), 'shipledger-self-check-'));
    const out = join(work, 'verified-changeset.json');
    const code = runCheck(['--config', join(dir, 'shipledger.config.json'), '--changeset', join(dir, changeset), '--out', out], process.cwd());
    return { code, summary, out: JSON.parse(readFileSync(out, 'utf8')) };
  }

  it('fails the v0.4.0 notes alone on the three hidden pull requests', () => {
    const { code, summary, out } = check('changeset.notes-only.json');
    expect(code).toBe(1);
    expect(out.verdict).toBe('fail');
    expect(out.violations).toEqual([{ finding: 'unknown-reference', count: 3 }]);
    expect(out.commits.filter((c) => c.findings.includes('unknown-reference')).map((c) => c.sha.slice(0, 7)))
      .toEqual(['176e565', 'f71d610', '04194dc']);
    expect(summary).toContain('FAIL  v0.4.0 release notes  unknown-reference=3; items linked 4/4, commits 8, ignored 1');
  });

  it('passes once the hidden pull requests are claimed', () => {
    const { code, summary, out } = check('changeset.json');
    expect(code).toBe(0);
    expect(out.verdict).toBe('pass');
    expect(summary).toContain('PASS  v0.4.0 release notes + hidden sections  items linked 7/7, commits 8, ignored 1');
  });

  // The READMEs quote this output; every summary line but the path must match.
  it('matches the output quoted in both READMEs', () => {
    const quoted = [readFileSync(join(dir, 'README.md'), 'utf8'), readFileSync(join(root, 'README.md'), 'utf8')];
    for (const changeset of ['changeset.notes-only.json', 'changeset.json']) {
      const lines = check(changeset).summary.split('\n').filter((l) => l !== '' && !l.startsWith('Wrote '));
      for (const line of lines) expect(quoted[0]).toContain(line);
      vi.restoreAllMocks();
    }
    const lines = check('changeset.notes-only.json').summary.split('\n').filter((l) => l !== '' && !l.startsWith('Wrote '));
    for (const line of lines) expect(quoted[1]).toContain(line);
  });
});

describe('examples/self-check', () => {
  it('has a schema-valid notes-only changeset', () => {
    const dir = join(root, 'examples', 'self-check');
    expect(() => validateChangeset(JSON.parse(readFileSync(join(dir, 'changeset.notes-only.json'), 'utf8')))).not.toThrow();
  });
});
