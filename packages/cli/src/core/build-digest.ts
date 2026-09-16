import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Canonical build-digest of the Shipledger CLI runtime.
 *
 * The digest is the AUTHORITATIVE identity of the bytes that make up the
 * installed CLI runtime. It is designed to be independently reproducible by a
 * consumer (e.g. Release Control) that resolves the same installed package, so
 * both sides can compute it and compare.
 *
 * Manifest v1 canonicalisation rules (versioned by {@link DIGEST_MANIFEST_VERSION}):
 *   - The file set is every regular file under `dist/` and `schemas/` — the
 *     compiled runtime code and the runtime schema data.
 *   - Each file contributes ONLY its package-relative POSIX path and a sha256
 *     over its raw bytes. Absolute paths never enter the digest.
 *   - No filesystem metadata (timestamps, mode, ownership) is hashed.
 *   - Mutable dependencies are excluded: `node_modules/`, `package.json`
 *     dependency ranges, and lockfiles are not part of the set.
 *   - Non-runtime material (docs/, build-info.json, package.json) is excluded,
 *     so the digest is a pure identity of the executable runtime, independent of
 *     source-traceability metadata such as the embedded commit.
 */
export const DIGEST_MANIFEST_VERSION = '1';
export const DIGEST_ALGORITHM = 'sha256';

const MANIFEST_V1_DIRS = ['dist', 'schemas'] as const;

export interface BuildDigest {
  readonly algorithm: typeof DIGEST_ALGORITHM;
  readonly digestManifestVersion: string;
  /** Prefixed hex digest, e.g. "sha256:abcd…". */
  readonly digest: string;
  /** Number of files that entered the digest (diagnostic; not part of the hash input). */
  readonly fileCount: number;
}

function walk(dir: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // A missing manifest directory contributes nothing (e.g. schemas/ absent).
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile()) acc.push(full);
  }
}

function toPosix(p: string): string {
  return p.split(/[\\/]+/).join('/');
}

/**
 * Compute the manifest-v1 build digest for an installed CLI package rooted at
 * {@link packageRoot}. Pure with respect to file *content*: two package trees
 * with byte-identical `dist/` and `schemas/` files produce the same digest
 * regardless of their absolute location, timestamps, or any other files
 * (node_modules/, docs/, build-info.json, package.json).
 */
export function computeBuildDigest(packageRoot: string): BuildDigest {
  const files: string[] = [];
  for (const dir of MANIFEST_V1_DIRS) walk(join(packageRoot, dir), files);

  const entries = files
    .map((abs): readonly [string, string] => {
      const rel = toPosix(relative(packageRoot, abs));
      const contentHash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      return [rel, contentHash];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonical = JSON.stringify(entries);
  const digest = `${DIGEST_ALGORITHM}:${createHash('sha256').update(canonical).digest('hex')}`;
  return {
    algorithm: DIGEST_ALGORITHM,
    digestManifestVersion: DIGEST_MANIFEST_VERSION,
    digest,
    fileCount: entries.length,
  };
}
