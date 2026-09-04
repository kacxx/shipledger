import { readFileSync } from 'node:fs';
import { envError, usageError } from '../errors.js';
import { validateChangeset } from './validate.js';
import type { Changeset, ResolvedConfig } from '../types.js';

export function loadChangeset(path: string): Changeset {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw envError(`Cannot read changeset at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usageError(`Changeset at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validateChangeset(parsed);
}

const CLOCK_SKEW_MS = 5 * 60_000;

export function assertFetchedAtPlausible(fetchedAt: string): void {
  const ts = new Date(fetchedAt).getTime();
  if (Number.isNaN(ts)) {
    throw usageError(`source.fetchedAt "${fetchedAt}" is not a valid timestamp.`);
  }
  const now = Date.now();
  if (ts > now + CLOCK_SKEW_MS) {
    throw usageError(
      `source.fetchedAt "${fetchedAt}" is in the future. ` +
      `Capture the actual UTC time when the provider response is received; do not construct or approximate it.`
    );
  }
}

export function assertChangesetAgainstConfig(changeset: Changeset, config: ResolvedConfig): void {
  const repoNames = new Set(config.repos.map((r) => r.name));
  const matchers = new Map(config.matchers.map((m) => [m.id, m]));
  const problems: string[] = [];

  const seenRangeRepos = new Set<string>();
  for (const range of changeset.ranges) {
    if (!repoNames.has(range.repo)) {
      problems.push(`range names repo "${range.repo}", which the config does not define (defined: ${[...repoNames].join(', ')})`);
    }
    if (seenRangeRepos.has(range.repo)) {
      problems.push(`repo "${range.repo}" has more than one range; V1 permits one range per repo — put multiple paths in that range's "include"`);
    }
    seenRangeRepos.add(range.repo);
  }

  const seenItems = new Set<string>();
  for (const item of changeset.items) {
    if (seenItems.has(item.id)) problems.push(`duplicate item id "${item.id}"`);
    seenItems.add(item.id);

    for (const token of item.tokens) {
      const matcher = matchers.get(token.matcher);
      if (!matcher) {
        problems.push(`item "${item.id}" token names matcher "${token.matcher}", which the config does not define`);
        continue;
      }
      if (matcher.namespace === 'repo' && token.repo === undefined) {
        problems.push(`item "${item.id}" token for repo-namespaced matcher "${token.matcher}" requires "repo"`);
      }
      if (matcher.namespace === 'global' && token.repo !== undefined) {
        problems.push(`item "${item.id}" token for global matcher "${token.matcher}" must not carry "repo"`);
      }
      if (token.repo !== undefined && !repoNames.has(token.repo)) {
        problems.push(`item "${item.id}" token names repo "${token.repo}", which the config does not define`);
      }
    }
  }

  if (problems.length > 0) {
    throw usageError(`Changeset is inconsistent with the config:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
