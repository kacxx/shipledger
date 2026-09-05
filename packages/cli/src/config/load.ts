import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { envError, usageError } from '../errors.js';
import { fingerprint } from '../core/canonical.js';
import { resolvePreset } from './presets.js';
import { validateConfig } from './validate.js';
import type {
  RawConfig, RawLinks, RawReferenceTemplate, ResolvedConfig, ResolvedLinks,
  ResolvedReferenceLink, ResolvedRepoLinks
} from '../types.js';

export type ConfigOrigin = 'preset' | 'adopter';

export interface ConfigOrigins {
  matchers: ConfigOrigin;
  history: ConfigOrigin;
  ignore: ConfigOrigin;
  policy: ConfigOrigin;
}

export function configOrigins(raw: RawConfig): ConfigOrigins {
  return {
    matchers: raw.matchers !== undefined ? 'adopter' : 'preset',
    history: raw.history !== undefined ? 'adopter' : 'preset',
    ignore: raw.ignore !== undefined ? 'adopter' : 'preset',
    policy: raw.policy !== undefined ? 'adopter' : 'preset'
  };
}

function normalizeRef(raw: RawReferenceTemplate): ResolvedReferenceLink {
  if (typeof raw === 'string') return { url: raw };
  const out: ResolvedReferenceLink = { url: raw.url };
  if (raw.tokenReplace) out.tokenReplace = raw.tokenReplace;
  return out;
}

function normalizeRefs(raw: Record<string, RawReferenceTemplate>): Record<string, ResolvedReferenceLink> {
  const out: Record<string, ResolvedReferenceLink> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = normalizeRef(v);
  return out;
}

export function resolveLinks(raw: RawLinks): ResolvedLinks {
  const out: ResolvedLinks = {};
  if (raw.references) out.references = normalizeRefs(raw.references);
  if (raw.repos) {
    out.repos = {};
    for (const [repo, rl] of Object.entries(raw.repos)) {
      const resolved: ResolvedRepoLinks = {};
      if (rl.commit) resolved.commit = rl.commit;
      if (rl.references) resolved.references = normalizeRefs(rl.references);
      out.repos[repo] = resolved;
    }
  }
  return out;
}

function validateTemplateUrl(template: string, placeholder: string, label: string): void {
  if (!template.includes(`{${placeholder}}`)) {
    throw usageError(`${label} must contain {${placeholder}}.`);
  }
  const unknowns = [...template.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1] as string)
    .filter((p) => p !== placeholder);
  if (unknowns.length > 0) {
    throw usageError(`${label} contains unknown placeholder(s): ${unknowns.map((u) => `{${u}}`).join(', ')}.`);
  }
  const stripped = template.replace(/\{\w+\}/g, '');
  if (/[{}]/.test(stripped)) {
    throw usageError(`${label} contains a malformed brace expression.`);
  }
  const dummy = template.replaceAll(`{${placeholder}}`, 'DUMMY_VALUE');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(dummy)) {
    throw usageError(`${label} contains control characters.`);
  }
  let url: URL;
  try {
    url = new URL(dummy);
  } catch {
    throw usageError(`${label} is not a valid URL template.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError(`${label} must use http: or https: protocol.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw usageError(`${label} must not contain credentials.`);
  }
}

export function assertLinksAgainstConfig(links: ResolvedLinks, config: ResolvedConfig): void {
  const repoNames = new Set(config.repos.map((r) => r.name));
  const matcherMap = new Map(config.matchers.map((m) => [m.id, m]));
  const problems: string[] = [];

  if (links.references) {
    for (const [matcherId, ref] of Object.entries(links.references)) {
      const matcher = matcherMap.get(matcherId);
      if (!matcher) {
        problems.push(`links.references names unknown matcher "${matcherId}"`);
        continue;
      }
      if (matcher.namespace !== 'global') {
        problems.push(`links.references["${matcherId}"] is a repo-scoped matcher — move it under links.repos.<repo>.references`);
        continue;
      }
      try {
        validateTemplateUrl(ref.url, 'token', `links.references["${matcherId}"]`);
      } catch (err) { problems.push((err as Error).message); }
      if (ref.tokenReplace) {
        try { new RegExp(ref.tokenReplace[0]); } catch (err) {
          problems.push(`links.references["${matcherId}"].tokenReplace pattern is not a valid regex: ${(err as Error).message}`);
        }
      }
    }
  }

  if (links.repos) {
    for (const [repo, rl] of Object.entries(links.repos)) {
      if (!repoNames.has(repo)) {
        problems.push(`links.repos names unknown repo "${repo}"`);
        continue;
      }
      if (rl.commit) {
        try {
          validateTemplateUrl(rl.commit, 'sha', `links.repos["${repo}"].commit`);
        } catch (err) { problems.push((err as Error).message); }
      }
      if (rl.references) {
        for (const [matcherId, ref] of Object.entries(rl.references)) {
          const matcher = matcherMap.get(matcherId);
          if (!matcher) {
            problems.push(`links.repos["${repo}"].references names unknown matcher "${matcherId}"`);
            continue;
          }
          if (matcher.namespace !== 'repo') {
            problems.push(`links.repos["${repo}"].references["${matcherId}"] is a global matcher — move it to links.references`);
            continue;
          }
          try {
            validateTemplateUrl(ref.url, 'token', `links.repos["${repo}"].references["${matcherId}"]`);
          } catch (err) { problems.push((err as Error).message); }
          if (ref.tokenReplace) {
            try { new RegExp(ref.tokenReplace[0]); } catch (err) {
              problems.push(`links.repos["${repo}"].references["${matcherId}"].tokenReplace pattern is not a valid regex: ${(err as Error).message}`);
            }
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    throw usageError(`Link configuration is invalid:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

export function mergeConfig(
  raw: RawConfig,
  configDir: string,
  opts: { allowUnpinned?: boolean } = {}
): ResolvedConfig {
  const preset = resolvePreset(raw.preset, opts);
  const config: ResolvedConfig = {
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
  if (raw.links) config.links = resolveLinks(raw.links);
  return config;
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
    policy: config.policy,
    links: config.links
  });
}

export function loadConfig(
  path: string,
  cliVersion: string
): { config: ResolvedConfig; configFingerprint: string; origins: ConfigOrigins } {
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
  const raw = validateConfig(parsed);
  const config = mergeConfig(raw, dirname(resolve(path)));
  assertConfigIdentities(config);
  if (config.links) assertLinksAgainstConfig(config.links, config);
  return { config, configFingerprint: fingerprintConfig(config, cliVersion), origins: configOrigins(raw) };
}
