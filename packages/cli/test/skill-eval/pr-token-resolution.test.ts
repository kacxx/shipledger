import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import { runCheck } from '../../src/cli/check.js';
import type { VerifiedChangeset } from '../../src/types.js';
import { readFileSync } from 'node:fs';

let repo: FixtureRepo;
let configPath: string;
let outPath: string;

// Scenario: PROJ-101 was merged through PR #42 (squash merge).
// Unrelated work shipped through PR #43 in the same range.
// A correct changeset includes #42 as a pr-ref token for PROJ-101.
// #43 stays unresolved → unknown-reference.

beforeAll(() => {
  repo = makeRepo();

  // Base tag
  repo.commit('initial setup');
  repo.annotatedTag('v1.0.0', 'Release 1.0.0');

  // PR #42 implements PROJ-101 (squash-merged)
  repo.commit('PROJ-101 handle empty range (#42)');

  // PR #43 is unrelated work (no claimed item)
  repo.commit('Refactor auth middleware (#43)');

  // Head tag
  repo.annotatedTag('v1.1.0', 'Release 1.1.0');

  const config = {
    version: 1,
    preset: 'tracker-keys@1',
    repos: [{ name: 'service', path: repo.path }]
  };
  configPath = join(repo.path, 'shipledger.config.json');
  writeFileSync(configPath, JSON.stringify(config));

  outPath = join(repo.path, 'verified-changeset.json');
});

afterAll(() => repo.cleanup());

describe('PR token resolution contract', () => {
  it('links PROJ-101 through its PR token and leaves #43 unknown', () => {
    // Correct changeset: PROJ-101 carries both its ticket-key and its PR #42
    const changeset = {
      version: 1,
      id: 'eval/pr-token',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [
        {
          id: 'PROJ-101',
          title: 'Handle empty range',
          type: 'story',
          status: 'done',
          tokens: [
            { matcher: 'ticket-key', token: 'PROJ-101' },
            { matcher: 'pr-ref', token: '#42', repo: 'service' }
          ]
        }
      ],
      ranges: [{ repo: 'service', base: 'v1.0.0', head: 'v1.1.0' }]
    };

    const changesetPath = join(repo.path, 'changeset.json');
    writeFileSync(changesetPath, JSON.stringify(changeset));

    const exit = runCheck([
      '--config', configPath,
      '--changeset', changesetPath,
      '--out', outPath,
      '--stable'
    ]);

    expect(exit).toBe(1); // policy violation: unknown-reference from #43

    const verified: VerifiedChangeset = JSON.parse(readFileSync(outPath, 'utf8'));

    // PROJ-101 is linked via both ticket-key and pr-ref
    const item = verified.items.find((i) => i.id === 'PROJ-101');
    expect(item).toBeDefined();
    expect(item!.commits.length).toBe(1);
    expect(item!.findings).toEqual([]);

    // The commit carrying #42 resolves to PROJ-101
    const commit42 = verified.commits.find((c) => c.subject.includes('#42'));
    expect(commit42).toBeDefined();
    const prRef = commit42!.references.find((r) => r.token === '#42');
    expect(prRef).toBeDefined();
    expect(prRef!.resolvesTo).toEqual(['PROJ-101']);

    // The commit carrying #43 has an unknown reference
    const commit43 = verified.commits.find((c) => c.subject.includes('#43'));
    expect(commit43).toBeDefined();
    expect(commit43!.findings).toContain('unknown-reference');
    const unresolved = commit43!.references.find((r) => r.token === '#43');
    expect(unresolved).toBeDefined();
    expect(unresolved!.resolvesTo).toEqual([]);
  });

  it('omitting the PR token leaves the commit unlinked to the item', () => {
    // Incorrect changeset: PROJ-101 only carries ticket-key, no PR token
    const changeset = {
      version: 1,
      id: 'eval/missing-pr-token',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [
        {
          id: 'PROJ-101',
          title: 'Handle empty range',
          type: 'story',
          status: 'done',
          tokens: [
            { matcher: 'ticket-key', token: 'PROJ-101' }
          ]
        }
      ],
      ranges: [{ repo: 'service', base: 'v1.0.0', head: 'v1.1.0' }]
    };

    const changesetPath = join(repo.path, 'changeset-no-pr.json');
    writeFileSync(changesetPath, JSON.stringify(changeset));

    const outPath2 = join(repo.path, 'verified-no-pr.json');
    const exit = runCheck([
      '--config', configPath,
      '--changeset', changesetPath,
      '--out', outPath2,
      '--stable'
    ]);

    expect(exit).toBe(1);

    const verified: VerifiedChangeset = JSON.parse(readFileSync(outPath2, 'utf8'));

    // PROJ-101 is still linked via ticket-key in the subject
    const item = verified.items.find((i) => i.id === 'PROJ-101');
    expect(item).toBeDefined();
    expect(item!.commits.length).toBe(1);

    // But #42 is now unknown-reference because no item claims it
    const commit42 = verified.commits.find((c) => c.subject.includes('#42'));
    expect(commit42).toBeDefined();
    expect(commit42!.findings).toContain('unknown-reference');
    const prRef42 = commit42!.references.find((r) => r.token === '#42');
    expect(prRef42!.resolvesTo).toEqual([]);
  });
});

