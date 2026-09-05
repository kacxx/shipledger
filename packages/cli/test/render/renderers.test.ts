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
});

describe('renderReport token and commit counts', () => {
  it('reports commits with unresolved refs, reference count, and no-reference count', () => {
    const text = renderReport(verified);
    expect(text).toMatch(/1 commit\(s\) with 1 unresolved reference\(s\)/);
    expect(text).toMatch(/1 commit\(s\) with no reference/);
  });

  it('reports distinct commit and reference counts for multi-repo', () => {
    const text = renderReport(multiRepo);
    expect(text).toMatch(/1 commit\(s\) with 2 unresolved reference\(s\)/);
    expect(text).toMatch(/2 commit\(s\) with no reference/);
  });
});

describe('renderReport triage coverage', () => {
  it('shows UNTRIAGED with 0/N when no notes', () => {
    const text = renderReport(verified);
    expect(text).toMatch(/UNTRIAGED — 0\/4 findings covered/);
  });

  it('shows COMPLETE with N/N when notes are supplied', () => {
    const text = renderReport(verified, notes);
    expect(text).toMatch(/COMPLETE — 4\/4 findings covered/);
  });

  it('always includes the Triage row', () => {
    expect(renderReport(verified)).toMatch(/^\| Triage \|/m);
    expect(renderReport(verified, notes)).toMatch(/^\| Triage \|/m);
  });

  it('counts individual unknown-reference tuples for multi-repo', () => {
    const text = renderReport(multiRepo);
    expect(text).toMatch(/UNTRIAGED — 0\/6 findings covered/);
  });

  it('shows COMPLETE for multi-repo with notes', () => {
    const text = renderReport(multiRepo, multiRepoNotes);
    expect(text).toMatch(/COMPLETE — 6\/6 findings covered/);
  });
});

