import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mark-bin-executable.mjs');

describe('mark-bin-executable', () => {
  // A rebuild replaces the file behind an existing `npm link`, which only set
  // the executable bit when it linked.
  it.skipIf(process.platform === 'win32')('makes the bin entry executable after a rebuild', () => {
    const root = mkdtempSync(join(tmpdir(), 'shipledger-bin-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ bin: { shipledger: 'dist/cli/index.js' } }));
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      const entry = join(root, 'dist', 'cli', 'index.js');
      writeFileSync(entry, '#!/usr/bin/env node\n');
      chmodSync(entry, 0o644);

      execFileSync(process.execPath, [script, root], { stdio: 'pipe' });

      expect(statSync(entry).mode & 0o111).toBe(0o111);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});
