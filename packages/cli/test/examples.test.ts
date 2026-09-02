import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, validateChangeset } from '../src/config/validate.js';
import { mergeConfig, assertConfigIdentities } from '../src/config/load.js';
import { assertChangesetAgainstConfig } from '../src/config/changeset.js';
import { compileAll } from '../src/core/compile.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe.each(['tracker-keys', 'github-oss'])('examples/%s', (name) => {
  const dir = join(root, 'examples', name);
  const rawConfig = JSON.parse(readFileSync(join(dir, 'shipledger.config.json'), 'utf8'));
  const rawChangeset = JSON.parse(readFileSync(join(dir, 'changeset.json'), 'utf8'));

  it('has a schema-valid config with a pinned preset', () => {
    const parsed = validateConfig(rawConfig);
    expect(parsed.preset).toMatch(/@\d+$/);
  });

  it('has a policy that is either absent or complete, never partial', () => {
    const parsed = validateConfig(rawConfig);
    if (parsed.policy !== undefined) expect(Array.isArray(parsed.policy.failOn)).toBe(true);
  });

  it('has a schema-valid changeset', () => {
    expect(() => validateChangeset(rawChangeset)).not.toThrow();
  });

  it('resolves, compiles, and cross-checks cleanly', () => {
    const config = mergeConfig(validateConfig(rawConfig), dir);
    assertConfigIdentities(config);
    compileAll(config);
    expect(() => assertChangesetAgainstConfig(validateChangeset(rawChangeset), config)).not.toThrow();
  });
});
