import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { toExitCode, usageError } from '../errors.js';
import { parseOrUsage } from './args.js';
import { resolvePreset } from '../config/presets.js';
import { writeAtomic } from '../io/atomic.js';

export function runInit(argv: string[], cwd: string): number {
  try {
    const values = parseOrUsage<{ preset: string; out: string }>({
      args: argv,
      options: {
        preset: { type: 'string', default: 'tracker-keys' },
        out: { type: 'string', default: 'shipledger.config.json' }
      },
      strict: true
    });

    const preset = resolvePreset(values.preset, { allowUnpinned: true });
    const outPath = resolve(cwd, values.out);
    const examplePath = resolve(cwd, 'changeset.example.json');
    for (const path of [outPath, examplePath]) {
      if (existsSync(path)) {
        throw usageError(`${path} already exists. Move it aside or pass a different --out.`);
      }
    }

    // "policy" is deliberately absent: the preset is pinned, so its policy is
    // already fixed, and a copy here would silently go stale against it.
    const scaffold = {
      version: 1,
      preset: `${preset.name}@${preset.version}`,
      repos: [{ name: 'repo-a', path: '../repo-a' }]
    };

    // "pr-ref" is present in every preset, so the example matches whichever
    // one was chosen.
    const changeset = {
      version: 1,
      id: 'example release',
      source: {
        kind: 'manual',
        ref: 'replace with your tracker release or milestone URL',
        fetchedAt: '2026-01-01T00:00:00Z'
      },
      items: [
        {
          id: 'EXAMPLE-1',
          title: 'Replace with a real item, one per thing the release claims',
          type: 'issue',
          status: 'closed',
          tokens: [{ matcher: 'pr-ref', token: '#1', repo: 'repo-a' }]
        }
      ],
      ranges: [{ repo: 'repo-a', base: 'v0.0.0', head: 'HEAD' }]
    };

    writeAtomic(outPath, `${JSON.stringify(scaffold, null, 2)}\n`);
    writeAtomic(examplePath, `${JSON.stringify(changeset, null, 2)}\n`);
    process.stdout.write([
      `Wrote ${outPath} and ${examplePath}.`,
      `Policy comes from the pinned preset ${preset.name}@${preset.version}; "shipledger doctor" prints it.`,
      '',
      'Next:',
      '  1. Edit "repos" in the config — paths resolve relative to that file.',
      `  2. shipledger doctor --config ${values.out}`,
      '  3. Copy changeset.example.json to changeset.json and replace its items and ranges',
      '     with what your tracker claims the release contains.',
      '  4. shipledger check --changeset changeset.json',
      ''
    ].join('\n'));
    return 0;
  } catch (err) {
    const { code, message } = toExitCode(err);
    process.stderr.write(`${message}\n`);
    return code;
  }
}
