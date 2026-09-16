import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildDigest } from '../src/core/build-digest.js';

// End-to-end guard for the reproducibility hazard that produced a wrong e2e
// golden: `tsc` does not remove outputs for deleted/renamed sources, so a build
// that does not clean dist/ can hash a stale artifact into the authoritative
// build digest and diverge from a fresh CI checkout. This test runs the REAL
// build twice and proves it is byte-reproducible and self-cleaning.
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function build(): void {
  execFileSync('npm', ['run', 'build'], { cwd: pkgDir, encoding: 'utf8', shell: true, stdio: 'pipe' });
}

describe('clean-build reproducibility', () => {
  it('a fresh build is byte-reproducible and clears stale dist/ artifacts', () => {
    build();
    const d1 = computeBuildDigest(pkgDir).digest;

    // Plant a stale artifact that WOULD pollute the digest if the build did not
    // clean dist/ first.
    const stale = join(pkgDir, 'dist', '__stale_repro_marker__.js');
    writeFileSync(stale, 'export const stale = true;\n');
    expect(computeBuildDigest(pkgDir).digest).not.toBe(d1);

    build();
    expect(existsSync(stale)).toBe(false); // the build cleaned dist/
    expect(computeBuildDigest(pkgDir).digest).toBe(d1); // and reproduced the exact identity
  }, 180_000);
});
