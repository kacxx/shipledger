import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../core/package-root.js';

const pkgPath = join(PACKAGE_ROOT, 'package.json');
export const CLI_VERSION: string = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
