import type { CommitRecord, CommitSource, Reference } from '../types.js';
import type { CompiledMatcher } from './compile.js';
import { applyNormalize } from './normalize.js';

const SOURCE_ORDER: CommitSource[] = ['subject', 'body'];

export function extractReferences(commit: CommitRecord, matchers: CompiledMatcher[]): Reference[] {
  const order: string[] = [];
  const byKey = new Map<string, Reference>();

  for (const { config, regex } of matchers) {
    for (const source of SOURCE_ORDER) {
      if (!config.sources.includes(source)) continue;
      const text = source === 'subject' ? commit.subject : commit.body;
      for (const match of text.matchAll(regex)) {
        const captured = match[1];
        if (captured === undefined) continue;
        const token = applyNormalize(captured, config.normalize);
        const key = `${config.id}\0${token}`;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
          continue;
        }
        const reference: Reference = {
          matcher: config.id,
          token,
          namespace: config.namespace,
          sources: [source],
          resolvesTo: []
        };
        byKey.set(key, reference);
        order.push(key);
      }
    }
  }

  // sources are pushed in SOURCE_ORDER as it is iterated, so they are already
  // ordered — no post-sort is needed.
  return order.map((key) => byKey.get(key) as Reference);
}
