import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const FIXED_DATE = '2026-01-01T00:00:00+0000';

export interface FixtureRepo {
  path: string;
  commit(subject: string, opts?: { body?: string; author?: string; file?: string }): string;
  branch(name: string): void;
  checkout(name: string): void;
  tag(name: string): void;
  annotatedTag(name: string, message: string): void;
  moveTag(name: string): void;
  mergeNoFf(branch: string, subject: string): string;
  rebaseOnto(branch: string): void;
  head(): string;
  run(args: string[]): string;
  cleanup(): void;
}

export function makeRepo(): FixtureRepo {
  const path = mkdtempSync(join(tmpdir(), 'shipledger-'));
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, {
      cwd: path, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, ...env }
    }).trim();

  run(['init', '-q']);
  try { run(['checkout', '-q', '-b', 'main']); } catch { /* already on main */ }
  run(['config', 'user.name', 'Fixture']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['config', 'commit.gpgsign', 'false']);

  let n = 0;
  return {
    path,
    run,
    commit(subject, opts = {}) {
      n += 1;
      const file = opts.file ?? `f${n}.txt`;
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), `${subject}\n`);
      run(['add', file]);
      const args = ['commit', '-q', '-m', subject];
      if (opts.body !== undefined) args.push('-m', opts.body);
      const env = opts.author ? { GIT_AUTHOR_NAME: opts.author, GIT_AUTHOR_EMAIL: 'x@example.invalid' } : {};
      run(args, env);
      return run(['rev-parse', 'HEAD']);
    },
    branch(name) { run(['branch', name]); },
    checkout(name) { run(['checkout', '-q', name]); },
    tag(name) { run(['tag', name]); },
    annotatedTag(name, message) { run(['tag', '-a', name, '-m', message]); },
    moveTag(name) { run(['tag', '-f', name]); },
    mergeNoFf(branch, subject) {
      run(['merge', '-q', '--no-ff', '-m', subject, branch]);
      return run(['rev-parse', 'HEAD']);
    },
    rebaseOnto(branch) { run(['rebase', '-q', branch]); },
    head() { return run(['rev-parse', 'HEAD']); },
    cleanup() { rmSync(path, { recursive: true, force: true }); }
  };
}
