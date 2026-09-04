import { buildNoteLookup, commitKey, referenceKey } from '../notes.js';
import type { CommitResult, NotesFile, RangeResult, VerifiedChangeset } from '../types.js';

const short = (sha: string): string => sha.slice(0, 8);

function mdEscape(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}[\]()#+!|<>&~])/g, '\\$1');
}

function codeSpanSafe(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/\|/g, '\\|');
}

function safeItemUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const dest = raw
    .replace(/[<>]/g, (ch) => encodeURIComponent(ch))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/ /g, '%20');
  if (/[\r\n]/.test(dest)) return null;
  return dest;
}

function noteSuffix(entry: { classification: string; note: string } | undefined): string {
  return entry ? ` ${mdEscape(entry.classification)}: ${mdEscape(entry.note)}` : '';
}

function commitRow(
  c: CommitResult,
  status: string,
  detail: string,
  noteSuffix: string
): string {
  return `| ${mdEscape(c.repo)} | \`${short(c.sha)}\` | ${mdEscape(c.subject)} | ${status} | ${detail}${noteSuffix} |`;
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
      out.push(`| Path scope | ${range.include.map((p) => `\`${codeSpanSafe(p)}\``).join(', ')} |`);
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
          out.push(commitRow(c, 'ignored', mdEscape(c.ignored.rule), ''));
          continue;
        }

        const linked = c.references.flatMap((r) => r.resolvesTo);
        const unresolved = c.references.filter((r) => r.resolvesTo.length === 0);

        if (unresolved.length > 0) {
          const tokens = unresolved.map((r) => {
            const entry = lookup.unknownReference.get(referenceKey(c.repo, c.sha, r.matcher, r.token));
            return `${mdEscape(r.token)} (${mdEscape(r.matcher)})${noteSuffix(entry)}`;
          }).join('; ');
          const also = linked.length > 0 ? ` · also → ${[...new Set(linked)].map((id) => mdEscape(id)).join(', ')}` : '';
          out.push(commitRow(c, 'unknown\\-reference', `${tokens}${also}`, ''));
        } else if (c.findings.includes('no-reference')) {
          const entry = lookup.noReference.get(commitKey(c.repo, c.sha));
          out.push(commitRow(c, 'no\\-reference', '', noteSuffix(entry)));
        } else if (linked.length > 0) {
          out.push(commitRow(c, 'linked', `→ ${[...new Set(linked)].map((id) => mdEscape(id)).join(', ')}`, ''));
        } else {
          out.push(commitRow(c, 'linked', '', ''));
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
      ? item.commits.map((c) => `\`${short(c.sha)}\` (${mdEscape(c.repo)})`).join(', ')
      : '—';
    const finding = item.findings.includes('item-without-commits') ? 'item\\-without\\-commits' : '—';
    const itemNote = lookup.items.get(item.id);
    const triage = itemNote ? `${mdEscape(itemNote.classification)}: ${mdEscape(itemNote.note)}` : '—';
    const raw = verified.changeset.items.find((ci) => ci.id === item.id)?.url;
    const dest = safeItemUrl(raw);
    const idCell = dest ? `[${mdEscape(item.id)}](${dest})` : mdEscape(item.id);

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
    if (tokenCount > 0) parts.push(`${tokenCount} unresolved reference(s)`);
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
            out.push(`| \`${short(c.sha)}\` ${mdEscape(c.subject)} | ${mdEscape(r.token)} (${mdEscape(r.matcher)}) | ${r.sources.join(', ')} | ${entry ? mdEscape(entry.classification) : '—'} | ${entry ? mdEscape(entry.note) : '—'} |`);
          }
        }
        if (c.findings.includes('no-reference')) {
          const entry = lookup.noReference.get(commitKey(c.repo, c.sha));
          out.push(`| \`${short(c.sha)}\` ${mdEscape(c.subject)} | — | — | ${entry ? mdEscape(entry.classification) : '—'} | ${entry ? mdEscape(entry.note) : '—'} |`);
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
