import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../../src/cli/doctor.js';
import { CLI_VERSION } from '../../src/cli/version.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

let repo: FixtureRepo | undefined;
let work: string | undefined;

afterEach(() => {
  repo?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
  repo = undefined; work = undefined;
  vi.restoreAllMocks();
});

function capture(): { text: () => string } {
  let buf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { buf += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { buf += String(c); return true; });
  return { text: () => buf };
}

function setup(repoPath: string, preset = 'tracker-keys@1') {
  work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
  writeFileSync(join(work, 'config.json'), JSON.stringify({
    version: 1, preset, repos: [{ name: 'repo-a', path: repoPath }]
  }));
  writeFileSync(join(work, 'changeset.json'), JSON.stringify({
    version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
    items: [], ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
  }));
  return ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json')];
}

function healthyRepo(): FixtureRepo {
  const r = makeRepo();
  r.commit('a'); r.tag('v1'); r.commit('b'); r.tag('v2');
  return r;
}

describe('runDoctor', () => {
  it('reports OK for a healthy repo and range', () => {
    repo = healthyRepo();
    const out = capture();
    expect(runDoctor(setup(repo.path), process.cwd())).toBe(0);
    expect(out.text()).toMatch(/OK/);
    expect(out.text()).toMatch(/repo-a/);
  });

  it('prints the fingerprint and resolved preset', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    expect(out.text()).toMatch(/sha256:[0-9a-f]{64}/);
    expect(out.text()).toMatch(/tracker-keys@1/);
  });

  it('states that upstream freshness is unknown', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    expect(out.text()).toMatch(/upstream state is unknown/i);
  });

  it('returns 2 for an unpinned preset', () => {
    repo = healthyRepo();
    capture();
    expect(runDoctor(setup(repo.path, 'tracker-keys'), process.cwd())).toBe(2);
  });

  it('returns 3 and names the remedy for a missing repo, skipping its range check', () => {
    const out = capture();
    expect(runDoctor(setup('/nonexistent/repo'), process.cwd())).toBe(3);
    const text = out.text();
    expect(text).toMatch(/does not exist/);
    expect(text).not.toMatch(/FAIL range/);
  });

  it('validates the changeset before opening repositories', () => {
    const args = setup('/nonexistent/repo');
    const changesetPath = args[args.indexOf('--changeset') + 1] as string;
    writeFileSync(changesetPath, JSON.stringify({
      version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [], ranges: [{ repo: 'ghost', base: 'v1', head: 'v2' }]
    }));
    const out = capture();
    expect(runDoctor(args, process.cwd())).toBe(2);
    expect(out.text()).toMatch(/ghost/);
  });

  it('reports divergence as a warning without failing', () => {
    repo = makeRepo();
    repo.commit('root');
    repo.branch('a'); repo.branch('b');
    repo.checkout('a'); repo.commit('on a'); repo.tag('v1');
    repo.checkout('b'); repo.commit('on b'); repo.tag('v2');
    const out = capture();
    expect(runDoctor(setup(repo.path), process.cwd())).toBe(0);
    expect(out.text()).toMatch(/WARN/);
    expect(out.text()).toMatch(/diverge/i);
  });

  it('checks only the repos when no changeset is given', () => {
    repo = healthyRepo();
    const args = setup(repo.path).slice(0, 2);
    const out = capture();
    expect(runDoctor(args, process.cwd())).toBe(0);
    expect(out.text()).toMatch(/repo-a/);
  });

  it('reports a compatible skill range as OK', () => {
    repo = healthyRepo();
    const out = capture();
    const code = runDoctor([...setup(repo.path), '--skill-cli-range', `^${CLI_VERSION}`], process.cwd());
    expect(code).toBe(0);
    expect(out.text()).toMatch(/skill/i);
  });

  it('reports an incompatible skill range and fails', () => {
    repo = healthyRepo();
    const out = capture();
    expect(runDoctor([...setup(repo.path), '--skill-cli-range', '^99.0.0'], process.cwd())).toBe(3);
    expect(out.text()).toMatch(/incompatible/i);
  });

  it('reports an unparseable skill range rather than assuming compatibility', () => {
    repo = healthyRepo();
    const out = capture();
    expect(runDoctor([...setup(repo.path), '--skill-cli-range', 'sometimes'], process.cwd())).toBe(3);
    expect(out.text()).toMatch(/cannot interpret/i);
  });

  it('shows effective config with preset origin markers', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    const text = out.text();
    expect(text).toMatch(/effective config:/);
    expect(text).toMatch(/matchers \[preset\]:/);
    expect(text).toMatch(/ticket-key/);
    expect(text).toMatch(/history\s+\[preset\]:/);
    expect(text).toMatch(/ignore\s+\[preset\]:/);
    expect(text).toMatch(/policy\s+\[preset\]:/);
  });

  it('marks adopter overrides distinctly from preset defaults', () => {
    repo = healthyRepo();
    work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }],
      policy: { failOn: ['unknown-reference'] }
    }));
    const out = capture();
    runDoctor(['--config', join(work, 'config.json')], process.cwd());
    const text = out.text();
    expect(text).toMatch(/policy\s+\[adopter override\]:/);
    expect(text).toMatch(/matchers \[preset\]:/);
  });

  it('reports dirty files under include paths as INFO', () => {
    repo = healthyRepo();
    mkdirSync(join(repo.path, 'pkg'));
    writeFileSync(join(repo.path, 'pkg', 'dirty.txt'), 'dirty\n');

    work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }]
    }));
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [], ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2', include: ['pkg/**'] }]
    }));

    const out = capture();
    const code = runDoctor(['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json')], process.cwd());
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toMatch(/INFO repo repo-a/);
    expect(text).toMatch(/changed file\(s\) under pkg\/\*\*/);
    expect(text).toMatch(/untracked:.*pkg\/dirty\.txt/);
    expect(text).toMatch(/these changes are excluded/);
  });

  it('skips dirty-tree check for repos not in the changeset', () => {
    repo = healthyRepo();
    writeFileSync(join(repo.path, 'dirty.txt'), 'dirty\n');

    const repo2 = healthyRepo();

    work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }, { name: 'repo-b', path: repo2.path }]
    }));
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [], ranges: [{ repo: 'repo-b', base: 'v1', head: 'v2' }]
    }));

    const out = capture();
    runDoctor(['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json')], process.cwd());
    expect(out.text()).not.toMatch(/INFO.*repo-a/);
    expect(out.text()).not.toMatch(/dirty\.txt/);
    repo2.cleanup();
  });

  it('renders effective config as canonical JSON with all matcher fields', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    const text = out.text();
    expect(text).toMatch(/"id":"ticket-key"/);
    expect(text).toMatch(/"pattern"/);
    expect(text).toMatch(/"normalize"/);
    expect(text).toMatch(/"namespace"/);
  });

  it('does not report dirt outside include paths', () => {
    repo = healthyRepo();
    writeFileSync(join(repo.path, 'outside.txt'), 'outside\n');

    work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }]
    }));
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [], ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2', include: ['pkg/**'] }]
    }));

    const out = capture();
    runDoctor(['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json')], process.cwd());
    expect(out.text()).not.toMatch(/INFO/);
    expect(out.text()).not.toMatch(/outside\.txt/);
  });

  it('shows normalized links in effective config marked as adopter', () => {
    repo = healthyRepo();
    work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: repo.path }],
      links: {
        references: { 'ticket-key': 'https://tracker.example.com/browse/{token}' },
        repos: { 'repo-a': { commit: 'https://github.com/example/repo-a/commit/{sha}' } }
      }
    }));
    const out = capture();
    runDoctor(['--config', join(work, 'config.json')], process.cwd());
    const text = out.text();
    expect(text).toMatch(/links\s+\[adopter\]:/);
    expect(text).toMatch(/tracker\.example\.com/);
    expect(text).toMatch(/\{token\}/);
    expect(text).toMatch(/\{sha\}/);
  });

  it('omits links line from effective config when no links configured', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    expect(out.text()).not.toMatch(/links\s+\[adopter\]/);
  });
});

import { checkCliRange } from '../../src/cli/doctor.js';

describe('checkCliRange', () => {
  it('accepts a caret range within the same major', () => {
    expect(checkCliRange('^1.2.0', '1.4.0')).toEqual({ ok: true, compatible: true });
  });

  it('rejects a caret range across a major', () => {
    expect(checkCliRange('^1.2.0', '2.0.0')).toEqual({ ok: true, compatible: false });
  });

  it('rejects a caret range below the floor', () => {
    expect(checkCliRange('^1.4.0', '1.3.9')).toEqual({ ok: true, compatible: false });
  });

  it('pins the minor for a 0.x caret range, since 0.x minors are breaking', () => {
    expect(checkCliRange('^0.1.0', '0.1.0')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('^0.1.0', '0.1.7')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('^0.1.0', '0.2.0')).toEqual({ ok: true, compatible: false });
    expect(checkCliRange('^0.1.2', '0.1.1')).toEqual({ ok: true, compatible: false });
  });

  it('pins the patch for a 0.0.x caret range', () => {
    expect(checkCliRange('^0.0.3', '0.0.3')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('^0.0.3', '0.0.4')).toEqual({ ok: true, compatible: false });
  });

  it('does not treat a 1.x caret as pinning the minor', () => {
    expect(checkCliRange('^1.1.0', '1.9.0')).toEqual({ ok: true, compatible: true });
  });

  it('handles >= ranges', () => {
    expect(checkCliRange('>=1.0.0', '2.5.1')).toEqual({ ok: true, compatible: true });
  });

  it('handles an exact pin', () => {
    expect(checkCliRange('1.2.3', '1.2.3')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('1.2.3', '1.2.4')).toEqual({ ok: true, compatible: false });
  });

  it('reports an unsupported range form as unparseable', () => {
    expect(checkCliRange('~1.2.3', '1.2.3')).toEqual({ ok: false });
    expect(checkCliRange('1.x', '1.2.3')).toEqual({ ok: false });
  });
});
