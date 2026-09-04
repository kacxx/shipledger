import { resolve } from 'node:path';
import { toExitCode, usageError } from '../errors.js';
import { parseOrUsage } from './args.js';
import { loadConfig } from '../config/load.js';
import { assertChangesetAgainstConfig, assertFetchedAtPlausible, loadChangeset } from '../config/changeset.js';
import { compileAll } from '../core/compile.js';
import { assertUsableRepo, resolveRange } from '../git/refs.js';
import { walkRange } from '../git/log.js';
import { reconcile } from '../core/reconcile.js';
import { canonicalStringify } from '../core/canonical.js';
import { writeAtomic } from '../io/atomic.js';
import { CLI_VERSION } from './version.js';
import type { CommitRecord, RangeResult } from '../types.js';

export function runCheck(argv: string[], cwd: string): number {
  try {
    const values = parseOrUsage<{ config: string; changeset?: string; out: string; stable: boolean }>({
      args: argv,
      options: {
        config: { type: 'string', default: 'shipledger.config.json' },
        changeset: { type: 'string' },
        out: { type: 'string', default: 'verified-changeset.json' },
        stable: { type: 'boolean', default: false }
      },
      strict: true
    });

    if (!values.changeset) throw usageError('Missing required --changeset <path>.');

    const { config, configFingerprint } = loadConfig(resolve(cwd, values.config), CLI_VERSION);
    const compiled = compileAll(config);
    const changeset = loadChangeset(resolve(cwd, values.changeset));
    assertFetchedAtPlausible(changeset.source.fetchedAt);
    assertChangesetAgainstConfig(changeset, config);

    const rangeByRepo = new Map(changeset.ranges.map((r) => [r.repo, r]));
    const ranges: RangeResult[] = [];
    const commits: CommitRecord[] = [];

    for (const repo of config.repos) {
      const spec = rangeByRepo.get(repo.name);
      if (spec === undefined) continue;
      assertUsableRepo(repo.path, repo.name);
      const range = resolveRange(spec, repo.path);
      ranges.push(range);
      commits.push(...walkRange(range, repo.path, config.history));
    }

    const verified = reconcile({
      config, compiled, changeset, commits, ranges,
      cliVersion: CLI_VERSION, configFingerprint,
      ...(values.stable ? {} : { now: new Date().toISOString() })
    });

    writeAtomic(resolve(cwd, values.out), `${canonicalStringify(verified)}\n`);
    return verified.verdict === 'pass' ? 0 : 1;
  } catch (err) {
    const { code, message } = toExitCode(err);
    process.stderr.write(`${message}\n`);
    return code;
  }
}
