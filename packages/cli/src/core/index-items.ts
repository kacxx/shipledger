import type { Changeset, MatcherConfig, Namespace, Reference } from '../types.js';
import { applyNormalize } from './normalize.js';

export type ItemIndex = Map<string, string[]>;

export function scopeKeyFor(namespace: Namespace, repo: string): string {
  return namespace === 'global' ? 'global' : repo;
}

const keyOf = (matcherId: string, scopeKey: string, token: string): string =>
  `${matcherId}\0${scopeKey}\0${token}`;

export function buildItemIndex(changeset: Changeset, matchers: MatcherConfig[]): ItemIndex {
  const index: ItemIndex = new Map();
  const byId = new Map(matchers.map((m) => [m.id, m]));

  for (const item of changeset.items) {
    for (const token of item.tokens) {
      const matcher = byId.get(token.matcher);
      if (!matcher) continue;
      const key = keyOf(
        matcher.id,
        scopeKeyFor(matcher.namespace, token.repo ?? ''),
        applyNormalize(token.token, matcher.normalize)
      );
      const bucket = index.get(key);
      if (bucket) {
        if (!bucket.includes(item.id)) bucket.push(item.id);
      } else {
        index.set(key, [item.id]);
      }
    }
  }
  return index;
}

export function resolveReferences(
  refs: Reference[],
  repo: string,
  index: ItemIndex
): { references: Reference[]; links: Array<{ itemId: string }> } {
  const linked: string[] = [];
  const references = refs.map((ref) => {
    const hits = index.get(keyOf(ref.matcher, scopeKeyFor(ref.namespace, repo), ref.token)) ?? [];
    for (const id of hits) if (!linked.includes(id)) linked.push(id);
    return { ...ref, resolvesTo: [...hits] };
  });
  return { references, links: linked.map((itemId) => ({ itemId })) };
}