describe('circular association detection', () => {
  it('a PR token with no ticket-key corroboration links only through the declaration', () => {
    // PROJ-999 was never mentioned in any commit subject.
    // Declaring pr-ref #42 for it links the commit, but the ticket-key
    // matcher produces no reference to PROJ-999 — the link is circular.
    const changeset = {
      version: 1,
      id: 'eval/circular',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [
        {
          id: 'PROJ-999',
          title: 'Never mentioned in git',
          type: 'story',
          status: 'done',
          tokens: [
            { matcher: 'ticket-key', token: 'PROJ-999' },
            { matcher: 'pr-ref', token: '#42', repo: 'service' }
          ]
        }
      ],
      ranges: [{ repo: 'service', base: 'v1.0.0', head: 'v1.1.0' }]
    };

    const changesetPath = join(repo.path, 'changeset-circular.json');
    writeFileSync(changesetPath, JSON.stringify(changeset));

    const outCircular = join(repo.path, 'verified-circular.json');
    runCheck([
      '--config', configPath,
      '--changeset', changesetPath,
      '--out', outCircular,
      '--stable'
    ]);

    const verified: VerifiedChangeset = JSON.parse(readFileSync(outCircular, 'utf8'));

    const item = verified.items.find((i) => i.id === 'PROJ-999');
    expect(item).toBeDefined();
    // Item is linked — but only via the pr-ref the agent declared
    expect(item!.commits.length).toBe(1);

    // The commit's ticket-key reference resolves to PROJ-101, not PROJ-999.
    // Only the pr-ref resolves to PROJ-999 — which is the declaration itself.
    const commit42 = verified.commits.find((c) => c.subject.includes('#42'));
    expect(commit42).toBeDefined();
    const ticketRef = commit42!.references.find((r) => r.matcher === 'ticket-key');
    expect(ticketRef).toBeDefined();
    expect(ticketRef!.resolvesTo).not.toContain('PROJ-999');

    const prRef = commit42!.references.find((r) => r.matcher === 'pr-ref' && r.token === '#42');
    expect(prRef).toBeDefined();
    expect(prRef!.resolvesTo).toContain('PROJ-999');
  });
});

describe('fetchedAt plausibility', () => {
  it('rejects a changeset with a future fetchedAt timestamp', () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const changeset = {
      version: 1,
      id: 'eval/future-clock',
      source: { kind: 'test', ref: 'local', fetchedAt: future },
      items: [
        {
          id: 'PROJ-101',
          title: 'Handle empty range',
          type: 'story',
          status: 'done',
          tokens: [{ matcher: 'ticket-key', token: 'PROJ-101' }]
        }
      ],
      ranges: [{ repo: 'service', base: 'v1.0.0', head: 'v1.1.0' }]
    };

    const changesetPath = join(repo.path, 'changeset-future.json');
    writeFileSync(changesetPath, JSON.stringify(changeset));

    const outFuture = join(repo.path, 'verified-future.json');
    const exit = runCheck([
      '--config', configPath,
      '--changeset', changesetPath,
      '--out', outFuture
    ]);

    expect(exit).toBe(2);
  });
});

describe('annotated tag dereference', () => {
  it('resolves annotated tags to commit SHAs, not tag object IDs', () => {
    const changeset = {
      version: 1,
      id: 'eval/annotated-tags',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [
        {
          id: 'PROJ-101',
          title: 'Handle empty range',
          type: 'story',
          status: 'done',
          tokens: [
            { matcher: 'ticket-key', token: 'PROJ-101' },
            { matcher: 'pr-ref', token: '#42', repo: 'service' }
          ]
        }
      ],
      ranges: [{ repo: 'service', base: 'v1.0.0', head: 'v1.1.0' }]
    };

    const changesetPath = join(repo.path, 'changeset-tags.json');
    writeFileSync(changesetPath, JSON.stringify(changeset));

    const outPath3 = join(repo.path, 'verified-tags.json');
    runCheck([
      '--config', configPath,
      '--changeset', changesetPath,
      '--out', outPath3,
      '--stable'
    ]);

    const verified: VerifiedChangeset = JSON.parse(readFileSync(outPath3, 'utf8'));

    // The tag object ID differs from the commit SHA for annotated tags
    const tagObjectId = repo.run(['rev-parse', 'v1.0.0']);
    const commitSha = repo.run(['rev-parse', 'v1.0.0^{commit}']);
    expect(tagObjectId).not.toBe(commitSha);

    // The verified artifact records the commit SHA, not the tag object
    const range = verified.ranges[0];
    expect(range.baseSha).toBe(commitSha);
    expect(range.baseSha).not.toBe(tagObjectId);

    // Same for head
    const headTagObject = repo.run(['rev-parse', 'v1.1.0']);
    const headCommit = repo.run(['rev-parse', 'v1.1.0^{commit}']);
    expect(headTagObject).not.toBe(headCommit);
    expect(range.headSha).toBe(headCommit);
    expect(range.headSha).not.toBe(headTagObject);
  });
});
