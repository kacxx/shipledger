import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheck } from '../../src/cli/check.js';
import { renderReport } from '../../src/render/report.js';
import { validateVerified } from '../../src/config/validate.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

let repo: FixtureRepo | undefined;
let extraRepo: FixtureRepo | undefined;
let work: string | undefined;

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  repo?.cleanup();
  extraRepo?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
  repo = undefined; extraRepo = undefined; work = undefined;
  vi.restoreAllMocks();
});

const item = (id: string, token: string) => ({
  id, title: 't', type: 'story', status: 'done',
  tokens: [{ matcher: 'ticket-key', token }]
});

function scenario(opts: { subjects: string[]; items: unknown[]; failOn?: string[]; preset?: string }) {
  repo = makeRepo();
  repo.commit('base'); repo.tag('v1');
  for (const s of opts.subjects) repo.commit(s);
  repo.tag('v2');

  work = mkdtempSync(join(tmpdir(), 'shipledger-work-'));
  writeFileSync(join(work, 'config.json'), JSON.stringify({
    version: 1,
    preset: opts.preset ?? 'tracker-keys@1',
    repos: [{ name: 'repo-a', path: repo.path }],
    ...(opts.failOn ? { policy: { failOn: opts.failOn } } : {})
  }));
  writeFileSync(join(work, 'changeset.json'), JSON.stringify({
    version: 1, id: 'release 1.4.0',
    source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
    items: opts.items,
    ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
  }));
  return {
    args: ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json'), '--out', join(work, 'out.json')],
    out: join(work, 'out.json'),
    configPath: join(work, 'config.json'),
    changesetPath: join(work, 'changeset.json')
  };
}

