import { execFileSync } from 'node:child_process';
import { envError } from '../errors.js';

const GIT_ENV = { GIT_NO_LAZY_FETCH: '1' };

export function gitStatus(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString().trim()
    };
  }
}

export function gitOut(args: string[], cwd: string): string {
  const result = gitStatus(args, cwd);
  if (result.code !== 0) {
    throw envError(`git ${args.join(' ')} failed in ${cwd} (status ${result.code}): ${result.stderr}`);
  }
  return result.stdout;
}
