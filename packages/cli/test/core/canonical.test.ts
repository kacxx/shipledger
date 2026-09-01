import { describe, it, expect } from 'vitest';
import { canonicalStringify, fingerprint } from '../../src/core/canonical.js';

describe('canonicalStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined-valued keys', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('is insensitive to key insertion order', () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it('escapes control characters so a commit body round-trips', () => {
    const parsed = JSON.parse(canonicalStringify({ body: 'line\nnext\ttab' }));
    expect(parsed.body).toBe('line\nnext\ttab');
  });
});

describe('fingerprint', () => {
  it('returns a prefixed sha256 hex digest', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('agrees for values differing only in key order', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('differs when any value changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
