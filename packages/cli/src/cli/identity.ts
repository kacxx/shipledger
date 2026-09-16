import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLI_VERSION } from './version.js';
import { computeBuildDigest, DIGEST_ALGORITHM, DIGEST_MANIFEST_VERSION } from '../core/build-digest.js';

// dist/cli/identity.js -> package root is two levels up (mirrors version.ts).
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface IdentityReport {
  readonly schemaVersion: 1;
  readonly cliVersion: string;
  /**
   * The commit embedded at build time from `git rev-parse HEAD`, or null when
   * the build had no git context. This is SOURCE-TRACEABILITY METADATA only: it
   * is self-reported by the build and is NOT independently verified. Consumers
   * must not treat it as verified provenance unless they check it against a
   * trusted source.
   */
  readonly commit: string | null;
  /**
   * The authoritative, independently reproducible identity of the runtime bytes.
   */
  readonly build: {
    readonly algorithm: string;
    readonly digestManifestVersion: string;
    readonly digest: string;
    readonly fileCount: number;
  };
}

function readBuildCommit(root: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8'));
    const commit = (raw as { commit?: unknown }).commit;
    return typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export function identityReport(packageRoot: string = PACKAGE_ROOT): IdentityReport {
  const bd = computeBuildDigest(packageRoot);
  return {
    schemaVersion: 1,
    cliVersion: CLI_VERSION,
    commit: readBuildCommit(packageRoot),
    build: {
      algorithm: bd.algorithm,
      digestManifestVersion: bd.digestManifestVersion,
      digest: bd.digest,
      fileCount: bd.fileCount,
    },
  };
}

export function runIdentity(_argv: string[]): number {
  process.stdout.write(`${JSON.stringify(identityReport())}\n`);
  return 0;
}

// Re-exported so callers/tests can assert the manifest identity used here.
export { DIGEST_ALGORITHM, DIGEST_MANIFEST_VERSION };
