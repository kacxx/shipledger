import { usageError } from '../errors.js';
import type { HistoryMode, IgnoreConfig, MatcherConfig, PolicyConfig } from '../types.js';

export interface PresetDefaults {
  matchers: MatcherConfig[];
  history: HistoryMode;
  ignore: IgnoreConfig;
  policy: PolicyConfig;
}

const TICKET_KEY: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};

const PR_REF: MatcherConfig = {
  id: 'pr-ref', sources: ['subject'],
  pattern: '(#\\d+)', namespace: 'repo', normalize: 'none'
};

const COMMON_IGNORE: IgnoreConfig = {
  authors: ['dependabot[bot]'],
  subjects: ['^Merge branch', '^chore\\(deps\\)']
};

const REGISTRY: Record<string, Record<number, PresetDefaults>> = {
  'tracker-keys': {
    1: {
      matchers: [TICKET_KEY, PR_REF],
      history: 'first-parent',
      ignore: COMMON_IGNORE,
      policy: { failOn: ['no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'] }
    }
  },
  'github-oss': {
    1: {
      matchers: [PR_REF],
      history: 'first-parent',
      ignore: COMMON_IGNORE,
      policy: { failOn: ['unknown-reference', 'range-divergence'] }
    }
  }
};

export const PRESET_NAMES = Object.keys(REGISTRY);

export function resolvePreset(
  spec: string,
  opts: { allowUnpinned?: boolean } = {}
): { name: string; version: number; defaults: PresetDefaults } {
  const [name = '', rawVersion] = spec.split('@');
  const versions = REGISTRY[name];
  if (!versions) {
    throw usageError(`Unknown preset "${name}". Available: ${PRESET_NAMES.join(', ')}.`);
  }
  const available = Object.keys(versions).map(Number).sort((a, b) => a - b);

  if (rawVersion === undefined) {
    if (!opts.allowUnpinned) {
      throw usageError(
        `Preset "${name}" must be pinned as "${name}@${available[available.length - 1]}". An unpinned preset would let a CLI upgrade silently change your policy.`
      );
    }
    const version = available[available.length - 1] as number;
    return { name, version, defaults: versions[version] as PresetDefaults };
  }

  const version = Number(rawVersion);
  const defaults = versions[version];
  if (!defaults) {
    throw usageError(`Unknown version ${rawVersion} for preset "${name}". Available versions: ${available.join(', ')}.`);
  }
  return { name, version, defaults };
}
