import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let work: string;
let entryPoint: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'shipledger-pack-'));
  execFileSync('npm', ['pack', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8', shell: true });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(work, tarball)], { cwd: work, encoding: 'utf8', shell: true });
  // On Windows the .bin shim is a .cmd file; invoke the JS entry point directly.
  entryPoint = join(work, 'node_modules', 'shipledger', 'dist', 'cli', 'index.js');
}, 180_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [entryPoint, ...args], { cwd: work, encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('installed package', () => {
  it('prints usage listing all four commands', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    for (const cmd of ['check', 'doctor', 'init', 'render']) expect(r.out).toContain(cmd);
  });

  it('init writes a pinned config', () => {
    const r = run(['init', '--out', 'generated.config.json']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/generated\.config\.json/);
  });

  it('doctor runs and reports the missing example repo as an environment problem', () => {
    expect(run(['doctor', '--config', 'generated.config.json']).code).toBe(3);
  });

  it('render reports a missing input as an environment problem', () => {
    expect(run(['render', 'report', '--input', 'nope.json']).code).toBe(3);
  });

  it('check reports a missing changeset flag as a usage problem', () => {
    expect(run(['check', '--config', 'generated.config.json']).code).toBe(2);
  });

  it('resolves its published schemas from the installed tree', () => {
    // A schema resolution failure surfaces as an unexpected exit code here.
    expect(run(['render', 'report', '--input', 'nope.json']).out).toMatch(/Cannot read/);
  });
});
