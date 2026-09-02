import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { envError, usageError } from '../errors.js';
import { fingerprint } from '../core/canonical.js';
import { resolvePreset } from './presets.js';
import { validateConfig } from './validate.js';
import type { RawConfig, ResolvedConfig } from '../types.js';

export function mergeConfig(
  raw: RawConfig,
  configDir: string,
  opts: { allowUnpinned?: boolean } = {}
): ResolvedConfig {
  const preset = resolvePreset(raw.preset, opts);
  return {
    version: raw.version,
    presetName: preset.name,
    presetVersion: preset.version,
    repos: raw.repos.map((r) => ({
      name: r.name,
      sourcePath: r.path,
      path: isAbsolute(r.path) ? r.path : resolve(configDir, r.path)
    })),
    matchers: raw.matchers ?? preset.defaults.matchers,
    history: raw.history ?? preset.defaults.history,
    ignore: raw.ignore ?? preset.defaults.ignore,
    policy: raw.policy ?? preset.defaults.policy
  };
}

export function assertConfigIdentities(config: ResolvedConfig): void {
  const problems: string[] = [];

  const repos = new Set<string>();
  for (const r of config.repos) {
    if (repos.has(r.name)) problems.push(`duplicate repo name "${r.name}"`);
    repos.add(r.name);
  }

  const matchers = new Set<string>();
  for (const m of config.matchers) {
    if (matchers.has(m.id)) problems.push(`duplicate matcher id "${m.id}"`);
    matchers.add(m.id);
  }

  if (problems.length > 0) {
    throw usageError(`Config has conflicting identities:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

export function fingerprintConfig(config: ResolvedConfig, cliVersion: string): string {
  return fingerprint({
    cliVersion,
    version: config.version,
    presetName: config.presetName,
    presetVersion: config.presetVersion,
    repos: config.repos.map((r) => ({ name: r.name, path: r.sourcePath })),
    matchers: config.matchers,
    history: config.history,
    ignore: config.ignore,
    policy: config.policy
  });
}

export function loadConfig(
  path: string,
  cliVersion: string
): { config: ResolvedConfig; configFingerprint: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw envError(`Cannot read config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usageError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const config = mergeConfig(validateConfig(parsed), dirname(resolve(path)));
  assertConfigIdentities(config);
  return { config, configFingerprint: fingerprintConfig(config, cliVersion) };
}
