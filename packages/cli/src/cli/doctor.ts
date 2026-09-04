import { resolve } from 'node:path';
import { toExitCode } from '../errors.js';
import { parseOrUsage } from './args.js';
import { loadConfig, type ConfigOrigin } from '../config/load.js';
import { compileAll } from '../core/compile.js';
import { assertChangesetAgainstConfig, loadChangeset } from '../config/changeset.js';
import { assertUsableRepo, dirtyTree, resolveRange } from '../git/refs.js';
import { CLI_VERSION } from './version.js';

type RangeCheck = { ok: true; compatible: boolean } | { ok: false };

export function checkCliRange(range: string, version: string): RangeCheck {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const current = parse(version);
  if (!current) return { ok: false };

  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  const gte = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range);
  const exact = /^(\d+\.\d+\.\d+)$/.exec(range);
  const target = parse(caret?.[1] ?? gte?.[1] ?? exact?.[1] ?? '');
  if (!target) return { ok: false };

  const atLeast =
    current[0] > target[0] ||
    (current[0] === target[0] && (current[1] > target[1] ||
      (current[1] === target[1] && current[2] >= target[2])));

  if (caret) {
    if (target[0] > 0) return { ok: true, compatible: current[0] === target[0] && atLeast };
    if (target[1] > 0) {
      return { ok: true, compatible: current[0] === 0 && current[1] === target[1] && atLeast };
    }
    return { ok: true, compatible: current.join('.') === target.join('.') };
  }
  if (gte) return { ok: true, compatible: atLeast };
  return { ok: true, compatible: current.join('.') === target.join('.') };
}

export function runDoctor(argv: string[], cwd: string): number {
  const lines: string[] = [];
  let exitCode: 0 | 2 | 3 = 0;

  try {
    const values = parseOrUsage<{ config: string; changeset?: string; 'skill-cli-range'?: string }>({
      args: argv,
      options: {
        config: { type: 'string', default: 'shipledger.config.json' },
        changeset: { type: 'string' },
        'skill-cli-range': { type: 'string' }
      },
      strict: true
    });

    const { config, configFingerprint, origins } = loadConfig(resolve(cwd, values.config), CLI_VERSION);
    compileAll(config);

    const changeset = values.changeset === undefined
      ? undefined
      : loadChangeset(resolve(cwd, values.changeset));
    if (changeset !== undefined) assertChangesetAgainstConfig(changeset, config);

    lines.push(`shipledger ${CLI_VERSION}`);
    lines.push(`preset: ${config.presetName}@${config.presetVersion}`);
    lines.push(`policy failOn: ${config.policy.failOn.join(', ') || '(none)'}`);
    lines.push(`config fingerprint: ${configFingerprint}`);

    const tag = (o: ConfigOrigin): string => o === 'adopter' ? '[adopter override]' : '[preset]';
    lines.push('');
    lines.push('effective config:');
    lines.push(`  matchers ${tag(origins.matchers)}: ${config.matchers.map((m) => `${m.id} (${m.namespace}, ${m.sources.join('+')}, /${m.pattern}/)`).join(', ')}`);
    lines.push(`  history  ${tag(origins.history)}: ${config.history}`);
    lines.push(`  ignore   ${tag(origins.ignore)}: authors: ${config.ignore.authors.join(', ') || '(none)'}; subjects: ${config.ignore.subjects.join(', ') || '(none)'}`);
    lines.push(`  policy   ${tag(origins.policy)}: failOn: ${config.policy.failOn.join(', ') || '(none)'}`);

    const range = values['skill-cli-range'];
    if (range !== undefined) {
      const result = checkCliRange(range, CLI_VERSION);
      if (!result.ok) {
        exitCode = 3;
        lines.push(`FAIL skill compatibility — cannot interpret required CLI range "${range}"`);
      } else if (!result.compatible) {
        exitCode = 3;
        lines.push(`FAIL skill compatibility — incompatible: the skill requires CLI "${range}" but this is ${CLI_VERSION}. Pin the CLI with npx shipledger@<version>.`);
      } else {
        lines.push(`OK   skill compatibility — CLI ${CLI_VERSION} satisfies "${range}"`);
      }
    }
    lines.push('');

    const rangeByRepo = new Map(
      (changeset?.ranges ?? []).map((r) => [r.repo, r] as const)
    );

    for (const repo of config.repos) {
      try {
        assertUsableRepo(repo.path, repo.name);
        lines.push(`OK   repo ${repo.name} — ${repo.path}`);

        const spec = rangeByRepo.get(repo.name);
        if (spec !== undefined) {
          const includes = spec.include ?? [];
          const dirty = dirtyTree(repo.path, includes);
          const total = dirty.staged.length + dirty.unstaged.length + dirty.untracked.length;
          if (total > 0) {
            const scope = includes.length > 0 ? `under ${includes.join(', ')}` : 'in working tree';
            lines.push(`INFO repo ${repo.name} — ${total} changed file(s) ${scope} (exact base/head SHAs determine reconciliation; these changes are excluded)`);
            for (const f of dirty.staged) lines.push(`       staged: ${f}`);
            for (const f of dirty.unstaged) lines.push(`       unstaged: ${f}`);
            for (const f of dirty.untracked) lines.push(`       untracked: ${f}`);
          }
        }
      } catch (err) {
        exitCode = 3;
        lines.push(`FAIL repo ${repo.name} — ${(err as Error).message}`);
      }
    }

    if (changeset !== undefined) {
      lines.push('');
      for (const repo of config.repos) {
        const spec = rangeByRepo.get(repo.name);
        if (spec === undefined) continue;
        try {
          const resolved = resolveRange(spec, repo.path);
          if (resolved.baseIsAncestorOfHead) {
            lines.push(`OK   range ${spec.repo} ${spec.base}..${spec.head}`);
          } else {
            lines.push(`WARN range ${spec.repo} ${spec.base}..${spec.head} — refs diverge; ${resolved.commitsOnlyInBase} commit(s) reachable from base but not head will not be seen`);
          }
        } catch (err) {
          exitCode = 3;
          lines.push(`FAIL range ${spec.repo} — ${(err as Error).message}`);
        }
      }
    }

    lines.push('');
    lines.push('Note: refs are read locally and never fetched, so upstream state is unknown.');
  } catch (err) {
    const { code, message } = toExitCode(err);
    lines.push(message);
    exitCode = code === 1 ? 3 : code;
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return exitCode;
}
