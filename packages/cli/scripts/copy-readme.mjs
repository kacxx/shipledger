// Prepack: copy the repository README into the package.
//
// npm shows the README of the published package directory, and this package
// lives in packages/cli while the README lives at the repository root. Copying
// it at pack time keeps one README instead of two that drift apart. The copy is
// ignored by git.
//
// Usage: node scripts/copy-readme.mjs [package-root]
import process from 'node:process';
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '..');

copyFileSync(join(pkgRoot, '..', '..', 'README.md'), join(pkgRoot, 'README.md'));
process.stdout.write('copied: README.md\n');
