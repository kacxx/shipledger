import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runCheck } from '../../src/cli/check.js';
import { runRender } from '../../src/cli/render.js';
import { validateVerified } from '../../src/config/validate.js';
import type { VerifiedChangeset } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const bundle = join(root, 'fixtures', 'deterministic.bundle');
const expectedPath = join(root, 'fixtures', 'expected.json');

interface Expected {
  tags: { base: string; head: string };
  commits: Array<{ sha: string; author: string; subject: string }>;
}

let work: string;
let repoPath: string;
let configPath: string;
let changesetPath: string;
let outPath: string;
let expected: Expected;

const shaFor = (subject: string): string => {
  const hit = expected.commits.find((c) => c.subject === subject);
  if (!hit) throw new Error(`fixture has no commit with subject "${subject}"`);
  return hit.sha;
};

beforeAll(() => {
  if (!existsSync(bundle) || !existsSync(expectedPath)) {
    throw new Error('Missing fixture. Run ./fixtures/make-bundle.sh once and commit both outputs.');
  }
  expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;

  work = mkdtempSync(join(tmpdir(), 'shipledger-e2e-'));
  repoPath = join(work, 'repo');
  execFileSync('git', ['clone', '--quiet', bundle, repoPath]);

  const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
  config.repos[0].path = repoPath;
  configPath = join(work, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));

  changesetPath = join(work, 'changeset.json');
  writeFileSync(changesetPath, readFileSync(join(here, 'changeset.json'), 'utf8'));
  outPath = join(work, 'verified.json');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

const args = (): string[] =>
  ['--config', configPath, '--changeset', changesetPath, '--out', outPath, '--stable'];

const read = (): VerifiedChangeset =>
  validateVerified(JSON.parse(readFileSync(outPath, 'utf8')));

describe('end to end over the deterministic bundle', () => {
  it('exits 1 because the fixture contains one unknown reference', () => {
    expect(runCheck(args(), process.cwd())).toBe(1);
  });

  it('resolves both refs to the SHAs recorded in the fixture', () => {
    runCheck(args(), process.cwd());
    const range = read().ranges[0];
    expect(range?.headSha).toBe(shaFor('chore(deps): bump left-pad'));
    expect(range?.baseIsAncestorOfHead).toBe(true);
    expect(range?.include).toEqual(['packages/a/**']);
  });

  it('links PROJ-1 and PROJ-2 to their exact commits with no findings', () => {
    runCheck(args(), process.cwd());
    const v = read();

    const first = v.commits.find((c) => c.sha === shaFor('PROJ-1: add the widget (#11)'));
    expect(first?.findings).toEqual([]);
    expect(v.items.find((i) => i.id === 'PROJ-1')?.commits).toEqual([
      { repo: 'pinned', sha: shaFor('PROJ-1: add the widget (#11)') }
    ]);

    const second = v.commits.find((c) => c.sha === shaFor('PROJ-2: fix the gadget (#12)'));
    expect(second?.references.map((r) => r.token).sort()).toEqual(['#12', 'PROJ-2']);
    expect(second?.references.every((r) => r.resolvesTo.length > 0)).toBe(true);
    expect(second?.findings).toEqual([]);
    expect(v.items.find((i) => i.id === 'PROJ-2')?.commits).toEqual([
      { repo: 'pinned', sha: shaFor('PROJ-2: fix the gadget (#12)') }
    ]);
  });

  it('flags the PROJ-9 commit, whose ticket key and pull request number are both unclaimed', () => {
    runCheck(args(), process.cwd());
    const commit = read().commits.find((c) => c.sha === shaFor('PROJ-9: unrelated work (#13)'));
    expect(commit?.findings).toEqual(['unknown-reference']);
    expect(commit?.references.map((r) => r.token).sort()).toEqual(['#13', 'PROJ-9']);
    expect(commit?.references.every((r) => r.resolvesTo.length === 0)).toBe(true);
  });

  it('flags the reformat commit as no-reference', () => {
    runCheck(args(), process.cwd());
    expect(read().commits.find((c) => c.sha === shaFor('chore: reformat everything'))?.findings)
      .toEqual(['no-reference']);
  });

  it('ignores the dependabot commit by author rule and gives it no findings', () => {
    runCheck(args(), process.cwd());
    const commit = read().commits.find((c) => c.sha === shaFor('chore(deps): bump left-pad'));
    expect(commit?.ignored?.rule).toBe('authors:dependabot[bot]');
    expect(commit?.findings).toEqual([]);
  });

  it('excludes the package-b commit via the include pathspec', () => {
    runCheck(args(), process.cwd());
    const subjects = read().commits.map((c) => c.subject);
    expect(subjects).not.toContain('docs: only touches package b (#14)');
  });

  it('walks exactly the five in-scope commits', () => {
    runCheck(args(), process.cwd());
    expect(read().commits.map((c) => c.subject)).toEqual([
      'chore(deps): bump left-pad',
      'chore: reformat everything',
      'PROJ-9: unrelated work (#13)',
      'PROJ-2: fix the gadget (#12)',
      'PROJ-1: add the widget (#11)'
    ]);
  });

  it('flags PROJ-3 as claimed with no commits', () => {
    runCheck(args(), process.cwd());
    expect(read().items.find((i) => i.id === 'PROJ-3')?.findings).toEqual(['item-without-commits']);
  });

  it('reports exact summary counts', () => {
    runCheck(args(), process.cwd());
    const v = read();
    expect(v.summary).toEqual({
      items: 3, itemsLinked: 2, commits: 5, commitsIgnored: 1,
      noReference: 1, unknownReference: 1, itemsWithoutCommits: 1, rangeDivergence: 0
    });
    expect(v.violations).toEqual([{ finding: 'unknown-reference', count: 1 }]);
    expect(v.verdict).toBe('fail');
  });

  it('produces an artifact that passes its own semantic validation', async () => {
    const { assertVerifiedSemantics } = await import('../../src/verify.js');
    runCheck(args(), process.cwd());
    expect(() => assertVerifiedSemantics(read())).not.toThrow();
  });

  it('produces byte-identical output across two runs', () => {
    runCheck(args(), process.cwd());
    const first = readFileSync(outPath, 'utf8');
    runCheck(args(), process.cwd());
    expect(readFileSync(outPath, 'utf8')).toBe(first);
  });

  it('renders every format without error', () => {
    runCheck(args(), process.cwd());
    for (const format of ['report', 'changelog', 'release-notes']) {
      expect(runRender([format, '--input', outPath], process.cwd())).toBe(0);
    }
  });

  it('rejects a shallow clone with exit 3', () => {
    const shallow = join(work, 'shallow');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repoPath}`, shallow]);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.repos[0].path = shallow;
    const shallowConfig = join(work, 'shallow-config.json');
    writeFileSync(shallowConfig, JSON.stringify(config));
    expect(runCheck(['--config', shallowConfig, '--changeset', changesetPath, '--out', outPath], process.cwd())).toBe(3);
  });
});
