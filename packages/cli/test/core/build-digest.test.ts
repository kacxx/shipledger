import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeBuildDigest, DIGEST_MANIFEST_VERSION, DIGEST_ALGORITHM } from '../../src/core/build-digest.js';

const roots: string[] = [];

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shipledger-digest-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('computeBuildDigest (manifest v1)', () => {
  const base = {
    'dist/cli/index.js': 'console.log(1);\n',
    'dist/core/x.js': 'export const x = 1;\n',
    'schemas/changeset.schema.json': '{"a":1}\n',
  };

  it('returns a prefixed sha256 digest and the manifest metadata', () => {
    const d = computeBuildDigest(makeRoot(base));
    expect(d.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.algorithm).toBe(DIGEST_ALGORITHM);
    expect(d.digestManifestVersion).toBe(DIGEST_MANIFEST_VERSION);
    expect(d.fileCount).toBe(3);
  });

  it('is identical across two roots with byte-identical files (path-insensitive)', () => {
    expect(computeBuildDigest(makeRoot(base)).digest).toBe(computeBuildDigest(makeRoot(base)).digest);
  });

  it('changes when runtime content changes', () => {
    const a = computeBuildDigest(makeRoot(base)).digest;
    const b = computeBuildDigest(makeRoot({ ...base, 'dist/core/x.js': 'export const x = 2;\n' })).digest;
    expect(a).not.toBe(b);
  });

  it('excludes non-runtime material: docs/, build-info.json, package.json, node_modules/', () => {
    const bare = computeBuildDigest(makeRoot(base)).digest;
    const noisy = computeBuildDigest(makeRoot({
      ...base,
      'docs/readme.md': '# docs\n',
      'build-info.json': '{"commit":"' + 'a'.repeat(40) + '"}\n',
      'package.json': '{"name":"shipledger","dependencies":{"ajv":"^8.17.1"}}\n',
      'node_modules/ajv/index.js': 'module.exports = {};\n',
    })).digest;
    expect(noisy).toBe(bare);
  });

  it('is insensitive to embedded-commit metadata (digest is not the commit)', () => {
    const c1 = computeBuildDigest(makeRoot({ ...base, 'build-info.json': '{"commit":"' + 'a'.repeat(40) + '"}' })).digest;
    const c2 = computeBuildDigest(makeRoot({ ...base, 'build-info.json': '{"commit":"' + 'b'.repeat(40) + '"}' })).digest;
    expect(c1).toBe(c2);
  });

  it('treats a missing schemas/ directory as an empty contribution', () => {
    const d = computeBuildDigest(makeRoot({ 'dist/cli/index.js': 'x\n' }));
    expect(d.fileCount).toBe(1);
    expect(d.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
