import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../../src/cli/init.js';
import { validateChangeset, validateConfig } from '../../src/config/validate.js';
import { mergeConfig } from '../../src/config/load.js';
import { assertChangesetAgainstConfig } from '../../src/config/changeset.js';

let work: string | undefined;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
  vi.restoreAllMocks();
});

function silence(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

describe('runInit', () => {
  it('writes a schema-valid config with a pinned default preset', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'shipledger.config.json');
    expect(runInit(['--out', out], work)).toBe(0);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(() => validateConfig(parsed)).not.toThrow();
    expect(parsed.preset).toBe('tracker-keys@1');
  });

  it('pins a bare preset name', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--preset', 'github-oss', '--out', out], work);
    expect(JSON.parse(readFileSync(out, 'utf8')).preset).toBe('github-oss@1');
  });

  it('accepts an already-pinned preset', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    expect(runInit(['--preset', 'github-oss@1', '--out', out], work)).toBe(0);
  });

  it('produces a config that loads without an unpinned-preset error', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--out', out], work);
    const raw = validateConfig(JSON.parse(readFileSync(out, 'utf8')));
    expect(() => mergeConfig(raw, work as string)).not.toThrow();
  });

  it('rejects an unknown preset with exit 2 and writes nothing', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    expect(runInit(['--preset', 'nope', '--out', out], work)).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to overwrite an existing file', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--out', out], work);
    const before = readFileSync(out, 'utf8');
    expect(runInit(['--out', out], work)).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it('exits 2 for an unknown flag', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    expect(runInit(['--wat'], work)).toBe(2);
  });

  it('omits policy so the pinned preset stays the single source of it', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--out', out], work);
    expect(JSON.parse(readFileSync(out, 'utf8')).policy).toBeUndefined();
  });

  it('also writes a schema-valid changeset example, so the quickstart can run', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    runInit(['--out', join(work, 'c.json')], work);
    const example = join(work, 'changeset.example.json');
    expect(existsSync(example)).toBe(true);
    expect(() => validateChangeset(JSON.parse(readFileSync(example, 'utf8')))).not.toThrow();
  });

  it('writes an example whose tokens and ranges match the config it wrote', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--preset', 'github-oss', '--out', out], work);
    const config = mergeConfig(validateConfig(JSON.parse(readFileSync(out, 'utf8'))), work);
    const changeset = validateChangeset(
      JSON.parse(readFileSync(join(work, 'changeset.example.json'), 'utf8'))
    );
    expect(() => assertChangesetAgainstConfig(changeset, config)).not.toThrow();
  });

  it('refuses to overwrite an existing changeset example', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    runInit(['--out', join(work, 'a.json')], work);
    expect(runInit(['--out', join(work, 'b.json')], work)).toBe(2);
    expect(existsSync(join(work, 'b.json'))).toBe(false);
  });
});
