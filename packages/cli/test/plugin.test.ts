import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCliRange } from '../src/cli/doctor.js';
import { CLI_VERSION } from '../src/cli/version.js';
import { NO_REFERENCE_CLASSIFICATIONS, UNKNOWN_REFERENCE_CLASSIFICATIONS, ITEM_CLASSIFICATIONS, RANGE_CLASSIFICATIONS } from '../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const plugin = join(root, 'plugin');
const skill = join(plugin, 'skills', 'shipledger', 'SKILL.md');

describe('plugin layout', () => {
  it('has a manifest with a valid name', () => {
    const manifest = JSON.parse(readFileSync(join(plugin, '.cursor-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('shipledger');
  });

  it('exposes the skill where skills/ discovery expects it', () => {
    expect(existsSync(skill)).toBe(true);
  });

  it('ships the change-request template the skill references', () => {
    expect(existsSync(join(plugin, 'skills', 'shipledger', 'templates', 'change-request.md'))).toBe(true);
  });
});

describe('skill frontmatter', () => {
  const text = readFileSync(skill, 'utf8');

  it('starts with YAML frontmatter carrying name and description', () => {
    // A Windows checkout legitimately has CRLF line endings.
    const lf = text.replace(/\r\n/g, '\n');
    expect(lf.startsWith('---\n')).toBe(true);
    const front = lf.slice(4, lf.indexOf('\n---', 4));
    expect(front).toMatch(/^name:\s*shipledger$/m);
    expect(front).toMatch(/^description:/m);
  });
});

describe('cli compatibility declaration', () => {
  const { cliRange } = JSON.parse(readFileSync(join(plugin, 'cli-compatibility.json'), 'utf8'));

  it('is a range this CLI can interpret', () => {
    expect(checkCliRange(cliRange, CLI_VERSION).ok).toBe(true);
  });

  it('is satisfied by the current CLI version', () => {
    expect(checkCliRange(cliRange, CLI_VERSION)).toEqual({ ok: true, compatible: true });
  });
});

describe('skill documents the real contracts', () => {
  const text = readFileSync(skill, 'utf8');

  it('lists every classification the schema accepts', () => {
    for (const c of [
      ...NO_REFERENCE_CLASSIFICATIONS, ...UNKNOWN_REFERENCE_CLASSIFICATIONS,
      ...ITEM_CLASSIFICATIONS, ...RANGE_CLASSIFICATIONS
    ]) {
      expect(text).toContain(c);
    }
  });

  it('documents the note sections as arrays identified by their fields', () => {
    expect(text).toContain('"unknownReference": [');
    expect(text).toContain('"matcher": "ticket-key"');
  });

  it('does not document the superseded colon-delimited key form', () => {
    expect(text).not.toContain('<repo>:<sha>');
  });

  it('states the all-or-nothing coverage rule and the untriaged escape hatch', () => {
    expect(text).toMatch(/all or nothing/i);
    expect(text).toMatch(/omit `--notes`/i);
  });

  it('states that item id is not matchable', () => {
    expect(text).toMatch(/never matched against git/i);
  });

  it('documents effective config inspection with origin markers', () => {
    expect(text).toMatch(/effective config/i);
    expect(text).toMatch(/adopter override/i);
    expect(text).toMatch(/replace-only/i);
  });

  it('documents preflight before range confirmation', () => {
    expect(text).toMatch(/preflight before confirmation/i);
    expect(text).toMatch(/shallow/i);
    expect(text).toMatch(/dirty working tree/i);
    expect(text).toMatch(/excluded from the candidate/i);
  });

  it('requires fetchedAt to be captured at provider-response time', () => {
    expect(text).toMatch(/actual UTC time.*provider response/i);
    expect(text).toMatch(/rejects timestamps in the future/i);
  });

  it('documents PR token resolution with demonstrable-association rule', () => {
    expect(text).toMatch(/demonstrable association/i);
    expect(text).toMatch(/pr-ref/);
  });

  it('documents annotated tag dereference using ^{commit}', () => {
    expect(text).toMatch(/rev-parse --verify.*\^{commit}/)
  });

  it('documents PR-association verification after building the changeset', () => {
    expect(text).toMatch(/run.*check.*inspect/i);
    expect(text).toMatch(/PR token/i);
    expect(text).toMatch(/should resolve/i);
  });
});
