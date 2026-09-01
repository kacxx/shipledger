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

const ajv = new Ajv({ allErrors: true, strict: false });

ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

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
