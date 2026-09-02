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
    if (existsSync(outPath)) {
      throw usageError(`${outPath} already exists. Move it aside or pass a different --out.`);
    }

    const scaffold = {
      version: 1,
      preset: `${preset.name}@${preset.version}`,
      repos: [{ name: 'repo-a', path: '../repo-a' }],
      policy: preset.defaults.policy
    };

    writeAtomic(outPath, `${JSON.stringify(scaffold, null, 2)}\n`);
    process.stdout.write([
      `Wrote ${outPath}.`,
      'Edit "repos" to point at your checkouts — paths resolve relative to this file.',
      `Then run: shipledger doctor --config ${values.out}`,
      ''
    ].join('\n'));
    return 0;
  } catch (err) {
    const { code, message } = toExitCode(err);
    process.stderr.write(`${message}\n`);
    return code;
  }
}
