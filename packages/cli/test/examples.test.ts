import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe.each(['tracker-keys', 'github-oss', 'release-please'])('examples/%s', (name) => {
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
