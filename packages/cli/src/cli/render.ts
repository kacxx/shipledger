import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envError, toExitCode, usageError } from '../errors.js';
import { parseOrUsage } from './args.js';
import { validateNotes, validateVerified } from '../config/validate.js';
import { assertVerifiedSemantics } from '../verify.js';
import { assertNotesCoverFindings } from '../notes.js';
import { renderReport } from '../render/report.js';
import { renderChangelog } from '../render/changelog.js';
import { renderReleaseNotes } from '../render/release-notes.js';
import type { NotesFile } from '../types.js';

const RENDERERS = {
  report: renderReport,
  changelog: renderChangelog,
  'release-notes': renderReleaseNotes
} as const;

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw envError(`Cannot read ${label} at ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw usageError(`${label} at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function runRender(argv: string[], cwd: string): number {
  try {
    const [format, ...rest] = argv;
    if (format === undefined || !(format in RENDERERS)) {
      throw usageError(`Unknown format "${format ?? ''}". Use one of: ${Object.keys(RENDERERS).join(', ')}.`);
    }

    const values = parseOrUsage<{ input: string; notes?: string }>({
      args: rest,
      options: {
        input: { type: 'string', default: 'verified-changeset.json' },
        notes: { type: 'string' }
      },
      strict: true
    });

    const verified = validateVerified(readJson(resolve(cwd, values.input), 'verified changeset'));
    assertVerifiedSemantics(verified);

    let notes: NotesFile | undefined;
    if (values.notes !== undefined) {
      notes = validateNotes(readJson(resolve(cwd, values.notes), 'notes'));
      assertNotesCoverFindings(notes, verified);
    }

    process.stdout.write(RENDERERS[format as keyof typeof RENDERERS](verified, notes));
    return 0;
  } catch (err) {
    const { code, message } = toExitCode(err);
    process.stderr.write(`${message}\n`);
    return code;
  }
}
