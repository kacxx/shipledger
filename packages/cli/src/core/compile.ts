import { usageError } from '../errors.js';
import type { IgnoreConfig, MatcherConfig, ResolvedConfig } from '../types.js';

export interface CompiledMatcher { config: MatcherConfig; regex: RegExp }
export interface CompiledIgnore {
  authors: Set<string>;
  subjects: Array<{ pattern: string; regex: RegExp }>;
}

function countCaptureGroups(pattern: string): number {
  const probe = new RegExp(`(?:${pattern})|`);
  return (probe.exec('')?.length ?? 1) - 1;
}

export function compileMatchers(matchers: MatcherConfig[]): CompiledMatcher[] {
  return matchers.map((config) => {
    let groups: number;
    try {
      groups = countCaptureGroups(config.pattern);
    } catch (err) {
      throw usageError(`Matcher "${config.id}" pattern is not a valid regular expression: ${(err as Error).message}`);
    }
    if (groups !== 1) {
      throw usageError(`Matcher "${config.id}" must have exactly one capture group; found ${groups}.`);
    }
    return { config, regex: new RegExp(config.pattern, 'g') };
  });
}

export function compileIgnore(ignore: IgnoreConfig): CompiledIgnore {
  const subjects = ignore.subjects.map((pattern) => {
    try {
      return { pattern, regex: new RegExp(pattern) };
    } catch (err) {
      throw usageError(`Ignore subject "${pattern}" is not a valid regular expression: ${(err as Error).message}`);
    }
  });
  return { authors: new Set(ignore.authors), subjects };
}

export function compileAll(config: ResolvedConfig): {
  matchers: CompiledMatcher[];
  ignore: CompiledIgnore;
} {
  return { matchers: compileMatchers(config.matchers), ignore: compileIgnore(config.ignore) };
}
