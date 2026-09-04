import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../../src/render/report.js';
import { renderChangelog } from '../../src/render/changelog.js';
import { renderReleaseNotes } from '../../src/render/release-notes.js';
import { validateVerified } from '../../src/config/validate.js';
import type { NotesFile } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const verified = validateVerified(
  JSON.parse(readFileSync(join(here, '..', 'fixtures', 'verified-example.json'), 'utf8'))
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

const golden = (name: string): string =>
  readFileSync(join(here, '__golden__', `${name}.txt`), 'utf8');

describe('renderReport', () => {
  const text = renderReport(verified);

  it('states the verdict', () => { expect(text).toMatch(/FAIL/); });
  it('names the unresolved token', () => { expect(text).toMatch(/PROJ-9/); });
  it('lists the unreferenced commit', () => { expect(text).toMatch(/cccccccc/); });
  it('lists the item with no commits, by title and status', () => {
    expect(text).toMatch(/Claimed but absent/);
    expect(text).toMatch(/\(in-progress\)/);
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

  it('changelog matches byte for byte', () => {
    expect(renderChangelog(verified, notes)).toBe(golden('changelog'));
  });

  it('release notes match byte for byte', () => {
    expect(renderReleaseNotes(verified, notes)).toBe(golden('release-notes'));
  });
});