describe('renderReport URL safety', () => {
  function withUrl(url: string): VerifiedChangeset {
    return {
      ...verified,
      changeset: {
        ...verified.changeset,
        items: verified.changeset.items.map((i) =>
          i.id === 'PROJ-1' ? { ...i, url } : i
        )
      }
    };
  }

  it('links a valid https URL', () => {
    const text = renderReport(withUrl('https://tracker.example.com/PROJ-1'));
    expect(text).toMatch(/\[PROJ-1\]\(https:\/\/tracker\.example\.com\/PROJ-1\)/);
  });

  it('links a valid http URL', () => {
    const text = renderReport(withUrl('http://tracker.example.com/PROJ-1'));
    expect(text).toMatch(/\[PROJ-1\]\(http:\/\/tracker\.example\.com\/PROJ-1\)/);
  });

  it('rejects javascript: protocol', () => {
    const text = renderReport(withUrl('javascript:alert(1)'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
    expect(text).toContain('PROJ-1');
  });

  it('rejects data: protocol', () => {
    const text = renderReport(withUrl('data:text/html,<h1>hi</h1>'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });

  it('rejects a malformed URL', () => {
    const text = renderReport(withUrl('not a url at all'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });

  it('rejects credential-bearing URLs', () => {
    const text = renderReport(withUrl('https://user:pass@tracker.example.com/PROJ-1'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });

  it('encodes parentheses in URLs', () => {
    const text = renderReport(withUrl('https://tracker.example.com/item(1)'));
    expect(text).toContain('https://tracker.example.com/item%281%29');
  });

  it('encodes angle brackets in URLs', () => {
    const text = renderReport(withUrl('https://tracker.example.com/<id>'));
    expect(text).toContain('https://tracker.example.com/%3Cid%3E');
  });

  it('encodes spaces in URLs', () => {
    const text = renderReport(withUrl('https://tracker.example.com/my item'));
    expect(text).toContain('https://tracker.example.com/my%20item');
  });

  it('rejects URLs with newlines', () => {
    const text = renderReport(withUrl('https://tracker.example.com/a\nb'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });

  it('rejects URLs with tab characters', () => {
    const text = renderReport(withUrl('https://tracker.example.com/a\tb'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });

  it('rejects URLs with null bytes', () => {
    const text = renderReport(withUrl('https://tracker.example.com/a\x00b'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });

  it('normalizes backslash in path via canonical URL', () => {
    const text = renderReport(withUrl('https://tracker.example.com/a\\b'));
    expect(text).toContain('https://tracker.example.com/a/b');
  });

  it('encodes double quotes via canonical URL', () => {
    const text = renderReport(withUrl('https://tracker.example.com/a"b'));
    expect(text).toContain('https://tracker.example.com/a%22b');
  });

  it('rejects URLs with other ASCII control characters', () => {
    const text = renderReport(withUrl('https://tracker.example.com/a\x1fb'));
    expect(text).not.toMatch(/\[PROJ-1\]\(/);
  });
});

describe('renderReport unresolved table format', () => {
  it('renders unresolved references as a table', () => {
    const text = renderReport(verified, notes);
    expect(text).toMatch(/^\| Commit \| Reference \| Seen in \| Classification \| Operator note \|/m);
    expect(text).toMatch(/^\| --- \| --- \| --- \| --- \| --- \|/m);
  });

  it('shows classification and note in separate columns', () => {
    const text = renderReport(verified, notes);
    const unresolvedSection = text.slice(text.indexOf('## Unresolved'));
    expect(unresolvedSection).toMatch(/\| other-release \| shipped in 1\.3 \|/);
    expect(unresolvedSection).toMatch(/\| tooling-or-ci \| lint config only \|/);
  });

  it('shows dashes for untriaged entries', () => {
    const text = renderReport(verified);
    const unresolvedSection = text.slice(text.indexOf('## Unresolved'));
    expect(unresolvedSection).toMatch(/\| — \| — \|$/m);
  });

  it('shows no-reference commits in the table with a dash for Reference', () => {
    const text = renderReport(verified);
    const unresolvedSection = text.slice(text.indexOf('## Unresolved'));
    expect(unresolvedSection).toMatch(/cccccccc.*\| — \| — \|/);
  });
});

describe('renderReport path evidence', () => {
  it('preserves backticks in path scope using variable-length code-span delimiters', () => {
    const withBacktickPath: VerifiedChangeset = {
      ...verified,
      ranges: verified.ranges.map((r) => ({
        ...r,
        include: ['src/`special`/**']
      }))
    };
    const text = renderReport(withBacktickPath);
    expect(text).toContain('`` src/`special`/** ``');
    expect(text).not.toContain("'special'");
  });

  it('uses single-backtick delimiters when path has no backticks', () => {
    const text = renderReport(multiRepo);
    expect(text).toContain('`packages/api/**`');
  });
});

describe('renderReport multiline safety', () => {
  function withSubject(subject: string): VerifiedChangeset {
    return {
      ...verified,
      commits: verified.commits.map((c) =>
        c.sha.startsWith('cccc') ? { ...c, subject } : c
      )
    };
  }

  it('replaces newlines in commit subjects so they cannot break table rows', () => {
    const text = renderReport(withSubject('line one\nline two'));
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('|') && line.includes('cccccccc')) {
        expect(line).not.toContain('\n');
        expect(line).toContain('line one line two');
      }
    }
  });

  it('replaces pipes in untrusted values so they cannot break table columns', () => {
    const text = renderReport(withSubject('a | b'));
    expect(text).toContain('a \\| b');
  });

  it('escapes backticks in subjects to prevent breaking inline code', () => {
    const text = renderReport(withSubject('foo `bar` baz'));
    expect(text).toContain('foo \\`bar\\` baz');
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

describe('renderReport configured links', () => {
  const text = renderReport(multiRepo, multiRepoNotes);

  it('links commit SHAs when commit template exists', () => {
    expect(text).toMatch(/\[`aa000001`\]\(https:\/\/github\.com\/example\/backend\/commit\/aa00000100000000000000000000000000000000\)/);
  });

  it('links commit SHAs for the frontend repo with its own template', () => {
    expect(text).toMatch(/\[`ff000001`\]\(https:\/\/github\.com\/example\/frontend\/commit\/ff00000100000000000000000000000000000000\)/);
  });

  it('links unresolved reference tokens when reference template exists', () => {
    expect(text).toMatch(/\[PROJ-99\]\(https:\/\/tracker\.example\.com\/browse\/PROJ-99\)/);
  });

  it('links OTHER-7 reference token', () => {
    expect(text).toMatch(/\[OTHER-7\]\(https:\/\/tracker\.example\.com\/browse\/OTHER-7\)/);
  });

  it('links commit SHAs in items table', () => {
    expect(text).toMatch(/\[`aa000001`\]\(https:\/\/github\.com\/example\/backend\/commit\/aa00000100000000000000000000000000000000\) \(backend\)/);
  });

  it('links commit SHAs in the unresolved table', () => {
    const unresolvedSection = text.slice(text.indexOf('## Unresolved'));
    expect(unresolvedSection).toMatch(/\[`aa000003`\]\(https:\/\/github\.com\/example\/backend\/commit\/aa00000300000000000000000000000000000000\)/);
  });

  it('links reference tokens in the unresolved table', () => {
    const unresolvedSection = text.slice(text.indexOf('## Unresolved'));
    expect(unresolvedSection).toMatch(/\[PROJ-99\]\(https:\/\/tracker\.example\.com\/browse\/PROJ-99\) \(ticket-key\)/);
  });

  it('still links item IDs from changeset item URLs', () => {
    expect(text).toMatch(/\[PROJ-10\]\(https:\/\/tracker\.example\.com\/PROJ-10\)/);
  });
});

describe('renderReport missing link metadata', () => {
  it('renders plain SHAs when links is absent', () => {
    const text = renderReport(verified);
    expect(text).toMatch(/`bbbbbbbb`/);
    expect(text).not.toMatch(/\[`bbbbbbbb`\]\(/);
  });

  it('renders plain SHAs when repo is missing from links', () => {
    const partial: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { 'other-repo': { commit: 'https://example.com/{sha}' } } }
      }
    };
    const text = renderReport(partial);
    expect(text).toMatch(/`aa000001`/);
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });

  it('renders plain SHAs when commit template is missing', () => {
    const partial: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { references: { 'ticket-key': 'https://tracker.example.com/{token}' } } } }
      }
    };
    const text = renderReport(partial);
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });

  it('renders plain reference tokens when reference template is missing', () => {
    const partial: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { commit: 'https://example.com/{sha}' } } }
      }
    };
    const text = renderReport(partial);
    expect(text).toContain('PROJ-99');
    expect(text).not.toMatch(/\[PROJ-99\]\(/);
  });
});

describe('renderReport unsafe protocol templates', () => {
  function withCommitTemplate(template: string): VerifiedChangeset {
    return {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { commit: template } } }
      }
    };
  }

  function withRefTemplate(template: string): VerifiedChangeset {
    return {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { references: { 'ticket-key': template } } } }
      }
    };
  }

  it('rejects javascript: commit template', () => {
    const text = renderReport(withCommitTemplate('javascript:alert({sha})'));
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });

  it('rejects data: commit template', () => {
    const text = renderReport(withCommitTemplate('data:text/html,{sha}'));
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });

  it('rejects ftp: commit template', () => {
    const text = renderReport(withCommitTemplate('ftp://example.com/{sha}'));
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });

  it('rejects javascript: reference template', () => {
    const text = renderReport(withRefTemplate('javascript:alert({token})'));
    expect(text).not.toMatch(/\[PROJ-99\]\(/);
  });

  it('rejects credential-bearing commit template', () => {
    const text = renderReport(withCommitTemplate('https://user:pass@example.com/{sha}'));
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });
});

describe('renderReport malformed templates', () => {
  it('falls back to plain text when template has no placeholder', () => {
    const v: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { commit: 'https://example.com/commits' } } }
      }
    };
    const text = renderReport(v);
    expect(text).toMatch(/\[`aa000001`\]\(https:\/\/example\.com\/commits\)/);
  });

  it('falls back to plain text when template is not a valid URL', () => {
    const v: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { commit: 'not a url {sha}' } } }
      }
    };
    const text = renderReport(v);
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });

  it('falls back when template has unknown placeholder', () => {
    const v: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { commit: 'https://example.com/{unknown}' } } }
      }
    };
    const text = renderReport(v);
    expect(text).not.toMatch(/\[`aa000001`\]\(/);
  });
});

