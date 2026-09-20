import { describe, it, expect } from 'vitest';
import { parseNameStatusZ, effectiveDeltaFor } from '../../src/git/delta.js';
import { CliError } from '../../src/errors.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

const NUL = '\0';
const rec = (...tokens: string[]): string => tokens.join(NUL) + NUL;

describe('parseNameStatusZ', () => {
  it('parses status/path pairs and sorts by path', () => {
    const out = parseNameStatusZ(rec('M', 'z.txt', 'A', 'a.txt'), 'r', '/tmp/r');
    expect(out).toEqual([
      { status: 'A', path: 'a.txt' },
      { status: 'M', path: 'z.txt' }
    ]);
  });

  it('accepts every supported status A, M, D, T', () => {
    const out = parseNameStatusZ(
      rec('A', 'added', 'M', 'modified', 'D', 'deleted', 'T', 'typechange'), 'r', '/tmp/r'
    );
    expect(out.map((d) => d.status).sort()).toEqual(['A', 'D', 'M', 'T']);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNameStatusZ('', 'r', '/tmp/r')).toEqual([]);
  });

  it('preserves unusual path characters through NUL parsing', () => {
    const weird = 'dir/a file "with" quotes\tand tab.txt';
    const out = parseNameStatusZ(rec('A', weird), 'r', '/tmp/r');
    expect(out).toEqual([{ status: 'A', path: weird }]);
  });

  it('rejects an unknown status through the environment-error path', () => {
    try {
      parseNameStatusZ(rec('X', 'f.txt'), 'r', '/tmp/r');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(3);
    }
  });

  it('rejects a rename status R (rename detection must be disabled upstream)', () => {
    expect(() => parseNameStatusZ(rec('R100', 'old', 'new'), 'r', '/tmp/r')).toThrow(CliError);
  });

  it('rejects malformed output with a dangling status and no path', () => {
    expect(() => parseNameStatusZ(rec('A', 'f1.txt', 'M'), 'r', '/tmp/r')).toThrow(CliError);
  });

  it('rejects an empty path token', () => {
    expect(() => parseNameStatusZ(rec('A', ''), 'r', '/tmp/r')).toThrow(CliError);
  });
});

describe('effectiveDeltaFor', () => {
  let repo: FixtureRepo | undefined;

  it('reports only the files that changed between two trees, ignoring renames', () => {
    repo = makeRepo();
    const base = repo.commit('seed', { file: 'app.go' });
    repo.commit('add module', { file: 'go.mod' });
    const head = repo.head();

    const delta = effectiveDeltaFor(base, head, [], 'r', repo.path);
    expect(delta).toEqual([{ status: 'A', path: 'go.mod' }]);
    repo.cleanup();
    repo = undefined;
  });

  it('respects include pathspecs', () => {
    repo = makeRepo();
    const base = repo.commit('seed', { file: 'app.go' });
    repo.commit('touch app', { file: 'app.go' });
    repo.commit('add mod', { file: 'go.mod' });
    const head = repo.head();

    const delta = effectiveDeltaFor(base, head, ['go.mod'], 'r', repo.path);
    expect(delta).toEqual([{ status: 'A', path: 'go.mod' }]);
    repo.cleanup();
    repo = undefined;
  });
});
