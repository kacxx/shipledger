// Build-time source-traceability capture.
//
// Writes packages/cli/build-info.json with the commit the runtime was built
// from, read from `git rev-parse HEAD`. This is metadata only — the authoritative
// runtime identity is the content digest computed by src/core/build-digest.ts,
// which deliberately EXCLUDES build-info.json. If there is no git context the
// commit is recorded as null (never guessed, never a placeholder constant).
//
// `git rev-parse HEAD` returns whichever object format the repository uses —
// 40-hex (SHA-1) or 64-hex (SHA-256). We record its trimmed output verbatim and
// do NOT re-validate its length here: the sole commit-format validator lives at
// read time (src/core/git-oid.ts, via src/cli/identity.ts), so there is exactly
// one place that decides what a well-formed commit id is. Duplicating a length
// check here is what previously silently dropped 64-hex SHA-256 commits.
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let commit;
try {
  const out = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: pkgRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
  // git succeeded → `out` is the HEAD object id. Record it as-is; the reader
  // validates the format. Empty output (should not happen on success) → null.
  commit = out.length > 0 ? out : null;
} catch {
  commit = null;
}

writeFileSync(join(pkgRoot, 'build-info.json'), `${JSON.stringify({ commit })}\n`);
process.stdout.write(`build-info.json commit=${commit ?? 'null'}\n`);
