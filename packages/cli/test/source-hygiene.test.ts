import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'dist' ? [] : sourceFiles(path);
    return /\.(ts|json)$/.test(entry.name) ? [path] : [];
  });
}

describe('source hygiene', () => {
  // A raw NUL in a source file makes git classify it as binary, which hides it
  // from diffs and code review. The separators must be written as \0 escapes.
  it('has no raw NUL bytes in any source or test file', () => {
    const offenders = [join(pkgDir, 'src'), join(pkgDir, 'test'), join(pkgDir, 'schemas')]
      .flatMap(sourceFiles)
      .filter((path) => readFileSync(path).includes(0x00))
      .map((path) => relative(pkgDir, path));

    expect(offenders).toEqual([]);
  });
});
