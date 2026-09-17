import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { computeBuildDigest } from '../src/core/build-digest.js';

// End-to-end guard for the reproducibility hazard that produced a wrong e2e
// golden: `tsc` does not remove outputs for deleted/renamed sources, so a build
// that does not clean dist/ can hash a stale artifact into the authoritative
// build digest and diverge from a fresh checkout.
//
// This compiles the real sources into a THROWAWAY package root (never the shared
// dist/, so it is safe under vitest's parallel workers) and proves a clean build
// is byte-reproducible and self-cleaning.
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function cleanBuildInto(root: string): void {
  const dist = join(root, 'dist');
  // Mirror the package `clean` step (rm -rf dist, Windows-safe), then emit fresh.
  rmSync(dist, { recursive: true, force: true, maxRetries: 10 });
  execFileSync(process.execPath, [tscBin, '-p', join(pkgDir, 'tsconfig.json'), '--outDir', dist], {
    cwd: pkgDir,
    stdio: 'pipe',
  });
  // schemas/ is part of the measured set; copy it alongside the compiled output.
  cpSync(join(pkgDir, 'schemas'), join(root, 'schemas'), { recursive: true });
}

describe('clean-build reproducibility', () => {
  it('a clean build is byte-reproducible and clears stale dist/ artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'shipledger-cleanbuild-'));
    try {
      cleanBuildInto(root);
      const d1 = computeBuildDigest(root).digest;

      // A stale artifact WOULD pollute the digest if the build did not clean dist/.
      const stale = join(root, 'dist', '__stale_repro_marker__.js');
      writeFileSync(stale, 'export const stale = true;\n');
      expect(computeBuildDigest(root).digest).not.toBe(d1);

      cleanBuildInto(root);
      expect(existsSync(stale)).toBe(false); // clean removed the stale artifact
      expect(computeBuildDigest(root).digest).toBe(d1); // digest reproduced exactly
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 180_000);
});
