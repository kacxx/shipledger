import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Absolute path to the installed CLI package root — the single source of truth
 * for locating published files (package.json, dist/, schemas/, build-info.json).
 *
 * This module compiles to `dist/core/package-root.js`, so the package root is two
 * levels up. Consumers (version.ts, identity.ts) import this constant instead of
 * re-deriving the layout, so the "two levels up" assumption lives in one place.
 */
export const PACKAGE_ROOT: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
