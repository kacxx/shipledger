#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCheck } from './check.js';
import { runDoctor } from './doctor.js';

function usage(): string {
  return [
    'shipledger <command> [options]',
    '',
    'Commands:',
    '  check    --config <path> --changeset <path> [--out <path>] [--stable]',
    '  doctor   --config <path> [--changeset <path>]',
    '  init     [--preset <name>] [--out <path>]',
    '  render   <report|changelog|release-notes> --input <path> [--notes <path>]',
    ''
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'check':
      return runCheck(rest, process.cwd());
    case 'doctor':
      return runDoctor(rest, process.cwd());
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(usage());
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${usage()}`);
      return 2;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