describe('runCheck', () => {
  it('exits 0 and writes schema-valid output when everything reconciles', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: ['no-reference', 'unknown-reference', 'item-without-commits'] });
    expect(runCheck(s.args, process.cwd())).toBe(0);
    const out = JSON.parse(readFileSync(s.out, 'utf8'));
    expect(out.verdict).toBe('pass');
    expect(() => validateVerified(out)).not.toThrow();
  });

  it('exits 1 on a policy violation but still writes the output', () => {
    const s = scenario({ subjects: ['PROJ-9 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: ['unknown-reference'] });
    expect(runCheck(s.args, process.cwd())).toBe(1);
    const out = JSON.parse(readFileSync(s.out, 'utf8'));
    expect(out.verdict).toBe('fail');
    expect(out.violations[0].finding).toBe('unknown-reference');
  });

  it('exits 2 when the preset is unpinned', () => {
    const s = scenario({ subjects: ['x'], items: [], preset: 'tracker-keys' });
    expect(runCheck(s.args, process.cwd())).toBe(2);
  });

  it('exits 2 when the changeset names an undefined repo', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    const bad = JSON.parse(readFileSync(s.changesetPath, 'utf8'));
    bad.ranges = [{ repo: 'ghost', base: 'v1', head: 'v2' }];
    writeFileSync(s.changesetPath, JSON.stringify(bad));
    expect(runCheck(s.args, process.cwd())).toBe(2);
  });

  it('exits 2 for an invalid matcher pattern before opening any repository', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    writeFileSync(s.configPath, JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: '/nonexistent/repo' }],
      matchers: [{ id: 'bad', sources: ['subject'], pattern: '([', namespace: 'global', normalize: 'none' }]
    }));
    expect(runCheck(s.args, process.cwd())).toBe(2);
  });

  it('exits 3 when a configured repo path does not exist', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    writeFileSync(s.configPath, JSON.stringify({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '/nonexistent/repo' }]
    }));
    expect(runCheck(s.args, process.cwd())).toBe(3);
  });

  it('exits 2 when --changeset is missing', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    expect(runCheck(['--config', s.configPath], process.cwd())).toBe(2);
  });

  it('exits 2 for an unknown flag', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    expect(runCheck([...s.args, '--turbo'], process.cwd())).toBe(2);
  });

  it('omits generatedAt under --stable and is byte-identical across runs', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    runCheck([...s.args, '--stable'], process.cwd());
    const first = readFileSync(s.out, 'utf8');
    runCheck([...s.args, '--stable'], process.cwd());
    expect(readFileSync(s.out, 'utf8')).toBe(first);
    expect(JSON.parse(first).generatedAt).toBeUndefined();
  });

  it('includes generatedAt without --stable', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    runCheck(s.args, process.cwd());
    expect(JSON.parse(readFileSync(s.out, 'utf8')).generatedAt).toMatch(/^\d{4}-/);
  });

  it('writes sorted keys so output diffs cleanly', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    runCheck([...s.args, '--stable'], process.cwd());
    const text = readFileSync(s.out, 'utf8');
    expect(text.indexOf('"changeset"')).toBeLessThan(text.indexOf('"cliVersion"'));
  });

  it('exits 3 when the output path is not writable', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    const args = ['--config', s.configPath, '--changeset', s.changesetPath, '--out', '/nonexistent-dir/out.json'];
    expect(runCheck(args, process.cwd())).toBe(3);
  });

  it('walks repos in config order regardless of the order ranges appear in the changeset', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1'); repo.commit('PROJ-1 in first repo'); repo.tag('v2');
    extraRepo = makeRepo();
    extraRepo.commit('base'); extraRepo.tag('v1'); extraRepo.commit('PROJ-2 in second repo'); extraRepo.tag('v2');

    work = mkdtempSync(join(tmpdir(), 'shipledger-order-'));
    const out = join(work, 'out.json');
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'alpha', path: repo.path }, { name: 'beta', path: extraRepo.path }],
      policy: { failOn: [] }
    }));
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'r',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [item('PROJ-1', 'PROJ-1'), item('PROJ-2', 'PROJ-2')],
      ranges: [
        { repo: 'beta', base: 'v1', head: 'v2' },
        { repo: 'alpha', base: 'v1', head: 'v2' }
      ]
    }));

    const args = ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json'), '--out', out, '--stable'];
    expect(runCheck(args, process.cwd())).toBe(0);
    const verified = validateVerified(JSON.parse(readFileSync(out, 'utf8')));
    expect(verified.commits.map((c) => c.repo)).toEqual(['alpha', 'beta']);
    expect(verified.ranges.map((r) => r.repo)).toEqual(['alpha', 'beta']);
  });

  it('propagates config links through check --stable → verified → render', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('PROJ-1 first change');
    repo.commit('#42 pr fix');
    repo.tag('v2');

    work = mkdtempSync(join(tmpdir(), 'shipledger-links-'));
    const out = join(work, 'out.json');
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }],
      policy: { failOn: [] },
      links: {
        references: { 'ticket-key': 'https://tracker.example.com/browse/{token}' },
        repos: {
          'repo-a': {
            commit: 'https://github.com/example/repo-a/commit/{sha}',
            references: { 'pr-ref': { url: 'https://github.com/example/repo-a/pull/{token}', stripPrefix: '#' } }
          }
        }
      }
    }));
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'release-links',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [{ id: 'PROJ-1', title: 'first', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-1' }] }],
      ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
    }));

    const args = ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json'), '--out', out, '--stable'];
    expect(runCheck(args, process.cwd())).toBe(0);

    const verified = validateVerified(JSON.parse(readFileSync(out, 'utf8')));
    expect(verified.links).toBeDefined();
    expect(verified.links?.references?.['ticket-key']?.url).toBe('https://tracker.example.com/browse/{token}');
    expect(verified.links?.repos?.['repo-a']?.commit).toBe('https://github.com/example/repo-a/commit/{sha}');
    expect(verified.links?.repos?.['repo-a']?.references?.['pr-ref']?.stripPrefix).toBe('#');

    const report = renderReport(verified);
    expect(report).toContain('https://github.com/example/repo-a/commit/');
    expect(report).toContain('https://github.com/example/repo-a/pull/42');
    expect(report).not.toContain('pull/%2342');

    const report2 = renderReport(verified);
    expect(report).toBe(report2);
  });

  it('renders resolved #42 reference as a clickable /pull/42 link in the report', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('#42 quick fix');
    repo.tag('v2');

    work = mkdtempSync(join(tmpdir(), 'shipledger-pr-resolve-'));
    const out = join(work, 'out.json');
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }],
      policy: { failOn: [] },
      links: {
        repos: {
          'repo-a': {
            commit: 'https://github.com/example/repo-a/commit/{sha}',
            references: { 'pr-ref': { url: 'https://github.com/example/repo-a/pull/{token}', stripPrefix: '#' } }
          }
        }
      }
    }));
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'release-pr-resolve',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [{
        id: 'PR-42', title: 'quick fix', type: 'pr', status: 'merged',
        tokens: [{ matcher: 'pr-ref', token: '#42', repo: 'repo-a' }]
      }],
      ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
    }));

    const args = ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json'), '--out', out, '--stable'];
    expect(runCheck(args, process.cwd())).toBe(0);

    const verified = validateVerified(JSON.parse(readFileSync(out, 'utf8')));
    const prCommit = verified.commits.find((c) => c.subject.includes('#42'));
    expect(prCommit).toBeDefined();
    expect(prCommit!.references.some((r) => r.matcher === 'pr-ref' && r.token === '#42' && r.resolvesTo.includes('PR-42'))).toBe(true);

    const report = renderReport(verified);
    expect(report).toContain('[\\#42](https://github.com/example/repo-a/pull/42)');
    expect(report).toContain('→ PR-42');
    expect(report).toMatch(/linked/);
    expect(report).not.toMatch(/unknown\\-reference/);
  });
});
