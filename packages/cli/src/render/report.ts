import { buildNoteLookup, commitKey, referenceKey } from '../notes.js';
import type {
  CommitResult, Namespace, NotesFile, RangeResult,
  ResolvedLinks, ResolvedReferenceLink, VerifiedChangeset
} from '../types.js';

const short = (sha: string): string => sha.slice(0, 8);

function mdEscape(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}[\]()#+!|<>&~])/g, '\\$1');
}

function codeSpan(text: string): string {
  const safe = text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  const runs = safe.match(/`+/g);
  const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  if (maxRun === 0) return `\`${safe}\``;
  const fence = '`'.repeat(maxRun + 1);
  return `${fence} ${safe} ${fence}`;
}

function safeUrl(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function expandTemplate(template: string, vars: Record<string, string>): string | null {
  let substitutions = 0;
  let hasUnresolved = false;
  const expanded = template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = vars[key];
    if (val === undefined) { hasUnresolved = true; return match; }
    substitutions++;
    return encodeURIComponent(val);
  });
  if (hasUnresolved) return null;
  if (substitutions === 0) return null;
  if (/[{}]/.test(expanded)) return null;
  return safeUrl(expanded);
}

function commitUrl(links: ResolvedLinks | undefined, repo: string, sha: string): string | null {
  const tpl = links?.repos?.[repo]?.commit;
  if (!tpl) return null;
  return expandTemplate(tpl, { sha });
}

function resolveRefEntry(
  links: ResolvedLinks | undefined, repo: string, matcher: string, namespace: Namespace
): ResolvedReferenceLink | undefined {
  if (namespace === 'global') return links?.references?.[matcher];
  return links?.repos?.[repo]?.references?.[matcher];
}

function referenceUrl(
  links: ResolvedLinks | undefined, repo: string,
  matcher: string, token: string, namespace: Namespace
): string | null {
  const entry = resolveRefEntry(links, repo, matcher, namespace);
  if (!entry) return null;
  let value = token;
  if (entry.tokenReplace) {
    try {
      value = value.replace(new RegExp(entry.tokenReplace[0]), entry.tokenReplace[1]);
    } catch {
      return null;
    }
  }
  return expandTemplate(entry.url, { token: value });
}

function linkedSha(links: ResolvedLinks | undefined, repo: string, sha: string): string {
  const dest = commitUrl(links, repo, sha);
  return dest ? `[\`${short(sha)}\`](${dest})` : `\`${short(sha)}\``;
}

function linkedItemId(id: string, itemUrls: Map<string, string>): string {
  const dest = itemUrls.get(id);
  return dest ? `[${mdEscape(id)}](${dest})` : mdEscape(id);
}

function linkedRefToken(
  links: ResolvedLinks | undefined, repo: string,
  matcher: string, token: string, namespace: Namespace
): string {
  const dest = referenceUrl(links, repo, matcher, token, namespace);
  return dest ? `[${mdEscape(token)}](${dest})` : mdEscape(token);
}

function noteSuffix(entry: { classification: string; note: string } | undefined): string {
  return entry ? ` ${mdEscape(entry.classification)}: ${mdEscape(entry.note)}` : '';
}

function commitRow(
  c: CommitResult,
  status: string,
  detail: string,
  noteSuffix: string,
  links: ResolvedLinks | undefined
): string {
  return `| ${mdEscape(c.repo)} | ${linkedSha(links, c.repo, c.sha)} | ${mdEscape(c.subject)} | ${status} | ${detail}${noteSuffix} |`;
}

function countFindings(verified: VerifiedChangeset): number {
  let count = 0;
  for (const c of verified.commits) {
    if (c.findings.includes('no-reference')) count++;
    if (c.findings.includes('unknown-reference')) {
      count += c.references.filter((r) => r.resolvesTo.length === 0).length;
    }
  }
  for (const i of verified.items) {
    if (i.findings.includes('item-without-commits')) count++;
  }
  for (const r of verified.ranges) {
    if (r.findings.includes('range-divergence')) count++;
  }
  return count;
}

