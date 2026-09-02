import _Ajv, { type ValidateFunction } from 'ajv';
// CJS interop: ajv ships CJS with `export default Ajv` in types,
// but NodeNext resolution may wrap the default under `.default`.
const Ajv = _Ajv as unknown as typeof _Ajv.default;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { usageError } from '../errors.js';
import type { Changeset, NotesFile, RawConfig, VerifiedChangeset } from '../types.js';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const read = (f: string): object => JSON.parse(readFileSync(join(schemaDir, f), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: true });

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * RFC 3339, checked against the calendar rather than by shape alone: a
 * timestamp is provenance in an audit artifact, so "2026-13-45T99:99:99Z"
 * must not pass. Second 60 is permitted because RFC 3339 allows leap seconds.
 */
ajv.addFormat('date-time', (value: string): boolean => {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number, number, number, number, number, number
  ];
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (MONTH_LENGTHS[month - 1] as number);
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;

  const offset = m[7] as string;
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return false;
  return true;
});

for (const file of ['config', 'changeset', 'verified-changeset', 'notes']) {
  ajv.addSchema(read(`${file}.schema.json`));
}

function get(id: string): ValidateFunction {
  const v = ajv.getSchema(`https://shipledger.dev/schemas/${id}.schema.json`);
  if (!v) throw new Error(`schema ${id} not registered`);
  return v;
}

function run<T>(id: string, value: unknown, label: string): T {
  const validate = get(id);
  if (validate(value)) return value as T;
  const detail = (validate.errors ?? [])
    .map((e) => `  ${e.instancePath || '/'} ${e.message ?? 'is invalid'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`)
    .join('\n');
  throw usageError(`${label} failed schema validation:\n${detail}`);
}

export const validateConfig = (v: unknown): RawConfig => run('config', v, 'config');
export const validateChangeset = (v: unknown): Changeset => run('changeset', v, 'changeset');
export const validateVerified = (v: unknown): VerifiedChangeset => run('verified-changeset', v, 'verified changeset');
export const validateNotes = (v: unknown): NotesFile => run('notes', v, 'notes');
