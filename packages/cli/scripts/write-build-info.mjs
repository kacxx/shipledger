// Build-time source-traceability capture.
//
// Writes packages/cli/build-info.json with the commit the runtime was built
// from, read from `git rev-parse HEAD`. This is metadata only — the authoritative
// runtime identity is the content digest computed by src/core/build-digest.ts,
// which deliberately EXCLUDES build-info.json. If there is no git context the
// commit is recorded as null (never guessed, never a placeholder constant).
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let commit = null;
try {
  const out = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: pkgRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
  if (/^[0-9a-f]{40}$/.test(out)) commit = out;
} catch {
  commit = null;
}

writeFileSync(join(pkgRoot, 'build-info.json'), `${JSON.stringify({ commit })}\n`);
process.stdout.write(`build-info.json commit=${commit ?? 'null'}\n`);
