// Post-build: make every `bin` entry in package.json executable.
//
// `tsc` writes dist/cli/index.js as an ordinary file. `npm link` and
// `npm install` set the executable bit when they create the link, but a rebuild
// replaces the file behind an existing link, and the command then fails with
// "Permission denied". Windows has no executable bit, so chmod is a no-op there.
//
// Usage: node scripts/mark-bin-executable.mjs [package-root]
import process from 'node:process';
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const { bin } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const entries = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});

for (const entry of entries) {
  chmodSync(join(pkgRoot, entry), 0o755);
  process.stdout.write(`executable: ${entry}\n`);
}
