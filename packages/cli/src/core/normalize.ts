import type { Normalize } from '../types.js';

/**
 * Token normalization must be byte-identical on the commit side (extraction)
 * and the item side (indexing), or a reference stops matching a declared token.
 * Keep this the single definition both sides call.
 */
export function applyNormalize(token: string, normalize: Normalize): string {
  if (normalize === 'upper') return token.toUpperCase();
  if (normalize === 'lower') return token.toLowerCase();
  return token;
}
