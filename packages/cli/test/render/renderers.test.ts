import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../../src/render/report.js';
import { renderChangelog } from '../../src/render/changelog.js';
import { renderReleaseNotes } from '../../src/render/release-notes.js';
import { validateVerified } from '../../src/config/validate.js';
import type { NotesFile, VerifiedChangeset } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const verified = validateVerified(
  JSON.parse(readFileSync(join(here, '..', 'fixtures', 'verified-example.json'), 'utf8'))
);

const multiRepo = validateVerified(
  JSON.parse(readFileSync(join(here, '..', 'fixtures', 'verified-multi-repo.json'), 'utf8'))
);

const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';

const notes: NotesFile = {
  version: 1,
  noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', note: 'lint config only' }],
  unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
  items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
  ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
};

const multiRepoNotes: NotesFile = {
  version: 1,
  noReference: [
    { repo: 'backend', sha: 'aa00000400000000000000000000000000000000', classification: 'tooling-or-ci', note: 'html cleanup' },
    { repo: 'frontend', sha: 'ff00000200000000000000000000000000000000', classification: 'process-miss', note: 'dev forgot ticket' }
  ],
  unknownReference: [
    { repo: 'backend', sha: 'aa00000300000000000000000000000000000000', matcher: 'ticket-key', token: 'PROJ-99', classification: 'other-release', note: 'belongs to 1.8' },
    { repo: 'backend', sha: 'aa00000300000000000000000000000000000000', matcher: 'ticket-key', token: 'OTHER-7', classification: 'other-release', note: 'different project' }
  ],
  items: [{ item: 'PROJ-12', classification: 'not-done', note: 'docs not ready yet' }],
  ranges: [{ repo: 'frontend', classification: 'expected-divergence', note: 'hotfix branch cut' }]
};

const golden = (name: string): string =>
  readFileSync(join(here, '__golden__', `${name}.txt`), 'utf8');

