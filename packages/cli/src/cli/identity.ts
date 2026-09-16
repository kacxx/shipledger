import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_VERSION } from './version.js';
import { PACKAGE_ROOT } from '../core/package-root.js';
import { isGitOid } from '../core/git-oid.js';
import {
  BuildDigestError,
  computeBuildDigest,
  DIGEST_ALGORITHM,
  DIGEST_MANIFEST_VERSION,
} from '../core/build-digest.js';

export interface IdentityReport {
  readonly schemaVersion: 1;
  readonly cliVersion: string;
  /**
   * The commit embedded at build time from `git rev-parse HEAD`, or null when
   * the build had no git context. This is SOURCE-TRACEABILITY METADATA only: it
   * is self-reported by the build and is NOT independently verified. Consumers
   * must not treat it as verified provenance unless they check it against a
   * trusted source. Accepts both Git object formats (40-hex SHA-1, 64-hex SHA-256).
   */
  readonly commit: string | null;
  /**
   * The authoritative, independently reproducible identity of the immutable
   * published build content (see core/build-digest.ts).
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
    return isGitOid(commit) ? commit : null;
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

export function runIdentity(_argv: string[], packageRoot: string = PACKAGE_ROOT): number {
  let report: IdentityReport;
  try {
    report = identityReport(packageRoot);
  } catch (err) {
    // A build that cannot be measured into a trustworthy identity must fail
    // closed with a controlled non-zero exit, never crash with a stack trace or
    // emit a valid-looking report. Exit 3 = environment problem (see cli/index.ts).
    if (err instanceof BuildDigestError) {
      process.stderr.write(`shipledger identity: ${err.message}\n`);
      return 3;
    }
    process.stderr.write(`shipledger identity: unexpected error: ${String(err)}\n`);
    return 3;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

// Re-exported so callers/tests can assert the manifest identity used here.
export { DIGEST_ALGORITHM, DIGEST_MANIFEST_VERSION };
