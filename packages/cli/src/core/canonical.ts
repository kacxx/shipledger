import { createHash } from 'node:crypto';

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);

  return `{${entries.join(',')}}`;
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}