export function renderReport(verified: VerifiedChangeset, notes?: NotesFile): string {
  const out: string[] = [];
  const s = verified.summary;
  const lookup = buildNoteLookup(notes ?? { version: 1 });
  const links = verified.links;

  const itemUrls = new Map<string, string>();
  for (const ci of verified.changeset.items) {
    if (ci.url !== undefined) {
      const dest = safeUrl(ci.url);
      if (dest) itemUrls.set(ci.id, dest);
    }
  }

  out.push(`# Reconciliation Report — ${mdEscape(verified.changeset.id)}`);
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push(`| Field | Value |`);
  out.push(`| --- | --- |`);
  out.push(`| Verdict | **${verified.verdict.toUpperCase()}** |`);
  out.push(`| Preset | ${mdEscape(verified.preset)} |`);
  out.push(`| History | ${verified.history} |`);
  out.push(`| Config fingerprint | \`${verified.configFingerprint}\` |`);
  out.push(`| Items linked | ${s.itemsLinked} / ${s.items} |`);
  out.push(`| Commits | ${s.commits} (${s.commitsIgnored} ignored) |`);

  if (verified.violations.length > 0) {
    out.push(`| Violations | ${verified.violations.map((v) => `${v.finding}=${v.count}`).join(', ')} |`);
  }

  const totalFindings = countFindings(verified);
  if (notes === undefined) {
    out.push(`| Triage | UNTRIAGED — 0/${totalFindings} findings covered |`);
  } else {
    out.push(`| Triage | COMPLETE — ${totalFindings}/${totalFindings} findings covered |`);
  }
  out.push('');

  const src = verified.changeset.source;
  out.push(`**Source:** ${mdEscape(src.kind)} · ${mdEscape(src.ref)} · fetched ${src.fetchedAt}`);
  out.push('');

  const repos = [...new Set(verified.ranges.map((r) => r.repo))];
  for (const repo of repos) {
    const range = verified.ranges.find((r) => r.repo === repo) as RangeResult;
    const repoCommits = verified.commits.filter((c) => c.repo === repo);

    out.push(`## ${mdEscape(repo)}`);
    out.push('');

    out.push('### Range');
    out.push('');
    out.push(`| Field | Value |`);
    out.push(`| --- | --- |`);
    out.push(`| Refs | ${mdEscape(range.base)}..${mdEscape(range.head)} |`);
    out.push(`| Base SHA | \`${range.baseSha}\` |`);
    out.push(`| Head SHA | \`${range.headSha}\` |`);
    if (range.mergeBase) {
      out.push(`| Merge base | \`${range.mergeBase}\` |`);
    }
    out.push(`| Ancestry | ${range.baseIsAncestorOfHead ? 'base is ancestor of head' : `**diverged** — ${range.commitsOnlyInBase} commit(s) only in base`} |`);
    if (range.include.length > 0) {
      out.push(`| Path scope | ${range.include.map((p) => codeSpan(p)).join(', ')} |`);
    }
    if (range.findings.includes('range-divergence')) {
      const rangeNote = lookup.ranges.get(repo);
      out.push(`| Finding | range\\-divergence${noteSuffix(rangeNote)} |`);
    }
    out.push('');

    if (repoCommits.length > 0) {
      out.push('### Commits');
      out.push('');
      out.push('| Repo | SHA | Subject | Status | Detail |');
      out.push('| --- | --- | --- | --- | --- |');

      for (const c of repoCommits) {
        if (c.ignored) {
          out.push(commitRow(c, 'ignored', mdEscape(c.ignored.rule), '', links));
          continue;
        }

        const linked = c.references.flatMap((r) => r.resolvesTo);
        const unresolved = c.references.filter((r) => r.resolvesTo.length === 0);

        if (unresolved.length > 0) {
          const tokens = unresolved.map((r) => {
            const entry = lookup.unknownReference.get(referenceKey(c.repo, c.sha, r.matcher, r.token));
            return `${linkedRefToken(links, c.repo, r.matcher, r.token, r.namespace)} (${mdEscape(r.matcher)})${noteSuffix(entry)}`;
          }).join('; ');
          const also = linked.length > 0 ? ` · also → ${[...new Set(linked)].map((id) => linkedItemId(id, itemUrls)).join(', ')}` : '';
          out.push(commitRow(c, 'unknown\\-reference', `${tokens}${also}`, '', links));
        } else if (c.findings.includes('no-reference')) {
          const entry = lookup.noReference.get(commitKey(c.repo, c.sha));
          out.push(commitRow(c, 'no\\-reference', '', noteSuffix(entry), links));
        } else if (linked.length > 0) {
          out.push(commitRow(c, 'linked', `→ ${[...new Set(linked)].map((id) => linkedItemId(id, itemUrls)).join(', ')}`, '', links));
        } else {
          out.push(commitRow(c, 'linked', '', '', links));
        }
      }
      out.push('');
    }
  }

  out.push('## Claimed Items');
  out.push('');
  out.push('| Item | Title | Type | Status | Commits | Finding | Triage |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');

  for (const item of verified.items) {
    const commitList = item.commits.length > 0
      ? item.commits.map((c) => `${linkedSha(links, c.repo, c.sha)} (${mdEscape(c.repo)})`).join(', ')
      : '—';
    const finding = item.findings.includes('item-without-commits') ? 'item\\-without\\-commits' : '—';
    const itemNote = lookup.items.get(item.id);
    const triage = itemNote ? `${mdEscape(itemNote.classification)}: ${mdEscape(itemNote.note)}` : '—';
    const idCell = linkedItemId(item.id, itemUrls);

    out.push(`| ${idCell} | ${mdEscape(item.title)} | ${mdEscape(item.type)} | ${mdEscape(item.status)} | ${commitList} | ${finding} | ${triage} |`);
  }
  out.push('');

  const unknownRefCommits = verified.commits.filter((c) => c.findings.includes('unknown-reference'));
  const noRefCommits = verified.commits.filter((c) => c.findings.includes('no-reference'));

  if (unknownRefCommits.length > 0 || noRefCommits.length > 0) {
    out.push('## Unresolved');
    out.push('');

    let tokenCount = 0;
    for (const c of unknownRefCommits) {
      tokenCount += c.references.filter((r) => r.resolvesTo.length === 0).length;
    }

    const parts: string[] = [];
    if (unknownRefCommits.length > 0) {
      parts.push(`${unknownRefCommits.length} commit(s) with ${tokenCount} unresolved reference(s)`);
    }
    if (noRefCommits.length > 0) parts.push(`${noRefCommits.length} commit(s) with no reference`);
    out.push(`${parts.join(', ')}.`);
    out.push('');

    const allUnresolved = verified.commits.filter(
      (c) => c.findings.includes('unknown-reference') || c.findings.includes('no-reference')
    );
    const byRepo = new Map<string, CommitResult[]>();
    for (const c of allUnresolved) {
      const list = byRepo.get(c.repo) ?? [];
      list.push(c);
      byRepo.set(c.repo, list);
    }

    for (const [repo, commits] of byRepo) {
      out.push(`### ${mdEscape(repo)}`);
      out.push('');
      out.push('| Commit | Reference | Seen in | Classification | Operator note |');
      out.push('| --- | --- | --- | --- | --- |');
      for (const c of commits) {
        const unresolved = c.references.filter((r) => r.resolvesTo.length === 0);
        if (unresolved.length > 0) {
          for (const r of unresolved) {
            const entry = lookup.unknownReference.get(referenceKey(c.repo, c.sha, r.matcher, r.token));
            out.push(`| ${linkedSha(links, c.repo, c.sha)} ${mdEscape(c.subject)} | ${linkedRefToken(links, c.repo, r.matcher, r.token, r.namespace)} (${mdEscape(r.matcher)}) | ${r.sources.join(', ')} | ${entry ? mdEscape(entry.classification) : '—'} | ${entry ? mdEscape(entry.note) : '—'} |`);
          }
        }
        if (c.findings.includes('no-reference')) {
          const entry = lookup.noReference.get(commitKey(c.repo, c.sha));
          out.push(`| ${linkedSha(links, c.repo, c.sha)} ${mdEscape(c.subject)} | — | — | ${entry ? mdEscape(entry.classification) : '—'} | ${entry ? mdEscape(entry.note) : '—'} |`);
        }
      }
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('Engine verdict is based on policy and git evidence only. Tracker claims are taken on trust.');
  if (notes === undefined) {
    out.push('Findings are untriaged — no notes were supplied.');
  }

  return `${out.join('\n')}\n`;
}
