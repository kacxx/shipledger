import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Canonical build-digest of the published Shipledger CLI package.
 *
 * The digest is the AUTHORITATIVE identity of the immutable published build
 * content — the bytes npm publishes under `dist/` and `schemas/`. That includes
 * the executable JavaScript AND the emitted TypeScript declarations (`*.d.ts`)
 * and runtime schema data: the whole published surface, not only the code that
 * happens to execute. It is designed to be independently reproducible by a
 * consumer (e.g. Release Control) that resolves the same installed package, so
 * both sides can compute it and compare.
 *
 * Manifest v1 canonicalisation rules (versioned by {@link DIGEST_MANIFEST_VERSION}).
 * These are defined language-neutrally so a non-JS consumer can reproduce them
 * byte-for-byte (see docs/identity.md and the shared test vectors in
 * test/fixtures/manifest-v1-digest-vectors.json):
 *   - The file set is every regular file under `dist/` and `schemas/`.
 *   - Each file contributes a pair `[packageRelativePosixPath, sha256hex(rawBytes)]`.
 *     The content hash is sha256 over the file's RAW BYTES (never a text decode),
 *     lower-case hex. Absolute paths never enter the digest.
 *   - No filesystem metadata (timestamps, mode, ownership) is hashed.
 *   - The pairs are ordered by the UTF-8 byte sequence of the path (equivalently,
 *     Unicode code-point order — NOT JavaScript UTF-16 code-unit order).
 *   - The ordered array of pairs is serialised with RFC 8785 (JSON Canonicalisation
 *     Scheme). For this all-string data that is identical to compact JSON.
 *   - digest = "sha256:" + sha256hex(utf8Bytes(serialisation)).
 *   - Mutable / non-published material is excluded by construction: `node_modules/`,
 *     `package.json` (and its dependency ranges), lockfiles, `docs/`, and
 *     `build-info.json` (the embedded commit is source-traceability metadata, not
 *     part of the build identity).
 *
 * Fail-closed: a build missing its `dist/` tree or the published bin entry, or an
 * empty file set, is NOT assigned a meaningful-looking digest — {@link computeBuildDigest}
 * throws {@link BuildDigestError} rather than returning the fixed digest of an
 * empty manifest. Symlinks inside the measured tree are rejected (a content
 * identity must be the real bytes, not a pointer that can escape the package).
 */
export const DIGEST_MANIFEST_VERSION = '1';
export const DIGEST_ALGORITHM = 'sha256';

const MANIFEST_V1_DIRS = ['dist', 'schemas'] as const;

/**
 * The published bin entry point, package-relative POSIX. Mirrors the `bin`
 * field in package.json; a build that does not contain this file is broken and
 * must not report an identity. (A test asserts this stays in sync with package.json.)
 */
export const REQUIRED_ENTRY = 'dist/cli/index.js';

/** Raised when a package tree cannot be measured into a trustworthy identity. */
export class BuildDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildDigestError';
  }
}

export interface BuildDigest {
  readonly algorithm: typeof DIGEST_ALGORITHM;
  readonly digestManifestVersion: string;
  /** Prefixed hex digest, e.g. "sha256:abcd…". */
  readonly digest: string;
  /** Number of files that entered the digest (diagnostic; not part of the hash input). */
  readonly fileCount: number;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function walk(dir: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    // A wholly absent manifest directory contributes nothing (e.g. schemas/
    // omitted). Any other failure (permissions, a mid-measurement race) is a
    // controlled error, never a silently short digest.
    if (errCode(err) === 'ENOENT') return;
    throw new BuildDigestError(`Cannot read build directory ${dir}: ${String(err)}`);
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      // lstat, NOT stat: never follow symlinks. A content identity must be the
      // package's own bytes; a symlink can point at non-package files or an
      // ancestor (unbounded recursion / root escape).
      st = lstatSync(full);
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        // The entry was removed between readdir and lstat — a filesystem race.
        // Fail closed rather than silently drop it from the identity.
        throw new BuildDigestError(`Build file vanished during measurement: ${full}`);
      }
      throw new BuildDigestError(`Cannot stat build file ${full}: ${String(err)}`);
    }
    if (st.isSymbolicLink()) {
      throw new BuildDigestError(
        `Refusing to measure a symlink in the build tree: ${full}. ` +
          'The build identity must be the package\'s own bytes.',
      );
    }
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile()) acc.push(full);
    // Non-regular files (sockets, fifos, devices) never appear in a published
    // npm tree and are ignored.
  }
}