describe('renderReport', () => {
  const text = renderReport(verified);

  it('states the verdict', () => { expect(text).toMatch(/FAIL/); });
  it('names the unresolved token', () => { expect(text).toMatch(/PROJ-9/); });
  it('lists the unreferenced commit', () => { expect(text).toMatch(/cccccccc/); });
  it('lists the item with no commits', () => {
    expect(text).toMatch(/Claimed but absent/);
    expect(text).toMatch(/in-progress/);
  });
  it('shows the ignored commit and its rule', () => { expect(text).toMatch(/subjects:\^Merge branch/); });
  it('reports range divergence with the count only in base', () => {
    expect(text).toMatch(/diverge/i);
    expect(text).toMatch(/2 commit/);
  });
  it('does not attribute a finding to the ignored commit', () => {
    expect(text).not.toMatch(/dddddddd.*no-reference/);
  });
  it('shows a commit that is both linked and carrying an unknown reference', () => {
    expect(text).toMatch(/bbbbbbbb/);
  });
  it('includes triage notes when supplied', () => {
    const withNotes = renderReport(verified, notes);
    expect(withNotes).toMatch(/tooling-or-ci/);
    expect(withNotes).toMatch(/shipped in 1\.3/);
    expect(withNotes).toMatch(/expected-divergence/);
  });
  it('is deterministic', () => {
    expect(renderReport(verified, notes)).toBe(renderReport(verified, notes));
  });
  it('includes config fingerprint', () => {
    expect(text).toMatch(/sha256:0{64}/);
  });
  it('includes source provenance', () => {
    expect(text).toMatch(/fetched 2026-01-01T00:00:00Z/);
  });
  it('renders as Markdown with headings and tables', () => {
    expect(text).toMatch(/^# Reconciliation Report/m);
    expect(text).toMatch(/^## Summary/m);
    expect(text).toMatch(/^## repo-a/m);
    expect(text).toMatch(/^\| Field \| Value \|/m);
    expect(text).toMatch(/^\| Repo \| SHA \| Subject \| Status \| Detail \|/m);
    expect(text).toMatch(/^\| Item \| Title \| Type \| Status \| Commits \| Finding \| Triage \|/m);
  });
  it('separates engine verdict from triage', () => {
    const untriaged = renderReport(verified);
    expect(untriaged).toMatch(/UNTRIAGED/);
    expect(untriaged).toMatch(/\*\*FAIL\*\*/);
    const triaged = renderReport(verified, notes);
    expect(triaged).not.toMatch(/UNTRIAGED/);
    expect(triaged).toMatch(/\*\*FAIL\*\*/);
  });
  it('separates affected-commit count from unresolved-token count', () => {
    expect(text).toMatch(/2 affected commit\(s\), 2 unresolved token\(s\)/);
  });
});

describe('renderReport multi-repo', () => {
  const text = renderReport(multiRepo);

  it('includes a section for each repository', () => {
    expect(text).toMatch(/^## backend$/m);
    expect(text).toMatch(/^## frontend$/m);
  });
  it('shows every commit in the evidence table', () => {
    for (const sha of ['aa000001', 'aa000002', 'aa000003', 'aa000004', 'aa000005', 'ff000001', 'ff000002']) {
      expect(text).toContain(sha);
    }
  });
  it('shows every item in the items table', () => {
    expect(text).toMatch(/PROJ-10/);
    expect(text).toMatch(/PROJ-11/);
    expect(text).toMatch(/PROJ-12/);
  });
  it('lists multiple unresolved tokens on one commit', () => {
    expect(text).toMatch(/PROJ-99/);
    expect(text).toMatch(/OTHER-7/);
  });
  it('groups unresolved references by repository', () => {
    const unresolvedSection = text.slice(text.indexOf('## Unresolved'));
    expect(unresolvedSection).toMatch(/^### backend$/m);
    expect(unresolvedSection).toMatch(/^### frontend$/m);
  });
  it('shows path scope when configured', () => {
    expect(text).toMatch(/packages\/api\/\*\*/);
  });
  it('escapes Markdown-special characters in subjects', () => {
    expect(text).toContain('\\|');
    expect(text).toContain('\\`backtick\\`');
    expect(text).toContain('\\<angle\\>');
    expect(text).toContain('\\&');
  });
  it('links items that have URLs', () => {
    expect(text).toMatch(/\[PROJ-10\]\(https:\/\/tracker\.example\.com\/PROJ-10\)/);
  });
  it('does not link items without URLs', () => {
    expect(text).toMatch(/\| PROJ-12 \|/);
    expect(text).not.toMatch(/\[PROJ-12\]\(/);
  });
  it('includes triage data in items table when notes supplied', () => {
    const triaged = renderReport(multiRepo, multiRepoNotes);
    expect(triaged).toMatch(/not-done: docs not ready yet/);
    expect(triaged).toMatch(/other-release: belongs to 1\.8/);
    expect(triaged).toMatch(/process-miss: dev forgot ticket/);
  });
  it('is deterministic', () => {
    expect(renderReport(multiRepo, multiRepoNotes)).toBe(renderReport(multiRepo, multiRepoNotes));
  });
});

describe('renderChangelog', () => {
  it('lists linked items by title', () => {
    expect(renderChangelog(verified)).toMatch(/Add the thing/);
  });
  it('does not silently omit unaccounted commits', () => {
    const text = renderChangelog(verified);
    expect(text).toMatch(/PROJ-9/);
    expect(text).toMatch(/cccccccc/);
  });
  it('reports the ignored count', () => {
    expect(renderChangelog(verified)).toMatch(/1 commit/);
  });
  it('shows tracker status for items without commits', () => {
    expect(renderChangelog(verified)).toMatch(/\[in-progress\]/);
  });
  it('carries note classifications through', () => {
    expect(renderChangelog(verified, notes)).toMatch(/other-release/);
  });
  it('records the fingerprint for traceability', () => {
    expect(renderChangelog(verified)).toMatch(/sha256:0{64}/);
  });
});

describe('renderReleaseNotes', () => {
  it('renders a heading with the changeset id', () => {
    expect(renderReleaseNotes(verified)).toMatch(/release 1\.4\.0/);
  });
  it('lists verified items by title', () => {
    expect(renderReleaseNotes(verified)).toMatch(/Add the thing/);
  });
  it('lists orphan items with status', () => {
    const text = renderReleaseNotes(verified);
    expect(text).toMatch(/claimed but not in git/);
    expect(text).toMatch(/Claimed but absent/);
    expect(text).toMatch(/\[in-progress\]/);
  });
  it('summarises the reconciliation counts', () => {
    expect(renderReleaseNotes(verified)).toMatch(/1\/2/);
  });
  it('is deterministic', () => {
    expect(renderReleaseNotes(verified)).toBe(renderReleaseNotes(verified));
  });
});

describe('empty status', () => {
  const emptyStatusVerified: VerifiedChangeset = {
    ...verified,
    changeset: {
      ...verified.changeset,
      items: verified.changeset.items.map((i) =>
        i.id === 'PROJ-2' ? { ...i, status: '' } : i
      )
    },
    items: verified.items.map((i) =>
      i.id === 'PROJ-2' ? { ...i, status: '' } : i
    )
  };

  it('report does not show an empty status column value', () => {
    const text = renderReport(emptyStatusVerified);
    const itemsSection = text.slice(text.indexOf('## Claimed Items'));
    const proj2Line = itemsSection.split('\n').find((l) => l.includes('PROJ-2'));
    expect(proj2Line).toBeDefined();
    expect(proj2Line).not.toMatch(/\| \|/);
  });

  it('changelog omits bracketed status when empty', () => {
    const text = renderChangelog(emptyStatusVerified);
    expect(text).toMatch(/PROJ-2\*\* Claimed but absent(?! \[)/);
    expect(text).not.toMatch(/\[\]/);
  });

  it('release notes omits bracketed status when empty', () => {
    const text = renderReleaseNotes(emptyStatusVerified);
    expect(text).toMatch(/Claimed but absent/);
    expect(text).not.toMatch(/\[\]/);
  });
});

describe('untriaged output', () => {
  it('each renderer says so when given no notes', () => {
    for (const text of [renderReport(verified), renderChangelog(verified), renderReleaseNotes(verified)]) {
      expect(text.toLowerCase()).toMatch(/untriaged/);
    }
  });

  it('and stops saying so once notes are supplied', () => {
    for (const text of [renderReport(verified, notes), renderChangelog(verified, notes), renderReleaseNotes(verified, notes)]) {
      expect(text.toLowerCase()).not.toMatch(/untriaged/);
    }
  });
});

describe('golden files', () => {
  it('report matches byte for byte', () => {
    expect(renderReport(verified, notes)).toBe(golden('report'));
  });

  it('untriaged report matches byte for byte', () => {
    expect(renderReport(verified)).toBe(golden('report-untriaged'));
  });

  it('multi-repo report matches byte for byte', () => {
    expect(renderReport(multiRepo, multiRepoNotes)).toBe(golden('report-multi-repo'));
  });

  it('multi-repo untriaged report matches byte for byte', () => {
    expect(renderReport(multiRepo)).toBe(golden('report-multi-repo-untriaged'));
  });

  it('changelog matches byte for byte', () => {
    expect(renderChangelog(verified, notes)).toBe(golden('changelog'));
  });

  it('release notes match byte for byte', () => {
    expect(renderReleaseNotes(verified, notes)).toBe(golden('release-notes'));
  });
});