describe('renderReport special characters in tokens', () => {
  it('URL-encodes tokens with spaces', () => {
    const v: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { references: { 'ticket-key': 'https://tracker.example.com/browse/{token}' } } } }
      },
      commits: multiRepo.commits.map((c) =>
        c.sha === 'aa00000300000000000000000000000000000000'
          ? { ...c, references: [{ matcher: 'ticket-key', token: 'PROJ 99', namespace: 'global' as const, sources: ['subject' as const], resolvesTo: [] }] }
          : c
      )
    };
    const text = renderReport(v);
    expect(text).toContain('https://tracker.example.com/browse/PROJ%2099');
  });

  it('URL-encodes tokens with special characters', () => {
    const v: VerifiedChangeset = {
      ...multiRepo,
      changeset: {
        ...multiRepo.changeset,
        links: { repos: { backend: { references: { 'ticket-key': 'https://tracker.example.com/browse/{token}' } } } }
      },
      commits: multiRepo.commits.map((c) =>
        c.sha === 'aa00000300000000000000000000000000000000'
          ? { ...c, references: [{ matcher: 'ticket-key', token: 'TEST/&=?', namespace: 'global' as const, sources: ['subject' as const], resolvesTo: [] }] }
          : c
      )
    };
    const text = renderReport(v);
    expect(text).toContain('https://tracker.example.com/browse/TEST%2F%26%3D%3F');
  });
});

describe('renderReport multi-repo link scoping', () => {
  it('uses different commit templates per repo', () => {
    const text = renderReport(multiRepo, multiRepoNotes);
    expect(text).toContain('https://github.com/example/backend/commit/aa000001');
    expect(text).toContain('https://github.com/example/frontend/commit/ff000001');
    expect(text).not.toContain('https://github.com/example/backend/commit/ff000001');
    expect(text).not.toContain('https://github.com/example/frontend/commit/aa000001');
  });
});

describe('renderReport determinism with links', () => {
  it('produces byte-identical output across runs', () => {
    const a = renderReport(multiRepo, multiRepoNotes);
    const b = renderReport(multiRepo, multiRepoNotes);
    expect(a).toBe(b);
  });

  it('produces byte-identical output without links', () => {
    const a = renderReport(verified, notes);
    const b = renderReport(verified, notes);
    expect(a).toBe(b);
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
