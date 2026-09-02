import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runRender } from '../../src/cli/render.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'verified-example.json');
let work: string | undefined;

afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
  vi.restoreAllMocks();
});

function capture(): { text: () => string } {
  let buf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { buf += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { buf += String(c); return true; });
  return { text: () => buf };
}

describe('runRender', () => {
  it('renders every format and exits 0', () => {
    for (const format of ['report', 'changelog', 'release-notes']) {
      const out = capture();
      expect(runRender([format, '--input', fixture], process.cwd())).toBe(0);
      expect(out.text().length).toBeGreaterThan(0);
      vi.restoreAllMocks();
    }
  });

  it('exits 2 for an unknown format', () => {
    capture();
    expect(runRender(['pretty', '--input', fixture], process.cwd())).toBe(2);
  });

  it('exits 3 when the input is missing', () => {
    capture();
    expect(runRender(['report', '--input', '/nonexistent.json'], process.cwd())).toBe(3);
  });

  it('exits 2 when the input is not a valid verified changeset', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const bad = join(work, 'bad.json');
    writeFileSync(bad, JSON.stringify({ version: 1 }));
    capture();
    expect(runRender(['report', '--input', bad], process.cwd())).toBe(2);
  });

  it('exits 2 when the artifact is schema-valid but internally inconsistent', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const tampered = JSON.parse(readFileSync(fixture, 'utf8'));
    tampered.summary.noReference = 99;
    const path = join(work, 'tampered.json');
    writeFileSync(path, JSON.stringify(tampered));
    const out = capture();
    expect(runRender(['report', '--input', path], process.cwd())).toBe(2);
    expect(out.text()).toMatch(/summary/);
  });

  it('exits 2 when notes name a finding the artifact does not contain', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const notes = join(work, 'notes.json');
    writeFileSync(notes, JSON.stringify({
      version: 1, items: [{ item: 'PROJ-1', classification: 'not-done', note: 'wrong target' }]
    }));
    capture();
    expect(runRender(['report', '--input', fixture, '--notes', notes], process.cwd())).toBe(2);
  });

  it('exits 2 when notes are supplied but incomplete', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const notes = join(work, 'notes.json');
    writeFileSync(notes, JSON.stringify({
      version: 1, items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }]
    }));
    const out = capture();
    expect(runRender(['report', '--input', fixture, '--notes', notes], process.cwd())).toBe(2);
    expect(out.text()).toMatch(/missing/i);
    expect(out.text()).toMatch(/Omit --notes/);
  });

  it('accepts a complete triage and includes it in output', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const notes = join(work, 'notes.json');
    writeFileSync(notes, JSON.stringify({
      version: 1,
      noReference: [{ repo: 'repo-a', sha: 'c'.repeat(40), classification: 'tooling-or-ci', note: 'lint config only' }],
      unknownReference: [{ repo: 'repo-a', sha: 'b'.repeat(40), matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
      items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
      ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
    }));
    const out = capture();
    expect(runRender(['report', '--input', fixture, '--notes', notes], process.cwd())).toBe(0);
    expect(out.text()).toMatch(/moved out of scope/);
    expect(out.text().toLowerCase()).not.toMatch(/untriaged/);
  });

  it('marks output untriaged when --notes is omitted, without failing', () => {
    const out = capture();
    expect(runRender(['report', '--input', fixture], process.cwd())).toBe(0);
    expect(out.text().toLowerCase()).toMatch(/untriaged/);
  });

  it('reads the committed fixture unchanged', () => {
    expect(JSON.parse(readFileSync(fixture, 'utf8')).verdict).toBe('fail');
  });
});
