import { renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { envError } from '../errors.js';

export function writeAtomic(path: string, contents: string): void {
  const tmp = join(dirname(path), `.shipledger-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw envError(`Cannot write ${path}: ${(err as Error).message}`);
  }
}
