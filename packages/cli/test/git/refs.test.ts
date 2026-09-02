import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
});
