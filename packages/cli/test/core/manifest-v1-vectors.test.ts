import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestV1Digest } from '../../src/core/build-digest.js';

// The producer (shipledger) and the consumer (shipledger-release-control) share
// these vectors byte-for-byte. Both must reproduce every digest, which is what
// makes the manifest-v1 canonicalisation a cross-implementation contract rather
// than a JavaScript implementation detail.
interface Vector {
  readonly name: string;
  readonly entries: (readonly [string, string])[];
  readonly canonical: string;
  readonly digest: string;
}
interface VectorFile {
  readonly manifestVersion: string;
  readonly algorithm: string;
  readonly vectors: Vector[];
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'manifest-v1-digest-vectors.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as VectorFile;

describe('manifest-v1 shared cross-implementation vectors', () => {
  it('pins the manifest version and algorithm', () => {
    expect(fixture.manifestVersion).toBe('1');
    expect(fixture.algorithm).toBe('sha256');
  });

  for (const v of fixture.vectors) {
    it(`reproduces vector "${v.name}"`, () => {
      expect(manifestV1Digest(v.entries)).toBe(v.digest);
    });
  }
});
