import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityReport, runIdentity } from '../../src/cli/identity.js';
import { computeBuildDigest } from '../../src/core/build-digest.js';

const roots: string[] = [];

function makeRoot(commitFile?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shipledger-identity-'));
  roots.push(root);
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli', 'index.js'), 'console.log(1);\n');
  mkdirSync(join(root, 'schemas'), { recursive: true });
  writeFileSync(join(root, 'schemas', 's.json'), '{"a":1}\n');
  if (commitFile !== undefined) writeFileSync(join(root, 'build-info.json'), commitFile);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('identityReport', () => {
  it('reports version, authoritative build digest, and file count', () => {
    const root = makeRoot(`{"commit":"${'a'.repeat(40)}"}`);
    const r = identityReport(root);
    expect(r.schemaVersion).toBe(1);
    expect(typeof r.cliVersion).toBe('string');
    expect(r.build.digest).toBe(computeBuildDigest(root).digest);
    expect(r.build.digestManifestVersion).toBe('1');
    expect(r.build.fileCount).toBe(2);
  });

  it('reads a valid 40-hex (SHA-1) embedded commit as source-traceability metadata', () => {
    const commit = 'a'.repeat(40);
    expect(identityReport(makeRoot(`{"commit":"${commit}"}`)).commit).toBe(commit);
  });

  it('reads a valid 64-hex (SHA-256) embedded commit', () => {
    // git object-format repos emit 64-hex OIDs; these must not be silently dropped.
    const commit = 'a'.repeat(64);
    expect(identityReport(makeRoot(`{"commit":"${commit}"}`)).commit).toBe(commit);
  });

  it('reports commit=null when build-info.json is absent', () => {
    expect(identityReport(makeRoot()).commit).toBeNull();
  });

  it('reports commit=null when build-info.json is malformed or not a valid OID length', () => {
    expect(identityReport(makeRoot('not json')).commit).toBeNull();
    expect(identityReport(makeRoot('{"commit":"nope"}')).commit).toBeNull();
    expect(identityReport(makeRoot('{"commit":null}')).commit).toBeNull();
    expect(identityReport(makeRoot(`{"commit":"${'a'.repeat(39)}"}`)).commit).toBeNull();
    expect(identityReport(makeRoot(`{"commit":"${'a'.repeat(50)}"}`)).commit).toBeNull();
  });

  it('runIdentity writes a single JSON line to stdout and returns 0', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    });
    const code = runIdentity([], makeRoot(`{"commit":"${'a'.repeat(40)}"}`));
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.build.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('runIdentity fails closed on a broken build: exit 3, controlled stderr, no stdout report', () => {
    const outs: string[] = [];
    const errs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { outs.push(c.toString()); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { errs.push(c.toString()); return true; });
    // A root with no dist/ bin entry cannot be measured into a trustworthy identity.
    const broken = mkdtempSync(join(tmpdir(), 'shipledger-identity-broken-'));
    roots.push(broken);
    const code = runIdentity([], broken);
    expect(code).toBe(3);
    expect(outs).toHaveLength(0);
    expect(errs.join('')).toMatch(/shipledger identity:/);
  });
});
