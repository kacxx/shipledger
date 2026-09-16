import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  computeBuildDigest,
  manifestV1Digest,
  compareByUtf8Bytes,
  BuildDigestError,
  REQUIRED_ENTRY,
  DIGEST_MANIFEST_VERSION,
  DIGEST_ALGORITHM,
} from '../../src/core/build-digest.js';

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

  describe('fails closed on a broken build', () => {
    it('throws when there are no files at all (no dist/, no schemas/)', () => {
      expect(() => computeBuildDigest(makeRoot({}))).toThrow(BuildDigestError);
    });

    it('throws when dist/ exists but the required bin entry is absent', () => {
      // A non-empty but entry-less dist/ must not produce a valid-looking identity.
      expect(() => computeBuildDigest(makeRoot({ 'dist/core/x.js': 'x\n', 'schemas/s.json': '{}\n' })))
        .toThrow(/required bin entry/);
    });

    it('does not return the fixed empty-manifest digest for an empty build', () => {
      // Regression: an empty file set previously hashed "[]" to a constant digest.
      let threw = false;
      try { computeBuildDigest(makeRoot({})); } catch { threw = true; }
      expect(threw).toBe(true);
    });

    it('rejects a symlink inside the measured tree instead of following it', () => {
      const root = makeRoot(base);
      symlinkSync(join(root, 'dist', 'cli', 'index.js'), join(root, 'dist', 'link.js'));
      expect(() => computeBuildDigest(root)).toThrow(/symlink/);
    });

    it('rejects a symlinked directory (no escape / unbounded recursion)', () => {
      const root = makeRoot(base);
      symlinkSync(root, join(root, 'dist', 'loop'));
      expect(() => computeBuildDigest(root)).toThrow(BuildDigestError);
    });
  });

  it('keeps REQUIRED_ENTRY in sync with the package.json bin', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: { shipledger: string } }).bin.shipledger;
    expect(bin).toBe(`./${REQUIRED_ENTRY}`);
  });
});

describe('manifestV1Digest canonicalisation', () => {
  const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

  it('is independent of input order (sorts internally)', () => {
    const forwards = manifestV1Digest([['dist/cli/index.js', A], ['dist/core/x.js', B], ['schemas/s.json', C]]);
    const shuffled = manifestV1Digest([['schemas/s.json', C], ['dist/cli/index.js', A], ['dist/core/x.js', B]]);
    expect(forwards).toBe(shuffled);
  });

  it('orders paths by UTF-8 bytes, not UTF-16 code units', () => {
    // U+FFFD (BMP) sorts before U+10000 (astral) by UTF-8 bytes; JS `<` would swap them.
    expect(compareByUtf8Bytes('�', '\u{10000}')).toBeLessThan(0);
    expect('�' < '\u{10000}').toBe(false); // JS UTF-16 order disagrees
  });

  it('serialises exactly like RFC-8785-equivalent compact JSON for well-formed strings', () => {
    // Property check: the explicit JCS serialiser must equal JSON.stringify of the
    // UTF-8-sorted array for a battery of well-formed strings (incl. control chars,
    // quotes, backslashes, unicode, emoji).
    const samples: (readonly [string, string])[] = [
      ['plain.js', A],
      ['with"quote.js', B],
      ['back\\slash.js', C],
      ['tab\tnewline\n.js', A],
      ['ctrl.js', B],
      ['unicode-ä-é.js', C],
      ['emoji-\u{1F600}.js', A],
      ['bmp-�.js', B],
    ];
    const sorted = [...samples].sort((a, b) => compareByUtf8Bytes(a[0], b[0]));
    const expected = `sha256:${createHash('sha256').update(Buffer.from(JSON.stringify(sorted), 'utf8')).digest('hex')}`;
    expect(manifestV1Digest(samples)).toBe(expected);
  });
});
