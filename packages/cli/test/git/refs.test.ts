import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { assertUsableRepo, resolveRange } from '../../src/git/refs.js';
import { CliError } from '../../src/errors.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

let repo: FixtureRepo | undefined;
const extras: string[] = [];

afterEach(() => {
  repo?.cleanup();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
  repo = undefined;
});

describe('assertUsableRepo', () => {
  it('accepts a normal repo', () => {
    repo = makeRepo();
    repo.commit('init');
    expect(() => assertUsableRepo(repo!.path, 'repo-a')).not.toThrow();
  });

  it('rejects a missing directory with exit 3 and names the repo', () => {
    try {
      assertUsableRepo('/nonexistent/repo', 'repo-a');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as Error).message).toMatch(/repo-a/);
    }
  });

  it('accepts the repo root reached through a symlink', () => {
    repo = makeRepo();
    repo.commit('init');
    const dir = mkdtempSync(join(tmpdir(), 'shipledger-link-'));
    extras.push(dir);
    const link = join(dir, 'linked-repo');
    symlinkSync(repo.path, link, 'dir');
    // git reports the real path, so a raw string comparison would reject this.
    expect(() => assertUsableRepo(link, 'repo-a')).not.toThrow();
  });

  it('accepts the repo root given with a trailing separator', () => {
    repo = makeRepo();
    repo.commit('init');
    expect(() => assertUsableRepo(`${repo.path}${sep}`, 'repo-a')).not.toThrow();
  });

  it('rejects a directory that is not a work tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shipledger-plain-'));
    extras.push(dir);
    expect(() => assertUsableRepo(dir, 'repo-a')).toThrow(/work tree/);
  });

  it('rejects a shallow clone and names the remedy', () => {
    repo = makeRepo();
    repo.commit('one'); repo.commit('two');
    const shallow = mkdtempSync(join(tmpdir(), 'shipledger-shallow-'));
    extras.push(shallow);
    rmSync(shallow, { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repo.path}`, shallow]);
    expect(() => assertUsableRepo(shallow, 'repo-a')).toThrow(/unshallow/);
  });
});

describe('resolveRange', () => {
  it('resolves shas and reports linear ancestry', () => {
    repo = makeRepo();
    repo.commit('one'); repo.tag('v1');
    repo.commit('two'); repo.tag('v2');
    const out = resolveRange({ repo: 'repo-a', base: 'v1', head: 'v2' }, repo.path);
    expect(out.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.baseIsAncestorOfHead).toBe(true);
    expect(out.commitsOnlyInBase).toBe(0);
    expect(out.findings).toEqual([]);
  });

  it('defaults include to an empty array and preserves it when given', () => {
    repo = makeRepo();
    repo.commit('one'); repo.tag('v1'); repo.commit('two'); repo.tag('v2');
    expect(resolveRange({ repo: 'r', base: 'v1', head: 'v2' }, repo.path).include).toEqual([]);
    expect(resolveRange({ repo: 'r', base: 'v1', head: 'v2', include: ['a/**'] }, repo.path).include).toEqual(['a/**']);
  });

  it('flags range-divergence for independently cut branches', () => {
    repo = makeRepo();
    repo.commit('root');
    repo.branch('release-a'); repo.branch('release-b');
    repo.checkout('release-a'); repo.commit('only on a');
    repo.checkout('release-b'); repo.commit('only on b');
    const out = resolveRange({ repo: 'repo-a', base: 'release-a', head: 'release-b' }, repo.path);
    expect(out.baseIsAncestorOfHead).toBe(false);
    expect(out.commitsOnlyInBase).toBe(1);
    expect(out.findings).toEqual(['range-divergence']);
    expect(out.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects an unresolvable ref with exit 3', () => {
    repo = makeRepo();
    repo.commit('one');
    try {
      resolveRange({ repo: 'repo-a', base: 'v-nope', head: 'HEAD' }, repo.path);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as Error).message).toMatch(/v-nope/);
    }
  });

  it('blocks a name that is both a branch and a tag at different commits', () => {
    repo = makeRepo();
    const first = repo.commit('one');
    repo.commit('two');
    repo.commit('three');
    repo.run(['branch', 'v1.0', first]);
    repo.tag('v1.0');

    try {
      resolveRange({ repo: 'repo-a', base: first, head: 'v1.0' }, repo.path);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as Error).message).toMatch(/ambiguous/);
      // The remedy must name both candidates so the operator can choose.
      expect((err as Error).message).toMatch(/refs\/tags\/v1\.0/);
      expect((err as Error).message).toMatch(/refs\/heads\/v1\.0/);
    }
  });

  it('allows a name that is a branch and a tag pointing at the same commit', () => {
    repo = makeRepo();
    const first = repo.commit('one');
    repo.commit('two');
    repo.branch('v1.0');
    repo.tag('v1.0');
    expect(() => resolveRange({ repo: 'repo-a', base: first, head: 'v1.0' }, repo.path)).not.toThrow();
  });

  it('leaves an unambiguous tag alone', () => {
    repo = makeRepo();
    const first = repo.commit('one');
    repo.commit('two');
    repo.tag('v1.0');
    const out = resolveRange({ repo: 'repo-a', base: first, head: 'v1.0' }, repo.path);
    expect(out.headSha).toBe(repo.head());
  });

  it('does not mistake a revision expression for an ambiguous name', () => {
    repo = makeRepo();
    repo.commit('one');
    repo.commit('two');
    repo.branch('v1.0');
    repo.tag('v1.0');
    // HEAD~1 contains an operator, so it can only resolve one way.
    expect(() => resolveRange({ repo: 'repo-a', base: 'HEAD~1', head: 'HEAD' }, repo.path)).not.toThrow();
  });
});
