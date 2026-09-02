import { describe, it, expect, afterEach } from 'vitest';
import { walkRange, parseLogOutput } from '../../src/git/log.js';
import { resolveRange } from '../../src/git/refs.js';
import { CliError } from '../../src/errors.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import type { RangeSpec } from '../../src/types.js';

let repo: FixtureRepo | undefined;
afterEach(() => { repo?.cleanup(); repo = undefined; });

const walk = (spec: RangeSpec, path: string, history: 'first-parent' | 'all') =>
  walkRange(resolveRange(spec, path), path, history);

describe('walkRange', () => {
  it('returns commits in the range and none outside it', () => {
    repo = makeRepo();
    repo.commit('before'); repo.tag('v1');
    repo.commit('PROJ-1 first');
    repo.commit('PROJ-2 second'); repo.tag('v2');
    const out = walk({ repo: 'repo-a', base: 'v1', head: 'v2' }, repo.path, 'all');
    expect(out.map((c) => c.subject)).toEqual(['PROJ-2 second', 'PROJ-1 first']);
  });

  it('captures author as bare %an, not name-and-email', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('PROJ-3 subject', { author: 'dependabot[bot]' });
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out[0]?.author).toBe('dependabot[bot]');
  });

  it('parses a multi-line body losslessly', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('PROJ-4 subject', { body: 'first line\n\nsecond line refs PROJ-9' });
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out[0]?.body).toContain('first line');
    expect(out[0]?.body).toContain('second line refs PROJ-9');
  });

  it('parses a subject containing separators and special characters', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    const tricky = 'PROJ-5: fix "quoted" | piped \\ backslash and (#42)';
    repo.commit(tricky);
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out[0]?.subject).toBe(tricky);
  });

  it('yields one commit for a squash merge, carrying the pull request number', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('wip one'); repo.commit('wip two'); repo.commit('wip three');
    repo.checkout('main');
    repo.run(['merge', '-q', '--squash', 'feature']);
    repo.run(['commit', '-q', '-m', 'PROJ-8: squashed feature (#42)']);
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'first-parent');
    expect(out).toHaveLength(1);
    expect(out[0]?.subject).toBe('PROJ-8: squashed feature (#42)');
  });

  it('sees a squashed commit identically under history all, since it has one parent', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('wip one'); repo.commit('wip two');
    repo.checkout('main');
    repo.run(['merge', '-q', '--squash', 'feature']);
    repo.run(['commit', '-q', '-m', 'PROJ-8: squashed (#42)']);
    expect(walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all')).toHaveLength(1);
  });

  it('first-parent yields one entry per merge; all yields every commit', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('wip one'); repo.commit('wip two');
    repo.checkout('main');
    repo.mergeNoFf('feature', 'Merge pull request #7 from feature');
    const first = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'first-parent');
    const all = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(first).toHaveLength(1);
    expect(first[0]?.subject).toContain('#7');
    expect(all.length).toBeGreaterThan(1);
  });

  it('handles a rebase-merged branch under history all', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('PROJ-6 one'); repo.commit('PROJ-7 two');
    repo.checkout('main'); repo.commit('main moves on');
    repo.checkout('feature'); repo.rebaseOnto('main');
    repo.checkout('main'); repo.run(['merge', '-q', '--ff-only', 'feature']);
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out.map((c) => c.subject)).toContain('PROJ-6 one');
    expect(out.map((c) => c.subject)).toContain('PROJ-7 two');
  });

  it('applies nested include paths as a pathspec', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('touches a', { file: 'packages/a/src/x.txt' });
    repo.commit('touches b', { file: 'packages/b/src/y.txt' });
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD', include: ['packages/a/**'] }, repo.path, 'all');
    expect(out.map((c) => c.subject)).toEqual(['touches a']);
  });

  it('walks the resolved sha even after the ref moves', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('inside range'); repo.tag('v2');
    const resolved = resolveRange({ repo: 'r', base: 'v1', head: 'v2' }, repo.path);
    repo.commit('added after resolution'); repo.moveTag('v2');
    const out = walkRange(resolved, repo.path, 'all');
    expect(out.map((c) => c.subject)).toEqual(['inside range']);
  });

  it('tags every commit with the configured repo name', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1'); repo.commit('next');
    expect(walk({ repo: 'repo-b', base: 'v1', head: 'HEAD' }, repo.path, 'all')[0]?.repo).toBe('repo-b');
  });

  it('returns an empty list for an empty range', () => {
    repo = makeRepo();
    repo.commit('only'); repo.tag('v1');
    expect(walk({ repo: 'r', base: 'v1', head: 'v1' }, repo.path, 'all')).toEqual([]);
  });
});

describe('parseLogOutput framing', () => {
  const sha = 'a'.repeat(40);
  const record = (s: string, subject = 'subj', body = ''): string =>
    [s, 'Dev', '2026-01-01T00:00:00+00:00', subject, body].join('\0') + '\0';

  it('parses a well-formed single record', () => {
    const out = parseLogOutput(`${record(sha)}\n`, 'r', '/tmp/x');
    expect(out).toHaveLength(1);
    expect(out[0]?.sha).toBe(sha);
  });

  it('accepts a 64-char sha256 object name', () => {
    const sha256 = 'a'.repeat(64);
    const out = parseLogOutput(`${record(sha256)}\n`, 'r', '/tmp/x');
    expect(out).toHaveLength(1);
    expect(out[0]?.sha).toBe(sha256);
  });

  it('parses two records, absorbing the inter-record newline into the sha field', () => {
    const b = 'b'.repeat(40);
    const out = parseLogOutput(`${record(sha)}\n${record(b)}\n`, 'r', '/tmp/x');
    expect(out.map((c) => c.sha)).toEqual([sha, b]);
  });

  it('treats empty output as no commits', () => {
    expect(parseLogOutput('', 'r', '/tmp/x')).toEqual([]);
  });

  it('throws rather than truncating when a field is missing', () => {
    const truncated = [sha, 'Dev', '2026-01-01T00:00:00+00:00'].join('\0') + '\0';
    expect(() => parseLogOutput(`${truncated}\n`, 'r', '/tmp/x')).toThrow(/not a multiple/);
  });

  it('throws rather than silently stopping when a sha is malformed', () => {
    const bad = `${record(sha)}\n${record('not-a-sha')}\n`;
    expect(() => parseLogOutput(bad, 'r', '/tmp/x')).toThrow(/expected a commit sha/);
  });

  it('throws on unexpected trailing data', () => {
    expect(() => parseLogOutput(`${record(sha)}\nleftover`, 'r', '/tmp/x')).toThrow(/trailing data/);
  });

  it('reports framing failures as environment errors, not usage errors', () => {
    try {
      parseLogOutput('garbage', 'r', '/tmp/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
    }
  });

  it('does not trim subject or body', () => {
    const out = parseLogOutput(`${record(sha, '  padded  ', ' body \n\n')}\n`, 'r', '/tmp/x');
    expect(out[0]?.subject).toBe('  padded  ');
    expect(out[0]?.body).toBe(' body \n\n');
  });
});