function toPosix(p: string): string {
  return p.split(/[\\/]+/).join('/');
}

/**
 * RFC 8785 (JCS) serialisation of a JSON string value. Implemented explicitly
 * (rather than delegating to `JSON.stringify`) so the canonical form is defined
 * by a language-neutral rule a non-JS consumer can reproduce. For any
 * well-formed string this is byte-identical to `JSON.stringify` (a fuzz test
 * asserts that). Paths and hex hashes are always well-formed.
 */
function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x08: out += '\\b'; break;
      case 0x09: out += '\\t'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0d: out += '\\r'; break;
      default:
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
        else out += s[i]; // emit the code unit verbatim; UTF-8 encoding happens below
    }
  }
  return out + '"';
}

/** Compare two paths by their UTF-8 byte sequence (== Unicode code-point order). */
export function compareByUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Manifest-v1 canonical digest over an already-content-hashed entry set. Pure:
 * no filesystem access. This is the exact function the shared cross-implementation
 * test vectors exercise. Callers pass `[packageRelativePosixPath, sha256HexOfContent]`
 * pairs; ordering of the input does not matter (this function sorts).
 */
export function manifestV1Digest(entries: ReadonlyArray<readonly [string, string]>): string {
  const sorted = [...entries].sort((a, b) => compareByUtf8Bytes(a[0], b[0]));
  const canonical = `[${sorted.map(([p, h]) => `[${jcsString(p)},${jcsString(h)}]`).join(',')}]`;
  const hex = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  return `${DIGEST_ALGORITHM}:${hex}`;
}

/**
 * Compute the manifest-v1 build digest for an installed CLI package rooted at
 * {@link packageRoot}. Pure with respect to file *content*: two package trees
 * with byte-identical `dist/` and `schemas/` files produce the same digest
 * regardless of their absolute location, timestamps, or any other files
 * (node_modules/, docs/, build-info.json, package.json).
 *
 * @throws {BuildDigestError} if the required bin entry is absent or the measured
 *   file set is empty (a broken/empty build must not report a valid-looking
 *   identity), or if a filesystem race or a symlink is encountered.
 */
export function computeBuildDigest(packageRoot: string): BuildDigest {
  const files: string[] = [];
  for (const dir of MANIFEST_V1_DIRS) walk(join(packageRoot, dir), files);

  const entries = files.map((abs): readonly [string, string] => {
    const rel = toPosix(relative(packageRoot, abs));
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        throw new BuildDigestError(`Build file vanished during measurement: ${abs}`);
      }
      throw new BuildDigestError(`Cannot read build file ${abs}: ${String(err)}`);
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    return [rel, contentHash];
  });

  if (entries.length === 0) {
    throw new BuildDigestError(
      `Empty build: no files under ${MANIFEST_V1_DIRS.map((d) => `${d}/`).join(' or ')} in ${packageRoot}. ` +
        'A missing or unbuilt package must not report a build identity.',
    );
  }
  if (!entries.some(([rel]) => rel === REQUIRED_ENTRY)) {
    throw new BuildDigestError(
      `Broken build: required bin entry "${REQUIRED_ENTRY}" is missing from ${packageRoot}. ` +
        'Refusing to report an identity for a package that cannot run.',
    );
  }

  return {
    algorithm: DIGEST_ALGORITHM,
    digestManifestVersion: DIGEST_MANIFEST_VERSION,
    digest: manifestV1Digest(entries),
    fileCount: entries.length,
  };
}
