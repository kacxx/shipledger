# shipledger Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shipledger CLI — a repository-read-only tool that reconciles a claimed changeset against local git history across one or more repositories and renders release artifacts from the verified result.

**Architecture:** Three layers. `core` is pure functions with no I/O (token extraction, reference resolution, findings, verdict). `git` is the only module that shells out, and it only reads. `cli` does argument parsing, file I/O, exit codes, and rendering. A separate `plugin/` directory holds the agent skill that produces `changeset.json` and triages findings; the CLI never talks to a tracker or a network.

**Tech Stack:** Node 20+, TypeScript (strict), npm workspaces, vitest, ajv for JSON Schema validation, `node:util` `parseArgs` for CLI args, `node:child_process` `execFileSync` for git. One runtime dependency (ajv) by design.

**Reference spec:** `docs/superpowers/specs/2026-09-01-shipledger-design.md` (revised 2026-09-01 17:13). Read it before starting. This plan was regenerated against that revision. Where they disagree, the spec wins — raise the conflict rather than choosing.

## Global Constraints

- Node engine floor: `>=20.10`. npm package name `shipledger`, binary `shipledger`, licence MIT.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `module`/`moduleResolution` `NodeNext`, ESM.
- Exactly one runtime dependency: `ajv`.
- The CLI is **repository-read-only**: never fetch, checkout, commit, or make a network call. Git is invoked via `execFileSync` with an explicit argument array — never a shell string.
- Exit codes are a public API. `0` pass; `1` policy violation; `2` JSON syntax, schema, cross-file consistency, duplicate identity, invalid regex; `3` missing files, permissions, output-write failure, unusable repository, unexpected git failure. **One shared typed error mapping** — the same failure class must never get two codes.
- Finding names, verbatim: `no-reference`, `unknown-reference`, `item-without-commits`, `range-divergence`.
- Matcher `sources` are `subject` and `body` only. No `branch` source, ever.
- A matcher `pattern` has exactly one capture group. The token is **capture group 1 verbatim**, then `normalize` is applied.
- References are `(matcher, scopeKey, token)` tuples. `scopeKey` is the literal `global` for global matchers, the commit's repo name for repo-scoped ones. Repeated captures of one tuple collapse into a single reference whose `sources` array lists every field it appeared in.
- `resolvesTo` is an **ordered array** of matching item ids in changeset order. Empty array means unresolved.
- An item's `id` is **opaque identity and never a matchable token.** Every matchable identifier lives in `items[].tokens`. Every item has at least one token.
- `preset` is **required** in config and must be pinned (`name@version`) for `check` and `doctor`. `init` accepts a bare name but writes the pinned form.
- Preset merge: a present top-level config key **replaces** the preset value entirely — objects and arrays included, never deep-merged. An override object must be complete per its schema.
- `ignore.authors` are **exact git author names** (`%an`), compared by string equality. `ignore.subjects` are regular expressions.
- All matcher and ignore expressions are compiled and validated **before any repository is opened**.
- Semantic identities are unique: repo names, matcher ids, item ids, range repos. V1 permits **at most one range per configured repo**; multiple paths go in that range's `include`.
- Ranges are resolved to SHAs once, then **walked as SHAs** — never as mutable ref names.
- Repositories are walked in **config order**, not changeset order, so the `commits` array is deterministic regardless of how the agent ordered `ranges`.
- `package-lock.json` is committed. `npm ci` in CI and the packaging smoke test both depend on it existing in a clean clone.
- `notes.json` sections are **arrays of structured entries**, not string-keyed maps. A matcher id or token may contain any character, so a delimited composite key can collide.
- Supplying `--notes` demands **complete coverage**: exactly one entry per finding, no entries for findings that do not exist, no duplicates, and every `note` containing a non-whitespace character. Omitting `--notes` is legitimate and produces an artifact explicitly marked untriaged.
- Only git exit status `1` from `merge-base --is-ancestor` means "not an ancestor". Any other non-zero status is an environment failure (exit 3).
- Git output parsing is lossless: NUL-delimited fields, and matcher source text (`subject`, `body`) is never trimmed.
- Four published JSON Schemas with `additionalProperties: false`: config, changeset, verified changeset, notes. Malformed timestamps are schema errors. `render` validates the verified artifact and notes before producing output.
- Determinism: repos in config order, commits in git order within a range, items in changeset order, all JSON object keys sorted. `generatedAt` present normally, suppressed under `--stable`.
- Fingerprint: SHA-256 over canonical JSON of the fully resolved config — **every** field including `version` — plus CLI version and resolved preset version. Repo paths enter as the original config strings, never absolutised.

## Decisions to settle before implementation starts

An implementing agent must not reopen any of these. They are recorded here so the spec and plan stay in step, and so nothing is decided mid-task.

### 1. The end-to-end fixture — settled: synthetic

The spec's Testing section requires a bundle "at fixed refs with **no placeholders**", asserting "exact expected links, findings, SHAs, and byte-stable output", while its Repo layout section described `fixtures/` as holding a "git bundle of the pinned public repo". Those could not both hold: exact-SHA assertions against a third-party repository can only be pasted from observation, which tests nothing.

**Resolved in favour of a synthetic bundle**, built by a committed script that fixes author, email, dates, and content so every SHA is deterministic. The spec has been amended accordingly — Repo layout now reads `fixtures/ — deterministic git bundle built by fixtures/make-bundle.sh, plus core test fixtures`, and the Testing rationale states why the fixture is synthetic. Task 16 implements exactly that.

### 2. Spec amendments — settled and already applied to the spec

Four contract changes came out of review. All are now recorded in the spec, so the spec remains the contract and this plan implements it rather than diverging from it. Listed here so a reviewer can check both documents against one summary.

| Contract point | Spec section | Behaviour |
| --- | --- | --- |
| `github-oss@1` policy | `shipledger.config.json`, Audience | `failOn: ["unknown-reference", "range-divergence"]`. `no-reference` and `item-without-commits` are emitted and rendered but not fatal, because a drive-by fix with no issue and a milestone issue closed without code are both normal open-source hygiene. |
| Notes shape | `notes.json` | Four sections, each an array of structured records carrying `repo`/`sha`, `repo`/`sha`/`matcher`/`token`, `item`, or `repo`. Not a keyed map: matcher ids and tokens are unconstrained text, so any delimited composite key can be forged into a collision. |
| Notes coverage | `notes.json`, The skill | Omitting `--notes` renders an explicitly untriaged artifact. Supplying `--notes` requires exactly one record per finding, with no extras, no duplicates, and no whitespace-only sentences. Identical sentences may be reused freely. |
| Artifact validation | `notes.json`, Testing | `render` re-checks the verified artifact's internal consistency, not just its schema, so a hand-edited file whose summary contradicts its own commits is rejected. |

---

## File Structure

All paths relative to repo root. `packages/cli` is the published npm package.

| Path | Responsibility |
| --- | --- |
| `package.json` | Workspace root; scripts fan out to `packages/cli` |
| `packages/cli/package.json` | Published package metadata, bin, deps |
| `packages/cli/tsconfig.json`, `vitest.config.ts` | Strict TS and test config |
| `packages/cli/src/types.ts` | Every shared type. No logic. |
| `packages/cli/src/errors.ts` | `CliError` carrying the exit code; the single error mapping |
| `packages/cli/src/core/canonical.ts` | Canonical JSON stringify + SHA-256 fingerprint |
| `packages/cli/src/core/compile.ts` | Compile and validate matchers and ignore rules (pre-git) |
| `packages/cli/src/core/tokens.ts` | Extract deduplicated references from a commit |
| `packages/cli/src/core/index-items.ts` | Item token index; resolve references to id arrays |
| `packages/cli/src/core/findings.ts` | Ignore matching, finding derivation, summary, verdict |
| `packages/cli/src/core/reconcile.ts` | Orchestrates core into a `VerifiedChangeset` |
| `packages/cli/src/config/presets.ts` | Pinned preset registry |
| `packages/cli/src/config/validate.ts` | ajv validators for the four schemas |
| `packages/cli/src/config/load.ts` | Read, validate, merge, path-resolve, fingerprint, identity checks |
| `packages/cli/src/config/changeset.ts` | Load changeset + cross-file semantic validation |
| `packages/cli/schemas/*.schema.json` | Four published schemas |
| `packages/cli/src/git/exec.ts` | The single `execFileSync` wrapper with strict status handling |
| `packages/cli/src/git/refs.ts` | Repo usability, ref resolution, ancestry, counts |
| `packages/cli/src/git/log.ts` | SHA-range walk → `CommitRecord[]`, NUL-delimited |
| `packages/cli/src/io/atomic.ts` | Atomic file write |
| `packages/cli/src/cli/version.ts` | `CLI_VERSION` |
| `packages/cli/src/cli/args.ts` | `parseOrUsage` — the single argument-parsing-failure to exit-2 mapping |
| `packages/cli/src/cli/index.ts` | Command dispatch and usage text |
| `packages/cli/src/cli/{check,doctor,init,render}.ts` | The four commands |
| `packages/cli/src/render/{report,changelog,release-notes}.ts` | The three renderers |
| `packages/cli/src/notes.ts` | Note lookup construction and exact coverage checking |
| `packages/cli/src/verify.ts` | Semantic validation of a verified artifact read from disk |
| `packages/cli/test/render/__golden__/*.txt` | Reviewed byte-exact renderer output |
| `packages/cli/test/helpers/repo.ts` | Fixture git repo builder (temp dirs, fixed dates) |
| `fixtures/make-bundle.sh`, `fixtures/deterministic.bundle`, `fixtures/expected.json` | Deterministic e2e fixture |
| `examples/{tracker-keys,github-oss}/` | One config + changeset per preset |
| `plugin/` | Agent skill, templates, manifest, pinned CLI range |
| `.github/workflows/ci.yml` | Typecheck, test, build, pack smoke on Node 20 and 22 |

---

### Task 1: Scaffold, shared types, canonical JSON, error mapping

**Files:**
- Create: `package.json`, `.gitignore`, `packages/cli/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/cli/src/types.ts`, `packages/cli/src/errors.ts`, `packages/cli/src/core/canonical.ts`
- Test: `packages/cli/test/core/canonical.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `src/types.ts`; `canonicalStringify(value: unknown): string`; `fingerprint(value: unknown): string` → `sha256:<hex>`; `class CliError extends Error { readonly exitCode: 1 | 2 | 3 }`; `usageError(msg)`, `envError(msg)`, `policyExit()` helpers.

- [ ] **Step 1: Create the workspace files**

`package.json`:

```json
{
  "name": "shipledger-workspace",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm test --workspace shipledger",
    "typecheck": "npm run typecheck --workspace shipledger",
    "build": "npm run build --workspace shipledger"
  }
}
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
*.tgz
.DS_Store
```

`packages/cli/package.json`:

```json
{
  "name": "shipledger",
  "version": "0.1.0",
  "description": "Reconcile a claimed release changeset against local git history",
  "license": "MIT",
  "type": "module",
  "bin": { "shipledger": "./dist/cli/index.js" },
  "engines": { "node": ">=20.10" },
  "files": ["dist", "schemas"],
  "dependencies": { "ajv": "^8.17.1" },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/cli/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] }
});
```

Run: `npm install`
Expected: lockfile written, no errors.

- [ ] **Step 2: Write `src/types.ts`**

Single source of truth. Later tasks reference these names exactly.

```ts
export type Namespace = 'global' | 'repo';
export type Normalize = 'upper' | 'lower' | 'none';
export type HistoryMode = 'first-parent' | 'all';
export type CommitSource = 'subject' | 'body';

export type FindingName =
  | 'no-reference'
  | 'unknown-reference'
  | 'item-without-commits'
  | 'range-divergence';

export interface MatcherConfig {
  id: string;
  sources: CommitSource[];
  pattern: string;
  namespace: Namespace;
  normalize: Normalize;
}

export interface RepoConfig { name: string; path: string }

/** `authors` are exact `%an` values. `subjects` are regular expressions. */
export interface IgnoreConfig { authors: string[]; subjects: string[] }

export interface PolicyConfig { failOn: FindingName[] }

export interface RawConfig {
  version: 1;
  /** Required. Must be pinned (`name@version`) for check and doctor. */
  preset: string;
  repos: RepoConfig[];
  matchers?: MatcherConfig[];
  history?: HistoryMode;
  ignore?: IgnoreConfig;
  policy?: PolicyConfig;
}

export interface ResolvedConfig {
  version: 1;
  presetName: string;
  presetVersion: number;
  /** `path` is absolute; `sourcePath` is the original config string. */
  repos: Array<{ name: string; path: string; sourcePath: string }>;
  matchers: MatcherConfig[];
  history: HistoryMode;
  ignore: IgnoreConfig;
  policy: PolicyConfig;
}

export interface ItemToken { matcher: string; token: string; repo?: string }

export interface ChangesetItem {
  id: string;
  title: string;
  type: string;
  status: string;
  url?: string;
  /** At least one. The `id` is never implicitly matchable. */
  tokens: ItemToken[];
}

export interface RangeSpec { repo: string; base: string; head: string; include?: string[] }
export interface ChangesetSource { kind: string; ref: string; fetchedAt: string }

export interface Changeset {
  version: 1;
  id: string;
  source: ChangesetSource;
  items: ChangesetItem[];
  ranges: RangeSpec[];
}

export interface CommitRecord {
  repo: string;
  sha: string;
  subject: string;
  body: string;
  /** Exact `%an`. */
  author: string;
  committedAt: string;
}

export interface Reference {
  matcher: string;
  token: string;
  namespace: Namespace;
  /** Every field this tuple appeared in, in `subject`, `body` order. */
  sources: CommitSource[];
  /** Matching item ids in changeset order. Empty means unresolved. */
  resolvesTo: string[];
}

export interface CommitResult {
  repo: string;
  sha: string;
  subject: string;
  body: string;
  author: string;
  committedAt: string;
  ignored: { rule: string } | null;
  references: Reference[];
  findings: FindingName[];
}

export interface RangeResult {
  repo: string;
  base: string;
  baseSha: string;
  head: string;
  headSha: string;
  include: string[];
  mergeBase: string | null;
  baseIsAncestorOfHead: boolean;
  commitsOnlyInBase: number;
  findings: FindingName[];
}

export interface ItemResult {
  id: string;
  title: string;
  type: string;
  status: string;
  commits: Array<{ repo: string; sha: string }>;
  findings: FindingName[];
}

export interface Summary {
  items: number;
  itemsLinked: number;
  commits: number;
  commitsIgnored: number;
  noReference: number;
  unknownReference: number;
  itemsWithoutCommits: number;
  rangeDivergence: number;
}

export interface Violation { finding: FindingName; count: number }

export interface VerifiedChangeset {
  version: 1;
  generatedAt?: string;
  cliVersion: string;
  preset: string;
  history: HistoryMode;
  configFingerprint: string;
  changeset: { id: string; source: ChangesetSource; items: ChangesetItem[] };
  ranges: RangeResult[];
  commits: CommitResult[];
  items: ItemResult[];
  summary: Summary;
  verdict: 'pass' | 'fail';
  violations: Violation[];
}

export const NO_REFERENCE_CLASSIFICATIONS = [
  'revert', 'dependency-bump', 'hotfix-already-released', 'tooling-or-ci', 'process-miss'
] as const;
export const UNKNOWN_REFERENCE_CLASSIFICATIONS = [
  'other-release', 'typo', 'wrongly-omitted'
] as const;
export const ITEM_CLASSIFICATIONS = [
  'configuration-only', 'documentation-only', 'landed-earlier', 'wrongly-tagged', 'not-done'
] as const;
export const RANGE_CLASSIFICATIONS = ['expected-divergence', 'wrong-base'] as const;

export type NoReferenceClassification = (typeof NO_REFERENCE_CLASSIFICATIONS)[number];
export type UnknownReferenceClassification = (typeof UNKNOWN_REFERENCE_CLASSIFICATIONS)[number];
export type ItemClassification = (typeof ITEM_CLASSIFICATIONS)[number];
export type RangeClassification = (typeof RANGE_CLASSIFICATIONS)[number];

/**
 * Note entries are structured records rather than string-keyed map entries.
 * Matcher ids and tokens are unconstrained text, so any delimited composite key
 * (`repo:sha:matcher:token`) can be forged into a collision. `note` must contain
 * a non-whitespace character; identical sentences may be reused across entries.
 */
export interface NoReferenceNote {
  repo: string;
  sha: string;
  classification: NoReferenceClassification;
  note: string;
}

export interface UnknownReferenceNote {
  repo: string;
  sha: string;
  matcher: string;
  token: string;
  classification: UnknownReferenceClassification;
  note: string;
}

export interface ItemNote {
  item: string;
  classification: ItemClassification;
  note: string;
}

export interface RangeNote {
  repo: string;
  classification: RangeClassification;
  note: string;
}

export interface NotesFile {
  version: 1;
  noReference?: NoReferenceNote[];
  unknownReference?: UnknownReferenceNote[];
  items?: ItemNote[];
  ranges?: RangeNote[];
}
```

- [ ] **Step 3: Write `src/errors.ts`**

```ts
export class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 | 3) {
    super(message);
    this.name = 'CliError';
  }
}

/** Schema, syntax, cross-file consistency, duplicate identity, invalid regex. */
export function usageError(message: string): CliError {
  return new CliError(message, 2);
}

/** Missing file, permissions, write failure, unusable repo, unexpected git failure. */
export function envError(message: string): CliError {
  return new CliError(message, 3);
}

/** The single mapping every command uses. Unknown errors are exit 2. */
export function toExitCode(err: unknown): { code: 1 | 2 | 3; message: string } {
  if (err instanceof CliError) return { code: err.exitCode, message: err.message };
  return { code: 2, message: (err as Error).message };
}
```

- [ ] **Step 4: Write the failing canonical test, then implement**

`packages/cli/test/core/canonical.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalStringify, fingerprint } from '../../src/core/canonical.js';

describe('canonicalStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined-valued keys', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('is insensitive to key insertion order', () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it('escapes control characters so a commit body round-trips', () => {
    const parsed = JSON.parse(canonicalStringify({ body: 'line\nnext\ttab' }));
    expect(parsed.body).toBe('line\nnext\ttab');
  });
});

describe('fingerprint', () => {
  it('returns a prefixed sha256 hex digest', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('agrees for values differing only in key order', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('differs when any value changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
```

Run: `npm test --workspace shipledger`
Expected: FAIL — cannot resolve `src/core/canonical.js`.

`packages/cli/src/core/canonical.ts`:

```ts
import { createHash } from 'node:crypto';

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);

  return `{${entries.join(',')}}`;
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}
```

Run: `npm test --workspace shipledger && npm run typecheck --workspace shipledger`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

The lockfile is staged deliberately: CI runs `npm ci` and the packaging smoke test installs a tarball, and neither works in a clean clone without it.

```bash
git add package.json package-lock.json .gitignore packages/cli
git commit -m "feat: workspace scaffold, shared types, canonical JSON, error mapping"
```

Run: `git status --short` — expected: clean. If `package-lock.json` still shows as untracked, stage it before continuing; every later `npm ci` depends on it.

---

### Task 2: Four published JSON Schemas and validators

**Files:**
- Create: `packages/cli/schemas/{config,changeset,verified-changeset,notes}.schema.json`
- Create: `packages/cli/src/config/validate.ts`
- Test: `packages/cli/test/config/validate.test.ts`

**Interfaces:**
- Consumes: `usageError`.
- Produces: `validateConfig(v: unknown): RawConfig`, `validateChangeset(v: unknown): Changeset`, `validateVerified(v: unknown): VerifiedChangeset`, `validateNotes(v: unknown): NotesFile`. Each throws exit-2 `CliError` listing every error.

- [ ] **Step 1: Write `config.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://shipledger.dev/schemas/config.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "preset", "repos"],
  "properties": {
    "version": { "const": 1 },
    "preset": { "type": "string", "pattern": "^[a-z0-9-]+(@[0-9]+)?$" },
    "repos": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "path"],
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "path": { "type": "string", "minLength": 1 }
        }
      }
    },
    "matchers": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "sources", "pattern", "namespace", "normalize"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "sources": { "type": "array", "minItems": 1, "items": { "enum": ["subject", "body"] } },
          "pattern": { "type": "string", "minLength": 1 },
          "namespace": { "enum": ["global", "repo"] },
          "normalize": { "enum": ["upper", "lower", "none"] }
        }
      }
    },
    "history": { "enum": ["first-parent", "all"] },
    "ignore": {
      "type": "object",
      "additionalProperties": false,
      "required": ["authors", "subjects"],
      "properties": {
        "authors": { "type": "array", "items": { "type": "string" } },
        "subjects": { "type": "array", "items": { "type": "string" } }
      }
    },
    "policy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["failOn"],
      "properties": {
        "failOn": {
          "type": "array",
          "items": { "enum": ["no-reference", "unknown-reference", "item-without-commits", "range-divergence"] }
        }
      }
    }
  }
}
```

`ignore` requires both keys because a present key replaces the preset value entirely — a partial `ignore` object would silently drop the other list, so the schema forbids writing one.

- [ ] **Step 2: Write `changeset.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://shipledger.dev/schemas/changeset.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "id", "source", "items", "ranges"],
  "properties": {
    "version": { "const": 1 },
    "id": { "type": "string", "minLength": 1 },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "ref", "fetchedAt"],
      "properties": {
        "kind": { "type": "string", "minLength": 1 },
        "ref": { "type": "string", "minLength": 1 },
        "fetchedAt": { "type": "string", "format": "date-time" }
      }
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "type", "status", "tokens"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "title": { "type": "string" },
          "type": { "type": "string" },
          "status": { "type": "string" },
          "url": { "type": "string" },
          "tokens": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["matcher", "token"],
              "properties": {
                "matcher": { "type": "string", "minLength": 1 },
                "token": { "type": "string", "minLength": 1 },
                "repo": { "type": "string", "minLength": 1 }
              }
            }
          }
        }
      }
    },
    "ranges": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["repo", "base", "head"],
        "properties": {
          "repo": { "type": "string", "minLength": 1 },
          "base": { "type": "string", "minLength": 1 },
          "head": { "type": "string", "minLength": 1 },
          "include": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Write `verified-changeset.schema.json` and `notes.schema.json`**

`verified-changeset.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://shipledger.dev/schemas/verified-changeset.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "cliVersion", "preset", "history", "configFingerprint", "changeset", "ranges", "commits", "items", "summary", "verdict", "violations"],
  "properties": {
    "version": { "const": 1 },
    "generatedAt": { "type": "string", "format": "date-time" },
    "cliVersion": { "type": "string", "minLength": 1 },
    "preset": { "type": "string", "pattern": "^[a-z0-9-]+@[0-9]+$" },
    "history": { "enum": ["first-parent", "all"] },
    "configFingerprint": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
    "changeset": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "source", "items"],
      "properties": {
        "id": { "type": "string" },
        "source": { "$ref": "https://shipledger.dev/schemas/changeset.schema.json#/properties/source" },
        "items": { "$ref": "https://shipledger.dev/schemas/changeset.schema.json#/properties/items" }
      }
    },
    "ranges": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["repo", "base", "baseSha", "head", "headSha", "include", "mergeBase", "baseIsAncestorOfHead", "commitsOnlyInBase", "findings"],
        "properties": {
          "repo": { "type": "string" },
          "base": { "type": "string" },
          "baseSha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
          "head": { "type": "string" },
          "headSha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
          "include": { "type": "array", "items": { "type": "string" } },
          "mergeBase": { "type": ["string", "null"] },
          "baseIsAncestorOfHead": { "type": "boolean" },
          "commitsOnlyInBase": { "type": "integer", "minimum": 0 },
          "findings": { "type": "array", "items": { "enum": ["range-divergence"] } }
        }
      }
    },
    "commits": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["repo", "sha", "subject", "body", "author", "committedAt", "ignored", "references", "findings"],
        "properties": {
          "repo": { "type": "string" },
          "sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
          "subject": { "type": "string" },
          "body": { "type": "string" },
          "author": { "type": "string" },
          "committedAt": { "type": "string" },
          "ignored": {
            "type": ["object", "null"],
            "additionalProperties": false,
            "required": ["rule"],
            "properties": { "rule": { "type": "string" } }
          },
          "references": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["matcher", "token", "namespace", "sources", "resolvesTo"],
              "properties": {
                "matcher": { "type": "string" },
                "token": { "type": "string" },
                "namespace": { "enum": ["global", "repo"] },
                "sources": { "type": "array", "minItems": 1, "items": { "enum": ["subject", "body"] } },
                "resolvesTo": { "type": "array", "items": { "type": "string" } }
              }
            }
          },
          "findings": { "type": "array", "items": { "enum": ["no-reference", "unknown-reference"] } }
        }
      }
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "type", "status", "commits", "findings"],
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "type": { "type": "string" },
          "status": { "type": "string" },
          "commits": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["repo", "sha"],
              "properties": { "repo": { "type": "string" }, "sha": { "type": "string" } }
            }
          },
          "findings": { "type": "array", "items": { "enum": ["item-without-commits"] } }
        }
      }
    },
    "summary": {
      "type": "object",
      "additionalProperties": false,
      "required": ["items", "itemsLinked", "commits", "commitsIgnored", "noReference", "unknownReference", "itemsWithoutCommits", "rangeDivergence"],
      "properties": {
        "items": { "type": "integer" },
        "itemsLinked": { "type": "integer" },
        "commits": { "type": "integer" },
        "commitsIgnored": { "type": "integer" },
        "noReference": { "type": "integer" },
        "unknownReference": { "type": "integer" },
        "itemsWithoutCommits": { "type": "integer" },
        "rangeDivergence": { "type": "integer" }
      }
    },
    "verdict": { "enum": ["pass", "fail"] },
    "violations": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["finding", "count"],
        "properties": {
          "finding": { "enum": ["no-reference", "unknown-reference", "item-without-commits", "range-divergence"] },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    }
  }
}
```

`notes.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://shipledger.dev/schemas/notes.schema.json",
  "definitions": {
    "note": { "type": "string", "pattern": "\\S" },
    "sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
  },
  "type": "object",
  "additionalProperties": false,
  "required": ["version"],
  "properties": {
    "version": { "const": 1 },
    "noReference": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["repo", "sha", "classification", "note"],
        "properties": {
          "repo": { "type": "string", "minLength": 1 },
          "sha": { "$ref": "#/definitions/sha" },
          "classification": { "enum": ["revert", "dependency-bump", "hotfix-already-released", "tooling-or-ci", "process-miss"] },
          "note": { "$ref": "#/definitions/note" }
        }
      }
    },
    "unknownReference": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["repo", "sha", "matcher", "token", "classification", "note"],
        "properties": {
          "repo": { "type": "string", "minLength": 1 },
          "sha": { "$ref": "#/definitions/sha" },
          "matcher": { "type": "string", "minLength": 1 },
          "token": { "type": "string", "minLength": 1 },
          "classification": { "enum": ["other-release", "typo", "wrongly-omitted"] },
          "note": { "$ref": "#/definitions/note" }
        }
      }
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["item", "classification", "note"],
        "properties": {
          "item": { "type": "string", "minLength": 1 },
          "classification": { "enum": ["configuration-only", "documentation-only", "landed-earlier", "wrongly-tagged", "not-done"] },
          "note": { "$ref": "#/definitions/note" }
        }
      }
    },
    "ranges": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["repo", "classification", "note"],
        "properties": {
          "repo": { "type": "string", "minLength": 1 },
          "classification": { "enum": ["expected-divergence", "wrong-base"] },
          "note": { "$ref": "#/definitions/note" }
        }
      }
    }
  }
}
```

`"pattern": "\\S"` rather than `minLength: 1` is what rejects a whitespace-only sentence at the schema layer.

- [ ] **Step 4: Write the failing test, then implement the validators**

`packages/cli/test/config/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateConfig, validateChangeset, validateNotes } from '../../src/config/validate.js';
import { CliError } from '../../src/errors.js';

const config = { version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../repo-a' }] };

const changeset = {
  version: 1, id: 'release 1.4.0',
  source: { kind: 'github-milestone', ref: 'https://example.invalid/m/7', fetchedAt: '2026-09-01T01:00:00Z' },
  items: [], ranges: [{ repo: 'repo-a', base: 'v1.3.0', head: 'v1.4.0' }]
};

const item = (over: Record<string, unknown> = {}) => ({
  id: 'PROJ-42', title: 't', type: 'story', status: 'done',
  tokens: [{ matcher: 'ticket-key', token: 'PROJ-42' }], ...over
});

describe('validateConfig', () => {
  it('accepts a minimal config', () => {
    expect(validateConfig(config).repos[0]?.name).toBe('repo-a');
  });

  it('requires preset', () => {
    const { preset, ...rest } = config;
    expect(() => validateConfig(rest)).toThrow(/preset/);
  });

  it('rejects an unknown top-level key', () => {
    expect(() => validateConfig({ ...config, failOn: [] })).toThrow(CliError);
  });

  it('rejects an unknown finding name in policy.failOn', () => {
    expect(() => validateConfig({ ...config, policy: { failOn: ['no-refernce'] } })).toThrow(/failOn/);
  });

  it('rejects a partial ignore object, since a present key replaces the preset value', () => {
    expect(() => validateConfig({ ...config, ignore: { authors: ['x'] } })).toThrow(/subjects/);
  });

  it('reports exit code 2', () => {
    try {
      validateConfig({});
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });
});

describe('validateChangeset', () => {
  it('accepts a minimal changeset', () => {
    expect(validateChangeset(changeset).ranges).toHaveLength(1);
  });

  it('rejects an item with no tokens', () => {
    expect(() => validateChangeset({ ...changeset, items: [item({ tokens: [] })] })).toThrow(/tokens/);
  });

  it('rejects an item missing tokens entirely', () => {
    const { tokens, ...noTokens } = item();
    expect(() => validateChangeset({ ...changeset, items: [noTokens] })).toThrow(/tokens/);
  });

  it('rejects a bare-string token', () => {
    expect(() => validateChangeset({ ...changeset, items: [item({ tokens: ['#123'] })] })).toThrow(CliError);
  });

  it('rejects a malformed fetchedAt', () => {
    expect(() => validateChangeset({ ...changeset, source: { kind: 'k', ref: 'r', fetchedAt: 'yesterday' } })).toThrow(/fetchedAt/);
  });
});

describe('validateNotes', () => {
  const sha = 'a'.repeat(40);

  it('accepts structured entries with fixed-vocabulary classifications', () => {
    const notes = {
      version: 1,
      noReference: [{ repo: 'repo-a', sha, classification: 'revert', note: 'reverted in 1.3' }]
    };
    expect(validateNotes(notes).noReference?.[0]?.classification).toBe('revert');
  });

  it('accepts a reference note carrying its full tuple', () => {
    const notes = {
      version: 1,
      unknownReference: [{ repo: 'repo-a', sha, matcher: 'ticket-key', token: 'PROJ-9', classification: 'typo', note: 'meant PROJ-1' }]
    };
    expect(validateNotes(notes).unknownReference?.[0]?.token).toBe('PROJ-9');
  });

  it('rejects a classification outside the vocabulary', () => {
    const notes = { version: 1, noReference: [{ repo: 'r', sha, classification: 'meh', note: 'x' }] };
    expect(() => validateNotes(notes)).toThrow(/classification/);
  });

  it('rejects an empty note', () => {
    expect(() => validateNotes({ version: 1, items: [{ item: 'PROJ-1', classification: 'not-done', note: '' }] })).toThrow(/note/);
  });

  it('rejects a whitespace-only note', () => {
    expect(() => validateNotes({ version: 1, items: [{ item: 'PROJ-1', classification: 'not-done', note: '   \t' }] })).toThrow(/note/);
  });

  it('rejects a missing note', () => {
    expect(() => validateNotes({ version: 1, items: [{ item: 'PROJ-1', classification: 'not-done' }] })).toThrow(/note/);
  });

  it('rejects the old map-keyed shape outright', () => {
    expect(() => validateNotes({ version: 1, items: { 'PROJ-1': { classification: 'not-done', note: 'x' } } })).toThrow(CliError);
  });

  it('permits two entries reusing the same sentence', () => {
    const notes = {
      version: 1,
      noReference: [
        { repo: 'r', sha: 'a'.repeat(40), classification: 'dependency-bump', note: 'routine bump' },
        { repo: 'r', sha: 'b'.repeat(40), classification: 'dependency-bump', note: 'routine bump' }
      ]
    };
    expect(validateNotes(notes).noReference).toHaveLength(2);
  });
});
```

Run: `npm test --workspace shipledger -- validate`
Expected: FAIL — module not found.

`packages/cli/src/config/validate.ts`:

```ts
import Ajv, { type ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { usageError } from '../errors.js';
import type { Changeset, NotesFile, RawConfig, VerifiedChangeset } from '../types.js';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const read = (f: string): object => JSON.parse(readFileSync(join(schemaDir, f), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });

// Registered before the schemas, so `format: date-time` is enforced rather than
// ignored. Inline rather than pulling in ajv-formats as a second dependency.
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
```

Format registration must precede `addSchema`, otherwise ajv compiles `fetchedAt` with an unknown format and silently accepts `"yesterday"` — which is exactly what the malformed-timestamp test catches.

- [ ] **Step 5: Run tests, verify schemas resolve from `dist`, commit**

Run: `npm test --workspace shipledger -- validate && npm run build --workspace shipledger && node -e "const {validateConfig}=await import('./packages/cli/dist/config/validate.js'); validateConfig({version:1,preset:'tracker-keys@1',repos:[{name:'a',path:'.'}]}); console.log('schema path OK')" --input-type=module`
Expected: tests PASS, `schema path OK` printed.

```bash
git add packages/cli/schemas packages/cli/src/config/validate.ts packages/cli/test/config/validate.test.ts
git commit -m "feat: four published strict JSON schemas and validators"
```

---

### Task 3: Pinned presets, blunt merge, config resolution and identity checks

**Files:**
- Create: `packages/cli/src/config/presets.ts`, `packages/cli/src/config/load.ts`
- Test: `packages/cli/test/config/presets.test.ts`, `packages/cli/test/config/load.test.ts`

**Interfaces:**
- Consumes: `validateConfig`, `fingerprint`, `usageError`, `envError`.
- Produces: `PresetDefaults`; `resolvePreset(spec: string, opts?: { allowUnpinned?: boolean }): { name: string; version: number; defaults: PresetDefaults }`; `mergeConfig(raw: RawConfig, configDir: string, opts?): ResolvedConfig`; `assertConfigIdentities(config: ResolvedConfig): void`; `fingerprintConfig(config: ResolvedConfig, cliVersion: string): string`; `loadConfig(path: string, cliVersion: string): { config: ResolvedConfig; configFingerprint: string }`.

- [ ] **Step 1: Write the failing preset test**

`packages/cli/test/config/presets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolvePreset } from '../../src/config/presets.js';
import { CliError } from '../../src/errors.js';

describe('resolvePreset', () => {
  it('resolves a pinned preset', () => {
    const p = resolvePreset('tracker-keys@1');
    expect(p.name).toBe('tracker-keys');
    expect(p.version).toBe(1);
  });

  it('rejects an unpinned preset by default', () => {
    expect(() => resolvePreset('tracker-keys')).toThrow(/pinned/);
  });

  it('allows an unpinned preset when explicitly permitted, for init', () => {
    expect(resolvePreset('tracker-keys', { allowUnpinned: true }).version).toBe(1);
  });

  it('tracker-keys@1 fails on all four findings', () => {
    expect(resolvePreset('tracker-keys@1').defaults.policy.failOn).toEqual([
      'no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'
    ]);
  });

  it('github-oss@1 is fatal only on unknown-reference and range-divergence', () => {
    expect(resolvePreset('github-oss@1').defaults.policy.failOn).toEqual([
      'unknown-reference', 'range-divergence'
    ]);
  });

  it('github-oss@1 does not fail on findings that are normal open-source hygiene', () => {
    const { failOn } = resolvePreset('github-oss@1').defaults.policy;
    expect(failOn).not.toContain('no-reference');
    expect(failOn).not.toContain('item-without-commits');
  });

  it('ignore authors are exact names, not escaped regexes', () => {
    expect(resolvePreset('tracker-keys@1').defaults.ignore.authors).toContain('dependabot[bot]');
  });

  it('rejects an unknown name', () => {
    expect(() => resolvePreset('nope@1')).toThrow(CliError);
  });

  it('rejects an unknown version', () => {
    expect(() => resolvePreset('github-oss@99')).toThrow(/version/);
  });
});
```

Run: `npm test --workspace shipledger -- presets`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/config/presets.ts`**

```ts
import { usageError } from '../errors.js';
import type { HistoryMode, IgnoreConfig, MatcherConfig, PolicyConfig } from '../types.js';

export interface PresetDefaults {
  matchers: MatcherConfig[];
  history: HistoryMode;
  ignore: IgnoreConfig;
  policy: PolicyConfig;
}

const TICKET_KEY: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};

const PR_REF: MatcherConfig = {
  id: 'pr-ref', sources: ['subject'],
  pattern: '(#\\d+)', namespace: 'repo', normalize: 'none'
};

/** authors are exact `%an` values; subjects are regular expressions. */
const COMMON_IGNORE: IgnoreConfig = {
  authors: ['dependabot[bot]'],
  subjects: ['^Merge branch', '^chore\\(deps\\)']
};

const REGISTRY: Record<string, Record<number, PresetDefaults>> = {
  'tracker-keys': {
    1: {
      matchers: [TICKET_KEY, PR_REF],
      history: 'first-parent',
      ignore: COMMON_IGNORE,
      policy: { failOn: ['no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'] }
    }
  },
  'github-oss': {
    1: {
      matchers: [PR_REF],
      history: 'first-parent',
      ignore: COMMON_IGNORE,
      // `no-reference` and `item-without-commits` are both emitted and rendered,
      // but neither is fatal here: drive-by fixes with no issue are normal, and
      // milestone issues closed as duplicate, wontfix, or docs-only routinely
      // carry no code. They are signals to read, not gate failures.
      policy: { failOn: ['unknown-reference', 'range-divergence'] }
    }
  }
};

export const PRESET_NAMES = Object.keys(REGISTRY);

export function resolvePreset(
  spec: string,
  opts: { allowUnpinned?: boolean } = {}
): { name: string; version: number; defaults: PresetDefaults } {
  const [name = '', rawVersion] = spec.split('@');
  const versions = REGISTRY[name];
  if (!versions) {
    throw usageError(`Unknown preset "${name}". Available: ${PRESET_NAMES.join(', ')}.`);
  }
  const available = Object.keys(versions).map(Number).sort((a, b) => a - b);

  if (rawVersion === undefined) {
    if (!opts.allowUnpinned) {
      throw usageError(
        `Preset "${name}" must be pinned as "${name}@${available[available.length - 1]}". An unpinned preset would let a CLI upgrade silently change your policy.`
      );
    }
    const version = available[available.length - 1] as number;
    return { name, version, defaults: versions[version] as PresetDefaults };
  }

  const version = Number(rawVersion);
  const defaults = versions[version];
  if (!defaults) {
    throw usageError(`Unknown version ${rawVersion} for preset "${name}". Available versions: ${available.join(', ')}.`);
  }
  return { name, version, defaults };
}
```

- [ ] **Step 3: Write the failing load test**

`packages/cli/test/config/load.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeConfig, assertConfigIdentities, fingerprintConfig } from '../../src/config/load.js';
import type { RawConfig } from '../../src/types.js';

const base: RawConfig = {
  version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../repo-a' }]
};

describe('mergeConfig', () => {
  it('resolves repo paths relative to the config directory, not cwd', () => {
    const merged = mergeConfig(base, '/tmp/proj/config');
    expect(merged.repos[0]?.path).toBe('/tmp/proj/repo-a');
    expect(merged.repos[0]?.sourcePath).toBe('../repo-a');
  });

  it('leaves an absolute path alone', () => {
    const merged = mergeConfig({ ...base, repos: [{ name: 'repo-a', path: '/abs/repo-a' }] }, '/tmp');
    expect(merged.repos[0]?.path).toBe('/abs/repo-a');
  });

  it('takes preset defaults when a key is absent', () => {
    const merged = mergeConfig(base, '/tmp');
    expect(merged.history).toBe('first-parent');
    expect(merged.matchers).toHaveLength(2);
  });

  it('replaces the matchers array wholesale', () => {
    const merged = mergeConfig({
      ...base,
      matchers: [{ id: 'only', sources: ['subject'], pattern: '(X-\\d+)', namespace: 'global', normalize: 'none' }]
    }, '/tmp');
    expect(merged.matchers.map((m) => m.id)).toEqual(['only']);
  });

  it('replaces the whole ignore object rather than merging its keys', () => {
    const merged = mergeConfig({ ...base, ignore: { authors: [], subjects: ['^WIP'] } }, '/tmp');
    expect(merged.ignore.authors).toEqual([]);
    expect(merged.ignore.subjects).toEqual(['^WIP']);
  });

  it('records the resolved preset name and version', () => {
    const merged = mergeConfig({ ...base, preset: 'github-oss@1' }, '/tmp');
    expect(merged.presetName).toBe('github-oss');
    expect(merged.presetVersion).toBe(1);
  });
});

describe('assertConfigIdentities', () => {
  it('rejects duplicate repo names', () => {
    const merged = mergeConfig({
      ...base, repos: [{ name: 'r', path: '../a' }, { name: 'r', path: '../b' }]
    }, '/tmp');
    expect(() => assertConfigIdentities(merged)).toThrow(/duplicate repo/i);
  });

  it('rejects duplicate matcher ids', () => {
    const m = { id: 'dup', sources: ['subject'] as const, pattern: '(A-\\d+)', namespace: 'global' as const, normalize: 'none' as const };
    const merged = mergeConfig({ ...base, matchers: [m, m] }, '/tmp');
    expect(() => assertConfigIdentities(merged)).toThrow(/duplicate matcher/i);
  });

  it('accepts a clean config', () => {
    expect(() => assertConfigIdentities(mergeConfig(base, '/tmp'))).not.toThrow();
  });
});

describe('fingerprintConfig', () => {
  it('ignores where the checkout lives', () => {
    const a = fingerprintConfig(mergeConfig(base, '/home/alice/proj'), '0.1.0');
    const b = fingerprintConfig(mergeConfig(base, '/var/ci/build'), '0.1.0');
    expect(a).toBe(b);
  });

  it('changes when policy changes', () => {
    const a = fingerprintConfig(mergeConfig(base, '/tmp'), '0.1.0');
    const b = fingerprintConfig(mergeConfig({ ...base, policy: { failOn: [] } }, '/tmp'), '0.1.0');
    expect(a).not.toBe(b);
  });

  it('changes when the CLI version changes', () => {
    const c = mergeConfig(base, '/tmp');
    expect(fingerprintConfig(c, '0.1.0')).not.toBe(fingerprintConfig(c, '0.2.0'));
  });

  it('changes when the schema version participates', () => {
    const c = mergeConfig(base, '/tmp');
    const tampered = { ...c, version: 2 as unknown as 1 };
    expect(fingerprintConfig(c, '0.1.0')).not.toBe(fingerprintConfig(tampered, '0.1.0'));
  });
});
```

Run: `npm test --workspace shipledger -- load`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/config/load.ts`**

```ts
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { envError, usageError } from '../errors.js';
import { fingerprint } from '../core/canonical.js';
import { resolvePreset } from './presets.js';
import { validateConfig } from './validate.js';
import type { RawConfig, ResolvedConfig } from '../types.js';

export function mergeConfig(
  raw: RawConfig,
  configDir: string,
  opts: { allowUnpinned?: boolean } = {}
): ResolvedConfig {
  const preset = resolvePreset(raw.preset, opts);
  return {
    version: raw.version,
    presetName: preset.name,
    presetVersion: preset.version,
    repos: raw.repos.map((r) => ({
      name: r.name,
      sourcePath: r.path,
      path: isAbsolute(r.path) ? r.path : resolve(configDir, r.path)
    })),
    matchers: raw.matchers ?? preset.defaults.matchers,
    history: raw.history ?? preset.defaults.history,
    ignore: raw.ignore ?? preset.defaults.ignore,
    policy: raw.policy ?? preset.defaults.policy
  };
}

export function assertConfigIdentities(config: ResolvedConfig): void {
  const problems: string[] = [];

  const repos = new Set<string>();
  for (const r of config.repos) {
    if (repos.has(r.name)) problems.push(`duplicate repo name "${r.name}"`);
    repos.add(r.name);
  }

  const matchers = new Set<string>();
  for (const m of config.matchers) {
    if (matchers.has(m.id)) problems.push(`duplicate matcher id "${m.id}"`);
    matchers.add(m.id);
  }

  if (problems.length > 0) {
    throw usageError(`Config has conflicting identities:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

/**
 * Every resolved field participates, including the schema version. Repo paths
 * enter as their original config strings so two machines with identical configs
 * and different checkout locations agree.
 */
export function fingerprintConfig(config: ResolvedConfig, cliVersion: string): string {
  return fingerprint({
    cliVersion,
    version: config.version,
    presetName: config.presetName,
    presetVersion: config.presetVersion,
    repos: config.repos.map((r) => ({ name: r.name, path: r.sourcePath })),
    matchers: config.matchers,
    history: config.history,
    ignore: config.ignore,
    policy: config.policy
  });
}

export function loadConfig(
  path: string,
  cliVersion: string
): { config: ResolvedConfig; configFingerprint: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw envError(`Cannot read config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usageError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const config = mergeConfig(validateConfig(parsed), dirname(resolve(path)));
  assertConfigIdentities(config);
  return { config, configFingerprint: fingerprintConfig(config, cliVersion) };
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test --workspace shipledger && npm run typecheck --workspace shipledger`
Expected: all preset and load tests PASS.

```bash
git add packages/cli/src/config packages/cli/test/config
git commit -m "feat: pinned presets, whole-key merge, config identities and fingerprint"
```

---

### Task 4: Changeset loading and cross-file semantic validation

**Files:**
- Create: `packages/cli/src/config/changeset.ts`
- Test: `packages/cli/test/config/changeset.test.ts`

**Interfaces:**
- Consumes: `validateChangeset`, `usageError`, `envError`, `ResolvedConfig`.
- Produces: `loadChangeset(path: string): Changeset`; `assertChangesetAgainstConfig(changeset: Changeset, config: ResolvedConfig): void` — exit 2, reporting every problem at once.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/config/changeset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { assertChangesetAgainstConfig } from '../../src/config/changeset.js';
import { mergeConfig } from '../../src/config/load.js';
import type { Changeset, ChangesetItem } from '../../src/types.js';

const config = mergeConfig({
  version: 1, preset: 'tracker-keys@1',
  repos: [{ name: 'repo-a', path: '../a' }, { name: 'repo-b', path: '../b' }]
}, '/tmp');

const item = (over: Partial<ChangesetItem> = {}): ChangesetItem => ({
  id: 'PROJ-1', title: 't', type: 'story', status: 'done',
  tokens: [{ matcher: 'ticket-key', token: 'PROJ-1' }], ...over
});

function changeset(over: Partial<Changeset> = {}): Changeset {
  return {
    version: 1, id: 'release 1.4.0',
    source: { kind: 'k', ref: 'r', fetchedAt: '2026-09-01T01:00:00Z' },
    items: [item()],
    ranges: [{ repo: 'repo-a', base: 'v1.3.0', head: 'v1.4.0' }],
    ...over
  };
}

describe('assertChangesetAgainstConfig', () => {
  it('accepts a consistent changeset', () => {
    expect(() => assertChangesetAgainstConfig(changeset(), config)).not.toThrow();
  });

  it('rejects a range naming an undefined repo', () => {
    expect(() => assertChangesetAgainstConfig(changeset({ ranges: [{ repo: 'ghost', base: 'a', head: 'b' }] }), config)).toThrow(/ghost/);
  });

  it('rejects two ranges for the same repo', () => {
    const ranges = [
      { repo: 'repo-a', base: 'v1', head: 'v2' },
      { repo: 'repo-a', base: 'v2', head: 'v3' }
    ];
    expect(() => assertChangesetAgainstConfig(changeset({ ranges }), config)).toThrow(/one range per repo/i);
  });

  it('rejects duplicate item ids', () => {
    expect(() => assertChangesetAgainstConfig(changeset({ items: [item(), item()] }), config)).toThrow(/duplicate item/i);
  });

  it('rejects a token naming an unknown matcher', () => {
    const bad = item({ tokens: [{ matcher: 'nope', token: '#1', repo: 'repo-a' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/matcher "nope"/);
  });

  it('rejects a repo-namespaced token with no repo', () => {
    const bad = item({ tokens: [{ matcher: 'pr-ref', token: '#1' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/requires "repo"/);
  });

  it('rejects a global token carrying a repo', () => {
    const bad = item({ tokens: [{ matcher: 'ticket-key', token: 'PROJ-2', repo: 'repo-a' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/must not carry "repo"/);
  });

  it('rejects a token naming an undefined repo', () => {
    const bad = item({ tokens: [{ matcher: 'pr-ref', token: '#1', repo: 'ghost' }] });
    expect(() => assertChangesetAgainstConfig(changeset({ items: [bad] }), config)).toThrow(/ghost/);
  });

  it('allows one token tuple to belong to two items', () => {
    const shared = { matcher: 'pr-ref', token: '#9', repo: 'repo-a' };
    const items = [item({ id: 'A', tokens: [shared] }), item({ id: 'B', tokens: [shared] })];
    expect(() => assertChangesetAgainstConfig(changeset({ items }), config)).not.toThrow();
  });

  it('reports every problem in one error', () => {
    const bad = changeset({
      ranges: [{ repo: 'ghost', base: 'a', head: 'b' }],
      items: [item({ tokens: [{ matcher: 'nope', token: '#1' }] })]
    });
    try {
      assertChangesetAgainstConfig(bad, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/ghost/);
      expect((err as Error).message).toMatch(/nope/);
    }
  });
});
```

Run: `npm test --workspace shipledger -- changeset`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/config/changeset.ts`**

```ts
import { readFileSync } from 'node:fs';
import { envError, usageError } from '../errors.js';
import { validateChangeset } from './validate.js';
import type { Changeset, ResolvedConfig } from '../types.js';

export function loadChangeset(path: string): Changeset {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw envError(`Cannot read changeset at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usageError(`Changeset at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validateChangeset(parsed);
}

export function assertChangesetAgainstConfig(changeset: Changeset, config: ResolvedConfig): void {
  const repoNames = new Set(config.repos.map((r) => r.name));
  const matchers = new Map(config.matchers.map((m) => [m.id, m]));
  const problems: string[] = [];

  const seenRangeRepos = new Set<string>();
  for (const range of changeset.ranges) {
    if (!repoNames.has(range.repo)) {
      problems.push(`range names repo "${range.repo}", which the config does not define (defined: ${[...repoNames].join(', ')})`);
    }
    if (seenRangeRepos.has(range.repo)) {
      problems.push(`repo "${range.repo}" has more than one range; V1 permits one range per repo — put multiple paths in that range's "include"`);
    }
    seenRangeRepos.add(range.repo);
  }

  const seenItems = new Set<string>();
  for (const item of changeset.items) {
    if (seenItems.has(item.id)) problems.push(`duplicate item id "${item.id}"`);
    seenItems.add(item.id);

    for (const token of item.tokens) {
      const matcher = matchers.get(token.matcher);
      if (!matcher) {
        problems.push(`item "${item.id}" token names matcher "${token.matcher}", which the config does not define`);
        continue;
      }
      if (matcher.namespace === 'repo' && token.repo === undefined) {
        problems.push(`item "${item.id}" token for repo-namespaced matcher "${token.matcher}" requires "repo"`);
      }
      if (matcher.namespace === 'global' && token.repo !== undefined) {
        problems.push(`item "${item.id}" token for global matcher "${token.matcher}" must not carry "repo"`);
      }
      if (token.repo !== undefined && !repoNames.has(token.repo)) {
        problems.push(`item "${item.id}" token names repo "${token.repo}", which the config does not define`);
      }
    }
  }

  if (problems.length > 0) {
    throw usageError(`Changeset is inconsistent with the config:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
```

Note that `assertChangesetAgainstConfig` collects every problem before throwing. A release with a mistyped repo name and three bad tokens should surface all four in one run, not four runs.

- [ ] **Step 3: Run the tests**

Run: `npm test --workspace shipledger -- changeset`
Expected: all ten tests PASS.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace shipledger`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config/changeset.ts packages/cli/test/config/changeset.test.ts
git commit -m "feat: changeset loading with strict cross-file semantic validation"
```

---

### Task 5: Pre-git compilation and token extraction

**Files:**
- Create: `packages/cli/src/core/compile.ts`, `packages/cli/src/core/tokens.ts`
- Test: `packages/cli/test/core/compile.test.ts`, `packages/cli/test/core/tokens.test.ts`

**Interfaces:**
- Consumes: `usageError`, `MatcherConfig`, `IgnoreConfig`, `CommitRecord`, `Reference`.
- Produces:
  - `CompiledMatcher = { config: MatcherConfig; regex: RegExp }`
  - `CompiledIgnore = { authors: Set<string>; subjects: Array<{ pattern: string; regex: RegExp }> }`
  - `compileMatchers(matchers: MatcherConfig[]): CompiledMatcher[]`
  - `compileIgnore(ignore: IgnoreConfig): CompiledIgnore`
  - `compileAll(config: ResolvedConfig): { matchers: CompiledMatcher[]; ignore: CompiledIgnore }` — the single call `check` makes before touching git
  - `extractReferences(commit: CommitRecord, matchers: CompiledMatcher[]): Reference[]` with `resolvesTo: []`

- [ ] **Step 1: Write the failing compile test**

`packages/cli/test/core/compile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compileMatchers, compileIgnore, compileAll } from '../../src/core/compile.js';
import { mergeConfig } from '../../src/config/load.js';
import { CliError } from '../../src/errors.js';
import type { MatcherConfig } from '../../src/types.js';

const ok: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};

describe('compileMatchers', () => {
  it('compiles a valid matcher', () => {
    expect(compileMatchers([ok])[0]?.config.id).toBe('ticket-key');
  });

  it('rejects a pattern with no capture group', () => {
    expect(() => compileMatchers([{ ...ok, pattern: 'PROJ-\\d+' }])).toThrow(/exactly one/);
  });

  it('rejects a pattern with two capture groups', () => {
    expect(() => compileMatchers([{ ...ok, pattern: '([A-Z]+)-(\\d+)' }])).toThrow(/exactly one/);
  });

  it('counts one group for a pattern containing an alternation', () => {
    expect(compileMatchers([{ ...ok, pattern: '((?:ABC|XYZ)-\\d+)' }])).toHaveLength(1);
  });

  it('rejects an invalid regular expression with exit code 2', () => {
    try {
      compileMatchers([{ ...ok, pattern: '([' }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });
});

describe('compileIgnore', () => {
  it('treats authors as exact strings, not patterns', () => {
    const compiled = compileIgnore({ authors: ['dependabot[bot]'], subjects: [] });
    expect(compiled.authors.has('dependabot[bot]')).toBe(true);
  });

  it('compiles subjects as regular expressions', () => {
    expect(compileIgnore({ authors: [], subjects: ['^Merge branch'] }).subjects[0]?.regex.test('Merge branch x')).toBe(true);
  });

  it('rejects an invalid subject expression', () => {
    expect(() => compileIgnore({ authors: [], subjects: ['^('] })).toThrow(CliError);
  });

  it('does not treat an author with regex metacharacters as a pattern', () => {
    const compiled = compileIgnore({ authors: ['a.b'], subjects: [] });
    expect(compiled.authors.has('a.b')).toBe(true);
    expect(compiled.authors.has('axb')).toBe(false);
  });
});

describe('compileAll', () => {
  it('compiles everything from a resolved config in one call', () => {
    const config = mergeConfig({ version: 1, preset: 'tracker-keys@1', repos: [{ name: 'r', path: '.' }] }, '/tmp');
    const compiled = compileAll(config);
    expect(compiled.matchers).toHaveLength(2);
    expect(compiled.ignore.subjects).toHaveLength(2);
  });

  it('fails before any repository work, given a bad matcher', () => {
    const config = mergeConfig({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'r', path: '/nonexistent' }],
      matchers: [{ ...ok, pattern: '([' }]
    }, '/tmp');
    expect(() => compileAll(config)).toThrow(CliError);
  });
});
```

Run: `npm test --workspace shipledger -- compile`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/core/compile.ts`**

```ts
import { usageError } from '../errors.js';
import type { IgnoreConfig, MatcherConfig, ResolvedConfig } from '../types.js';

export interface CompiledMatcher { config: MatcherConfig; regex: RegExp }
export interface CompiledIgnore {
  authors: Set<string>;
  subjects: Array<{ pattern: string; regex: RegExp }>;
}

function countCaptureGroups(pattern: string): number {
  // An always-matching alternative makes exec reveal the group count.
  const probe = new RegExp(`(?:${pattern})|`);
  return (probe.exec('')?.length ?? 1) - 1;
}

export function compileMatchers(matchers: MatcherConfig[]): CompiledMatcher[] {
  return matchers.map((config) => {
    let groups: number;
    try {
      groups = countCaptureGroups(config.pattern);
    } catch (err) {
      throw usageError(`Matcher "${config.id}" pattern is not a valid regular expression: ${(err as Error).message}`);
    }
    if (groups !== 1) {
      throw usageError(`Matcher "${config.id}" must have exactly one capture group; found ${groups}.`);
    }
    return { config, regex: new RegExp(config.pattern, 'g') };
  });
}

export function compileIgnore(ignore: IgnoreConfig): CompiledIgnore {
  const subjects = ignore.subjects.map((pattern) => {
    try {
      return { pattern, regex: new RegExp(pattern) };
    } catch (err) {
      throw usageError(`Ignore subject "${pattern}" is not a valid regular expression: ${(err as Error).message}`);
    }
  });
  return { authors: new Set(ignore.authors), subjects };
}

/** Called before any repository is opened. */
export function compileAll(config: ResolvedConfig): {
  matchers: CompiledMatcher[];
  ignore: CompiledIgnore;
} {
  return { matchers: compileMatchers(config.matchers), ignore: compileIgnore(config.ignore) };
}
```

Note the probe wraps `pattern` in a non-capturing group, so a top-level alternation inside the pattern cannot swallow the always-matching branch.

- [ ] **Step 3: Write the failing tokens test**

`packages/cli/test/core/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compileMatchers } from '../../src/core/compile.js';
import { extractReferences } from '../../src/core/tokens.js';
import type { CommitRecord, MatcherConfig } from '../../src/types.js';

const ticketKey: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};
const prRef: MatcherConfig = {
  id: 'pr-ref', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none'
};
const compiled = compileMatchers([ticketKey, prRef]);

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    repo: 'repo-a', sha: 'a'.repeat(40), subject: '', body: '',
    author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
  };
}

describe('extractReferences', () => {
  it('takes capture group 1 verbatim, including the sigil', () => {
    const refs = extractReferences(commit({ subject: 'fix thing (#123)' }), compiled);
    expect(refs.find((r) => r.matcher === 'pr-ref')?.token).toBe('#123');
  });

  it('applies the normalize rule', () => {
    const lower = compileMatchers([{ ...ticketKey, pattern: '([A-Za-z][A-Za-z0-9]+-\\d+)' }]);
    expect(extractReferences(commit({ subject: 'proj-42 done' }), lower)[0]?.token).toBe('PROJ-42');
  });

  it('collapses one tuple seen in two sources into a single reference listing both', () => {
    const refs = extractReferences(commit({ subject: 'PROJ-1 fix', body: 'more on PROJ-1' }), compiled);
    const hit = refs.filter((r) => r.token === 'PROJ-1');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.sources).toEqual(['subject', 'body']);
  });

  it('records sources in subject-then-body order regardless of where it first appeared', () => {
    const refs = extractReferences(commit({ body: 'PROJ-1', subject: 'PROJ-1' }), compiled);
    expect(refs[0]?.sources).toEqual(['subject', 'body']);
  });

  it('collapses repeated captures within one source', () => {
    const refs = extractReferences(commit({ subject: 'PROJ-1 and again PROJ-1' }), compiled);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sources).toEqual(['subject']);
  });

  it('does not read a source the matcher did not declare', () => {
    const refs = extractReferences(commit({ body: 'mentions (#7)' }), compiled);
    expect(refs.some((r) => r.matcher === 'pr-ref')).toBe(false);
  });

  it('finds every distinct occurrence', () => {
    const refs = extractReferences(commit({ subject: 'PROJ-1 and PROJ-2' }), compiled);
    expect(refs.map((r) => r.token)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('keeps different matchers separate even for an equal token string', () => {
    const both = compileMatchers([
      { id: 'a', sources: ['subject'], pattern: '(#\\d+)', namespace: 'global', normalize: 'none' },
      { id: 'b', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none' }
    ]);
    const refs = extractReferences(commit({ subject: 'x (#5)' }), both);
    expect(refs.map((r) => r.matcher)).toEqual(['a', 'b']);
  });

  it('does not trim or alter source text when matching a body with trailing whitespace', () => {
    const refs = extractReferences(commit({ body: '  PROJ-3  \n\n' }), compiled);
    expect(refs[0]?.token).toBe('PROJ-3');
  });

  it('returns an empty list when nothing matches', () => {
    expect(extractReferences(commit({ subject: 'tidy up' }), compiled)).toEqual([]);
  });

  it('leaves resolvesTo an empty array', () => {
    expect(extractReferences(commit({ subject: 'PROJ-1' }), compiled)[0]?.resolvesTo).toEqual([]);
  });
});
```

Run: `npm test --workspace shipledger -- tokens`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/core/tokens.ts`, run tests**

```ts
import type { CommitRecord, CommitSource, Normalize, Reference } from '../types.js';
import type { CompiledMatcher } from './compile.js';

const SOURCE_ORDER: CommitSource[] = ['subject', 'body'];

function applyNormalize(token: string, normalize: Normalize): string {
  if (normalize === 'upper') return token.toUpperCase();
  if (normalize === 'lower') return token.toLowerCase();
  return token;
}

export function extractReferences(commit: CommitRecord, matchers: CompiledMatcher[]): Reference[] {
  const order: string[] = [];
  const byKey = new Map<string, Reference>();

  for (const { config, regex } of matchers) {
    for (const source of SOURCE_ORDER) {
      if (!config.sources.includes(source)) continue;
      const text = source === 'subject' ? commit.subject : commit.body;
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const captured = match[1];
        if (captured === undefined) continue;
        const token = applyNormalize(captured, config.normalize);
        const key = `${config.id}\u0000${token}`;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
          continue;
        }
        const reference: Reference = {
          matcher: config.id,
          token,
          namespace: config.namespace,
          sources: [source],
          resolvesTo: []
        };
        byKey.set(key, reference);
        order.push(key);
      }
    }
  }

  // Re-sort each sources array into subject-then-body order for stable output.
  const out = order.map((key) => byKey.get(key) as Reference);
  for (const ref of out) {
    ref.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  }
  return out;
}
```

Run: `npm test --workspace shipledger -- "core/(compile|tokens)" && npm run typecheck --workspace shipledger`
Expected: all compile and tokens tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/core/compile.ts packages/cli/src/core/tokens.ts packages/cli/test/core/compile.test.ts packages/cli/test/core/tokens.test.ts
git commit -m "feat: pre-git compilation and deduplicated token extraction"
```

---

### Task 6: Item token index and array resolution

**Files:**
- Create: `packages/cli/src/core/index-items.ts`
- Test: `packages/cli/test/core/index-items.test.ts`

**Interfaces:**
- Consumes: `Changeset`, `MatcherConfig`, `Reference`, `Namespace`.
- Produces: `ItemIndex = Map<string, string[]>` keyed `${matcherId}\u0000${scopeKey}\u0000${token}`; `scopeKeyFor(namespace: Namespace, repo: string): string`; `buildItemIndex(changeset: Changeset, matchers: MatcherConfig[]): ItemIndex`; `resolveReferences(refs: Reference[], repo: string, index: ItemIndex): { references: Reference[]; links: Array<{ itemId: string }> }`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/core/index-items.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildItemIndex, resolveReferences, scopeKeyFor } from '../../src/core/index-items.js';
import { compileMatchers } from '../../src/core/compile.js';
import { extractReferences } from '../../src/core/tokens.js';
import type { Changeset, ChangesetItem, CommitRecord, MatcherConfig } from '../../src/types.js';

const ticketKey: MatcherConfig = {
  id: 'ticket-key', sources: ['subject', 'body'],
  pattern: '([A-Z][A-Z0-9]+-\\d+)', namespace: 'global', normalize: 'upper'
};
const prRef: MatcherConfig = {
  id: 'pr-ref', sources: ['subject'], pattern: '(#\\d+)', namespace: 'repo', normalize: 'none'
};
const matchers = [ticketKey, prRef];
const compiled = compileMatchers(matchers);

const item = (id: string, tokens: ChangesetItem['tokens']): ChangesetItem =>
  ({ id, title: 't', type: 'story', status: 'done', tokens });

function changeset(items: ChangesetItem[]): Changeset {
  return {
    version: 1, id: 'r', source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
    items, ranges: [{ repo: 'repo-a', base: 'a', head: 'b' }]
  };
}

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    repo: 'repo-a', sha: 'a'.repeat(40), subject: '', body: '',
    author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
  };
}

describe('scopeKeyFor', () => {
  it('is the literal global for global matchers', () => {
    expect(scopeKeyFor('global', 'repo-a')).toBe('global');
  });

  it('is the repo name for repo matchers', () => {
    expect(scopeKeyFor('repo', 'repo-a')).toBe('repo-a');
  });
});

describe('buildItemIndex + resolveReferences', () => {
  it('does not match an item id that is not declared as a token', () => {
    const index = buildItemIndex(changeset([item('PROJ-42', [{ matcher: 'pr-ref', token: '#1', repo: 'repo-a' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42 fix' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual([]);
  });

  it('matches an explicitly declared global token', () => {
    const index = buildItemIndex(changeset([item('PROJ-42', [{ matcher: 'ticket-key', token: 'PROJ-42' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42 fix' }), compiled);
    const out = resolveReferences(refs, 'repo-a', index);
    expect(out.references[0]?.resolvesTo).toEqual(['PROJ-42']);
    expect(out.links).toEqual([{ itemId: 'PROJ-42' }]);
  });

  it('normalises the declared token with the matcher rule', () => {
    const index = buildItemIndex(changeset([item('x', [{ matcher: 'ticket-key', token: 'proj-42' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual(['x']);
  });

  it('scopes a repo token to its repo', () => {
    const index = buildItemIndex(changeset([item('I1', [{ matcher: 'pr-ref', token: '#123', repo: 'repo-a' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'squash (#123)' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual(['I1']);
  });

  it('does not match a repo token from another repo', () => {
    const index = buildItemIndex(changeset([item('I1', [{ matcher: 'pr-ref', token: '#123', repo: 'repo-a' }])]), matchers);
    const refs = extractReferences(commit({ repo: 'repo-b', subject: 'squash (#123)' }), compiled);
    expect(resolveReferences(refs, 'repo-b', index).references[0]?.resolvesTo).toEqual([]);
  });

  it('does not match across matchers with a coincidentally equal token', () => {
    const index = buildItemIndex(changeset([item('I1', [{ matcher: 'ticket-key', token: '#5' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'x (#5)' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).references[0]?.resolvesTo).toEqual([]);
  });

  it('resolves one token to every matching item, in changeset order', () => {
    const shared = { matcher: 'pr-ref' as const, token: '#9', repo: 'repo-a' };
    const index = buildItemIndex(changeset([item('B', [shared]), item('A', [shared])]), matchers);
    const refs = extractReferences(commit({ subject: 'x (#9)' }), compiled);
    const out = resolveReferences(refs, 'repo-a', index);
    expect(out.references[0]?.resolvesTo).toEqual(['B', 'A']);
    expect(out.links).toEqual([{ itemId: 'B' }, { itemId: 'A' }]);
  });

  it('keeps an unresolved reference alongside a resolved one', () => {
    const index = buildItemIndex(changeset([item('PROJ-42', [{ matcher: 'ticket-key', token: 'PROJ-42' }])]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-42 and PROJ-99' }), compiled);
    const out = resolveReferences(refs, 'repo-a', index);
    expect(out.references.map((r) => r.resolvesTo)).toEqual([['PROJ-42'], []]);
    expect(out.links).toEqual([{ itemId: 'PROJ-42' }]);
  });

  it('reports each linked item once even when two references hit it', () => {
    const index = buildItemIndex(changeset([
      item('I1', [{ matcher: 'ticket-key', token: 'PROJ-1' }, { matcher: 'ticket-key', token: 'PROJ-2' }])
    ]), matchers);
    const refs = extractReferences(commit({ subject: 'PROJ-1 PROJ-2' }), compiled);
    expect(resolveReferences(refs, 'repo-a', index).links).toEqual([{ itemId: 'I1' }]);
  });
});
```

Run: `npm test --workspace shipledger -- index-items`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/core/index-items.ts`**

```ts
import type { Changeset, MatcherConfig, Namespace, Normalize, Reference } from '../types.js';

export type ItemIndex = Map<string, string[]>;

export function scopeKeyFor(namespace: Namespace, repo: string): string {
  return namespace === 'global' ? 'global' : repo;
}

function applyNormalize(token: string, normalize: Normalize): string {
  if (normalize === 'upper') return token.toUpperCase();
  if (normalize === 'lower') return token.toLowerCase();
  return token;
}

const keyOf = (matcherId: string, scopeKey: string, token: string): string =>
  `${matcherId}\u0000${scopeKey}\u0000${token}`;

/**
 * Only tokens declared in `items[].tokens` are matchable. An item's `id` is
 * opaque identity and is never indexed.
 */
export function buildItemIndex(changeset: Changeset, matchers: MatcherConfig[]): ItemIndex {
  const index: ItemIndex = new Map();
  const byId = new Map(matchers.map((m) => [m.id, m]));

  for (const item of changeset.items) {
    for (const token of item.tokens) {
      const matcher = byId.get(token.matcher);
      if (!matcher) continue; // already rejected by assertChangesetAgainstConfig
      const key = keyOf(
        matcher.id,
        scopeKeyFor(matcher.namespace, token.repo ?? ''),
        applyNormalize(token.token, matcher.normalize)
      );
      const bucket = index.get(key);
      if (bucket) {
        if (!bucket.includes(item.id)) bucket.push(item.id);
      } else {
        index.set(key, [item.id]);
      }
    }
  }
  return index;
}

export function resolveReferences(
  refs: Reference[],
  repo: string,
  index: ItemIndex
): { references: Reference[]; links: Array<{ itemId: string }> } {
  const linked: string[] = [];
  const references = refs.map((ref) => {
    const hits = index.get(keyOf(ref.matcher, scopeKeyFor(ref.namespace, repo), ref.token)) ?? [];
    for (const id of hits) if (!linked.includes(id)) linked.push(id);
    return { ...ref, resolvesTo: [...hits] };
  });
  return { references, links: linked.map((itemId) => ({ itemId })) };
}
```

Because the index is built by walking `changeset.items` in order, each bucket is already in changeset order, so `resolvesTo` needs no further sorting.

- [ ] **Step 3: Run the tests**

Run: `npm test --workspace shipledger -- index-items`
Expected: all twelve tests PASS. The first test is the important one — it proves an undeclared item id is not matchable, which is the contract change from the previous design.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace shipledger`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/core/index-items.ts packages/cli/test/core/index-items.test.ts
git commit -m "feat: declared-token index with ordered array resolution"
```

---

### Task 7: Findings, summary, verdict

**Files:**
- Create: `packages/cli/src/core/findings.ts`
- Test: `packages/cli/test/core/findings.test.ts`

**Interfaces:**
- Consumes: `CompiledIgnore`, `CommitRecord`, `CommitResult`, `ItemResult`, `RangeResult`, `Reference`, `PolicyConfig`, `Summary`, `Violation`.
- Produces: `FINDING_ORDER: FindingName[]`; `matchIgnoreRule(commit: CommitRecord, ignore: CompiledIgnore): string | null`; `commitFindings(references: Reference[], ignored: boolean): FindingName[]`; `summarise(sets): Summary`; `decideVerdict(sets & { policy }): { verdict; violations }`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/core/findings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchIgnoreRule, commitFindings, summarise, decideVerdict } from '../../src/core/findings.js';
import { compileIgnore } from '../../src/core/compile.js';
import type { CommitRecord, CommitResult, ItemResult, RangeResult, Reference } from '../../src/types.js';

const ignore = compileIgnore({ authors: ['dependabot[bot]'], subjects: ['^Merge branch'] });

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    repo: 'repo-a', sha: 'a'.repeat(40), subject: 'tidy', body: '',
    author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
  };
}

const ref = (resolvesTo: string[]): Reference => ({
  matcher: 'ticket-key', token: 'PROJ-1', namespace: 'global', sources: ['subject'], resolvesTo
});

describe('matchIgnoreRule', () => {
  it('returns null when nothing matches', () => {
    expect(matchIgnoreRule(commit(), ignore)).toBeNull();
  });

  it('matches an author by exact name', () => {
    expect(matchIgnoreRule(commit({ author: 'dependabot[bot]' }), ignore)).toBe('authors:dependabot[bot]');
  });

  it('does not match an author by substring', () => {
    expect(matchIgnoreRule(commit({ author: 'not-dependabot[bot]-really' }), ignore)).toBeNull();
  });

  it('does not treat an author entry as a regex', () => {
    const dotIgnore = compileIgnore({ authors: ['a.c'], subjects: [] });
    expect(matchIgnoreRule(commit({ author: 'abc' }), dotIgnore)).toBeNull();
    expect(matchIgnoreRule(commit({ author: 'a.c' }), dotIgnore)).toBe('authors:a.c');
  });

  it('matches a subject by regex', () => {
    expect(matchIgnoreRule(commit({ subject: 'Merge branch main' }), ignore)).toBe('subjects:^Merge branch');
  });

  it('prefers the author rule when both match', () => {
    expect(matchIgnoreRule(commit({ author: 'dependabot[bot]', subject: 'Merge branch x' }), ignore))
      .toBe('authors:dependabot[bot]');
  });
});

describe('commitFindings', () => {
  it('flags no-reference for an empty reference list', () => {
    expect(commitFindings([], false)).toEqual(['no-reference']);
  });

  it('flags unknown-reference when any resolvesTo is empty', () => {
    expect(commitFindings([ref(['PROJ-1']), ref([])], false)).toEqual(['unknown-reference']);
  });

  it('returns nothing when every reference resolves', () => {
    expect(commitFindings([ref(['PROJ-1'])], false)).toEqual([]);
  });

  it('returns nothing for an ignored commit', () => {
    expect(commitFindings([], true)).toEqual([]);
  });
});

describe('summarise and decideVerdict', () => {
  const commits: CommitResult[] = [
    { repo: 'repo-a', sha: 'a', subject: 's', body: '', author: 'd', committedAt: 't', ignored: null, references: [ref(['PROJ-1']), ref([])], findings: ['unknown-reference'] },
    { repo: 'repo-a', sha: 'b', subject: 's', body: '', author: 'd', committedAt: 't', ignored: null, references: [], findings: ['no-reference'] },
    { repo: 'repo-a', sha: 'c', subject: 's', body: '', author: 'd', committedAt: 't', ignored: { rule: 'authors:x' }, references: [], findings: [] }
  ];
  const items: ItemResult[] = [
    { id: 'PROJ-1', title: 't', type: 'story', status: 'done', commits: [{ repo: 'repo-a', sha: 'a' }], findings: [] },
    { id: 'PROJ-2', title: 't', type: 'story', status: 'done', commits: [], findings: ['item-without-commits'] }
  ];
  const ranges: RangeResult[] = [
    { repo: 'repo-a', base: 'v1', baseSha: 'x', head: 'v2', headSha: 'y', include: [], mergeBase: 'z', baseIsAncestorOfHead: false, commitsOnlyInBase: 3, findings: ['range-divergence'] }
  ];

  it('counts each category', () => {
    expect(summarise({ commits, items, ranges })).toEqual({
      items: 2, itemsLinked: 1, commits: 3, commitsIgnored: 1,
      noReference: 1, unknownReference: 1, itemsWithoutCommits: 1, rangeDivergence: 1
    });
  });

  it('passes when failOn is empty', () => {
    expect(decideVerdict({ commits, items, ranges, policy: { failOn: [] } }).verdict).toBe('pass');
  });

  it('fails and counts only the findings named in failOn', () => {
    const out = decideVerdict({ commits, items, ranges, policy: { failOn: ['unknown-reference'] } });
    expect(out.verdict).toBe('fail');
    expect(out.violations).toEqual([{ finding: 'unknown-reference', count: 1 }]);
  });

  it('orders violations canonically regardless of failOn order', () => {
    const out = decideVerdict({
      commits, items, ranges,
      policy: { failOn: ['range-divergence', 'item-without-commits', 'no-reference', 'unknown-reference'] }
    });
    expect(out.violations.map((v) => v.finding)).toEqual([
      'no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'
    ]);
  });

  it('omits a finding that is in failOn but did not occur', () => {
    const clean = decideVerdict({ commits: [], items: [], ranges: [], policy: { failOn: ['no-reference'] } });
    expect(clean.violations).toEqual([]);
    expect(clean.verdict).toBe('pass');
  });
});
```

Run: `npm test --workspace shipledger -- findings`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/core/findings.ts`**

```ts
import type {
  CommitRecord, CommitResult, FindingName, ItemResult,
  PolicyConfig, RangeResult, Reference, Summary, Violation
} from '../types.js';
import type { CompiledIgnore } from './compile.js';

export const FINDING_ORDER: FindingName[] = [
  'no-reference', 'unknown-reference', 'item-without-commits', 'range-divergence'
];

/** Authors compare by exact equality; subjects by regex. */
export function matchIgnoreRule(commit: CommitRecord, ignore: CompiledIgnore): string | null {
  if (ignore.authors.has(commit.author)) return `authors:${commit.author}`;
  for (const { pattern, regex } of ignore.subjects) {
    if (regex.test(commit.subject)) return `subjects:${pattern}`;
  }
  return null;
}

export function commitFindings(references: Reference[], ignored: boolean): FindingName[] {
  if (ignored) return [];
  if (references.length === 0) return ['no-reference'];
  return references.some((r) => r.resolvesTo.length === 0) ? ['unknown-reference'] : [];
}

interface Sets { commits: CommitResult[]; items: ItemResult[]; ranges: RangeResult[] }

function countFinding(sets: Sets, finding: FindingName): number {
  return sets.commits.filter((c) => c.findings.includes(finding)).length
    + sets.items.filter((i) => i.findings.includes(finding)).length
    + sets.ranges.filter((r) => r.findings.includes(finding)).length;
}

export function summarise(sets: Sets): Summary {
  return {
    items: sets.items.length,
    itemsLinked: sets.items.filter((i) => i.commits.length > 0).length,
    commits: sets.commits.length,
    commitsIgnored: sets.commits.filter((c) => c.ignored !== null).length,
    noReference: countFinding(sets, 'no-reference'),
    unknownReference: countFinding(sets, 'unknown-reference'),
    itemsWithoutCommits: countFinding(sets, 'item-without-commits'),
    rangeDivergence: countFinding(sets, 'range-divergence')
  };
}

export function decideVerdict(
  args: Sets & { policy: PolicyConfig }
): { verdict: 'pass' | 'fail'; violations: Violation[] } {
  const violations: Violation[] = [];
  for (const finding of FINDING_ORDER) {
    if (!args.policy.failOn.includes(finding)) continue;
    const count = countFinding(args, finding);
    if (count > 0) violations.push({ finding, count });
  }
  return { verdict: violations.length > 0 ? 'fail' : 'pass', violations };
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test --workspace shipledger -- findings`
Expected: all tests PASS. The two author tests matter most — exact-name comparison is a contract change from the previous regex behaviour.

- [ ] **Step 4: Full suite and typecheck**

Run: `npm test --workspace shipledger && npm run typecheck --workspace shipledger`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/core/findings.ts packages/cli/test/core/findings.test.ts
git commit -m "feat: exact-name ignores, non-exclusive findings, canonical verdict"
```

---

### Task 8: core reconcile orchestration

**Files:**
- Create: `packages/cli/src/core/reconcile.ts`
- Test: `packages/cli/test/core/reconcile.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces: `reconcile(input: ReconcileInput): VerifiedChangeset` and `export interface ReconcileInput { config: ResolvedConfig; compiled: { matchers: CompiledMatcher[]; ignore: CompiledIgnore }; changeset: Changeset; commits: CommitRecord[]; ranges: RangeResult[]; cliVersion: string; configFingerprint: string; now?: string }`. Compilation is passed in, not performed here, because it must happen before git work.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/core/reconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileInput } from '../../src/core/reconcile.js';
import { compileAll } from '../../src/core/compile.js';
import { mergeConfig } from '../../src/config/load.js';
import type { Changeset, CommitRecord, RangeResult } from '../../src/types.js';

const config = mergeConfig({
  version: 1, preset: 'tracker-keys@1',
  repos: [{ name: 'repo-a', path: '../a' }, { name: 'repo-b', path: '../b' }],
  policy: { failOn: [] }
}, '/tmp');

const compiled = compileAll(config);

const changeset: Changeset = {
  version: 1, id: 'release 1.4.0',
  source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
  items: [
    { id: 'PROJ-42', title: 'first', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-42' }] },
    { id: 'PROJ-77', title: 'second', type: 'bug', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-77' }] }
  ],
  ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
};

// Every sha-shaped fixture value is real lowercase hex and every fingerprint is
// 64 hex characters, because the last test in this file validates the output
// against the published schema, whose patterns would reject 'h'.repeat(40).
const SHA_BASE = 'b'.repeat(40);
const SHA_HEAD = 'e'.repeat(40);
const SHA_MERGE = 'c'.repeat(40);
const FINGERPRINT = `sha256:${'0'.repeat(64)}`;

const range = (repo: string, over: Partial<RangeResult> = {}): RangeResult => ({
  repo, base: 'v1', baseSha: SHA_BASE, head: 'v2', headSha: SHA_HEAD,
  include: [], mergeBase: SHA_MERGE, baseIsAncestorOfHead: true, commitsOnlyInBase: 0,
  findings: [], ...over
});

const commit = (over: Partial<CommitRecord>): CommitRecord => ({
  repo: 'repo-a', sha: '1'.repeat(40), subject: '', body: '',
  author: 'Dev', committedAt: '2026-01-01T00:00:00Z', ...over
});

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  config, compiled, changeset,
  commits: [commit({ subject: 'PROJ-42 and PROJ-99' })],
  ranges: [range('repo-a')],
  cliVersion: '0.1.0',
  configFingerprint: FINGERPRINT,
  ...over
});

describe('reconcile', () => {
  it('links a commit and keeps its unknown reference', () => {
    const out = reconcile(input());
    expect(out.commits[0]?.findings).toEqual(['unknown-reference']);
    expect(out.items.find((i) => i.id === 'PROJ-42')?.commits).toHaveLength(1);
  });

  it('flags an item with no commits', () => {
    expect(reconcile(input()).items.find((i) => i.id === 'PROJ-77')?.findings).toEqual(['item-without-commits']);
  });

  it('carries item metadata into the output', () => {
    const item = reconcile(input()).items[0];
    expect(item).toMatchObject({ id: 'PROJ-42', title: 'first', type: 'story', status: 'done' });
  });

  it('records preset, history and the full changeset in the output', () => {
    const out = reconcile(input());
    expect(out.preset).toBe('tracker-keys@1');
    expect(out.history).toBe('first-parent');
    expect(out.changeset.items).toHaveLength(2);
    expect(out.changeset.source.kind).toBe('k');
  });

  it('retains the commit body', () => {
    const out = reconcile(input({ commits: [commit({ subject: 'PROJ-42', body: 'context line' })] }));
    expect(out.commits[0]?.body).toBe('context line');
  });

  it('marks an ignored commit, extracts nothing, and excludes it from findings', () => {
    const out = reconcile(input({ commits: [commit({ subject: 'Merge branch PROJ-42' })] }));
    expect(out.commits[0]?.ignored?.rule).toBe('subjects:^Merge branch');
    expect(out.commits[0]?.references).toEqual([]);
    expect(out.commits[0]?.findings).toEqual([]);
    expect(out.summary.noReference).toBe(0);
    expect(out.items.find((i) => i.id === 'PROJ-42')?.commits).toEqual([]);
  });

  it('deduplicates item commit links by repo and sha', () => {
    const twice = commit({ subject: 'PROJ-42 PROJ-42', sha: '9'.repeat(40) });
    const out = reconcile(input({ commits: [twice] }));
    expect(out.items.find((i) => i.id === 'PROJ-42')?.commits).toHaveLength(1);
  });

  it('orders ranges by config repo order', () => {
    const out = reconcile(input({ ranges: [range('repo-b'), range('repo-a')] }));
    expect(out.ranges.map((r) => r.repo)).toEqual(['repo-a', 'repo-b']);
  });

  it('orders items in changeset order', () => {
    expect(reconcile(input()).items.map((i) => i.id)).toEqual(['PROJ-42', 'PROJ-77']);
  });

  it('omits generatedAt when now is absent and includes it when present', () => {
    expect(reconcile(input()).generatedAt).toBeUndefined();
    expect(reconcile(input({ now: '2026-09-01T00:00:00Z' })).generatedAt).toBe('2026-09-01T00:00:00Z');
  });

  it('is byte-identical for identical input', () => {
    expect(JSON.stringify(reconcile(input()))).toBe(JSON.stringify(reconcile(input())));
  });

  it('propagates a range finding into the verdict when policy fails on it', () => {
    const failing = mergeConfig({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../a' }]
    }, '/tmp');
    const out = reconcile(input({
      config: failing,
      ranges: [range('repo-a', { baseIsAncestorOfHead: false, findings: ['range-divergence'] })]
    }));
    expect(out.verdict).toBe('fail');
    expect(out.violations).toContainEqual({ finding: 'range-divergence', count: 1 });
  });
});
```

Run: `npm test --workspace shipledger -- reconcile`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/core/reconcile.ts`**

```ts
import { extractReferences } from './tokens.js';
import { buildItemIndex, resolveReferences } from './index-items.js';
import { commitFindings, decideVerdict, matchIgnoreRule, summarise } from './findings.js';
import type { CompiledIgnore, CompiledMatcher } from './compile.js';
import type {
  Changeset, CommitRecord, CommitResult, ItemResult, RangeResult,
  ResolvedConfig, VerifiedChangeset
} from '../types.js';

export interface ReconcileInput {
  config: ResolvedConfig;
  /** Compiled before any repository was opened. */
  compiled: { matchers: CompiledMatcher[]; ignore: CompiledIgnore };
  changeset: Changeset;
  commits: CommitRecord[];
  ranges: RangeResult[];
  cliVersion: string;
  configFingerprint: string;
  /** Omit for --stable output. */
  now?: string;
}

export function reconcile(input: ReconcileInput): VerifiedChangeset {
  const { config, changeset, compiled } = input;
  const index = buildItemIndex(changeset, config.matchers);
  const repoOrder = new Map(config.repos.map((r, i) => [r.name, i]));

  const linksByItem = new Map<string, Array<{ repo: string; sha: string }>>();
  for (const item of changeset.items) linksByItem.set(item.id, []);

  const commits: CommitResult[] = input.commits.map((commit) => {
    const base = {
      repo: commit.repo, sha: commit.sha, subject: commit.subject, body: commit.body,
      author: commit.author, committedAt: commit.committedAt
    };

    const rule = matchIgnoreRule(commit, compiled.ignore);
    if (rule !== null) {
      return { ...base, ignored: { rule }, references: [], findings: [] };
    }

    const { references, links } = resolveReferences(
      extractReferences(commit, compiled.matchers), commit.repo, index
    );
    for (const { itemId } of links) {
      const bucket = linksByItem.get(itemId);
      if (!bucket) continue;
      if (!bucket.some((c) => c.repo === commit.repo && c.sha === commit.sha)) {
        bucket.push({ repo: commit.repo, sha: commit.sha });
      }
    }
    return { ...base, ignored: null, references, findings: commitFindings(references, false) };
  });

  const items: ItemResult[] = changeset.items.map((item) => {
    const linked = linksByItem.get(item.id) ?? [];
    return {
      id: item.id, title: item.title, type: item.type, status: item.status,
      commits: linked,
      findings: linked.length === 0 ? ['item-without-commits'] : []
    };
  });

  const ranges = [...input.ranges].sort(
    (a, b) => (repoOrder.get(a.repo) ?? 0) - (repoOrder.get(b.repo) ?? 0)
  );

  const sets = { commits, items, ranges };
  const { verdict, violations } = decideVerdict({ ...sets, policy: config.policy });

  return {
    version: 1,
    ...(input.now === undefined ? {} : { generatedAt: input.now }),
    cliVersion: input.cliVersion,
    preset: `${config.presetName}@${config.presetVersion}`,
    history: config.history,
    configFingerprint: input.configFingerprint,
    changeset: { id: changeset.id, source: changeset.source, items: changeset.items },
    ranges,
    commits,
    items,
    summary: summarise(sets),
    verdict,
    violations
  };
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test --workspace shipledger -- reconcile`
Expected: all twelve tests PASS.

- [ ] **Step 4: Confirm the output validates against its own schema**

Add to the same test file:

```ts
it('produces output that satisfies the published verified-changeset schema', async () => {
  const { validateVerified } = await import('../../src/config/validate.js');
  const out = reconcile(input({ now: '2026-09-01T00:00:00Z' }));
  expect(() => validateVerified(JSON.parse(JSON.stringify(out)))).not.toThrow();
});

it('satisfies the schema with generatedAt absent', async () => {
  const { validateVerified } = await import('../../src/config/validate.js');
  expect(() => validateVerified(JSON.parse(JSON.stringify(reconcile(input()))))).not.toThrow();
});
```

These two tests are the reason every sha-shaped and fingerprint-shaped fixture value at the top of the file is real hex of the right length. A plausible-looking placeholder such as `'h'.repeat(40)` or `sha256:test` satisfies TypeScript and fails the schema, and the failure looks like an emitter bug rather than a bad fixture.

Run: `npm test --workspace shipledger -- reconcile`
Expected: PASS. If it fails, the schema and the emitter disagree — fix whichever is wrong against the spec, not whichever is easier.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/core/reconcile.ts packages/cli/test/core/reconcile.test.ts
git commit -m "feat: reconcile orchestration emitting self-contained verified output"
```

---

### Task 9: Git layer

**Files:**
- Create: `packages/cli/src/git/{exec,refs,log}.ts`
- Create: `packages/cli/test/helpers/repo.ts`
- Test: `packages/cli/test/git/{refs,log}.test.ts`

**Interfaces:**
- Consumes: `envError`, `CommitRecord`, `RangeResult`, `RangeSpec`, `HistoryMode`.
- Produces:
  - `gitOut(args: string[], cwd: string): string` — stdout, exit-3 on any failure.
  - `gitStatus(args: string[], cwd: string): { code: number; stdout: string; stderr: string }` — for the ancestry test only.
  - `assertUsableRepo(repoPath: string, repoName: string): void`
  - `resolveRange(spec: RangeSpec, repoPath: string): RangeResult`
  - `walkRange(range: RangeResult, repoPath: string, history: HistoryMode): CommitRecord[]` — takes the **resolved** range and walks SHAs.
  - Test helper `makeRepo(): FixtureRepo`.

- [ ] **Step 1: Write the fixture repo builder**

`packages/cli/test/helpers/repo.ts`:

```ts
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

  run(['init', '-q', '-b', 'main']);
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
```

- [ ] **Step 2: Write the failing refs test**

`packages/cli/test/git/refs.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertUsableRepo, resolveRange } from '../../src/git/refs.js';
import { CliError } from '../../src/errors.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

let repo: FixtureRepo | undefined;
const extras: string[] = [];

afterEach(() => {
  repo?.cleanup();
  for (const d of extras.splice(0)) rmSync(d, { recursive: true, force: true });
  repo = undefined;
});

describe('assertUsableRepo', () => {
  it('accepts a normal repo', () => {
    repo = makeRepo();
    repo.commit('init');
    expect(() => assertUsableRepo(repo!.path, 'repo-a')).not.toThrow();
  });

  it('rejects a missing directory with exit 3 and names the repo', () => {
    try {
      assertUsableRepo('/nonexistent/repo', 'repo-a');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as Error).message).toMatch(/repo-a/);
    }
  });

  it('rejects a directory that is not a work tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shipledger-plain-'));
    extras.push(dir);
    expect(() => assertUsableRepo(dir, 'repo-a')).toThrow(/work tree/);
  });

  it('rejects a shallow clone and names the remedy', () => {
    repo = makeRepo();
    repo.commit('one'); repo.commit('two');
    const shallow = mkdtempSync(join(tmpdir(), 'shipledger-shallow-'));
    extras.push(shallow);
    rmSync(shallow, { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repo.path}`, shallow]);
    expect(() => assertUsableRepo(shallow, 'repo-a')).toThrow(/unshallow/);
  });
});

describe('resolveRange', () => {
  it('resolves shas and reports linear ancestry', () => {
    repo = makeRepo();
    repo.commit('one'); repo.tag('v1');
    repo.commit('two'); repo.tag('v2');
    const out = resolveRange({ repo: 'repo-a', base: 'v1', head: 'v2' }, repo.path);
    expect(out.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.baseIsAncestorOfHead).toBe(true);
    expect(out.commitsOnlyInBase).toBe(0);
    expect(out.findings).toEqual([]);
  });

  it('defaults include to an empty array and preserves it when given', () => {
    repo = makeRepo();
    repo.commit('one'); repo.tag('v1'); repo.commit('two'); repo.tag('v2');
    expect(resolveRange({ repo: 'r', base: 'v1', head: 'v2' }, repo.path).include).toEqual([]);
    expect(resolveRange({ repo: 'r', base: 'v1', head: 'v2', include: ['a/**'] }, repo.path).include).toEqual(['a/**']);
  });

  it('flags range-divergence for independently cut branches', () => {
    repo = makeRepo();
    repo.commit('root');
    repo.branch('release-a'); repo.branch('release-b');
    repo.checkout('release-a'); repo.commit('only on a');
    repo.checkout('release-b'); repo.commit('only on b');
    const out = resolveRange({ repo: 'repo-a', base: 'release-a', head: 'release-b' }, repo.path);
    expect(out.baseIsAncestorOfHead).toBe(false);
    expect(out.commitsOnlyInBase).toBe(1);
    expect(out.findings).toEqual(['range-divergence']);
    expect(out.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects an unresolvable ref with exit 3', () => {
    repo = makeRepo();
    repo.commit('one');
    try {
      resolveRange({ repo: 'repo-a', base: 'v-nope', head: 'HEAD' }, repo.path);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as Error).message).toMatch(/v-nope/);
    }
  });
});
```

Run: `npm test --workspace shipledger -- git/refs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the git modules**

`packages/cli/src/git/exec.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { envError } from '../errors.js';

/** Never accepts a shell string — args are always an explicit array. */
export function gitStatus(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
```

`packages/cli/src/git/refs.ts`:

```ts
import { existsSync } from 'node:fs';
import { envError } from '../errors.js';
import { gitOut, gitStatus } from './exec.js';
import type { RangeResult, RangeSpec } from '../types.js';

export function assertUsableRepo(repoPath: string, repoName: string): void {
  if (!existsSync(repoPath)) {
    throw envError(`Repo "${repoName}" is configured at ${repoPath}, which does not exist. Clone it there or fix "path" in the config.`);
  }
  const inTree = gitStatus(['rev-parse', '--is-inside-work-tree'], repoPath);
  if (inTree.code !== 0 || inTree.stdout.trim() !== 'true') {
    throw envError(`Repo "${repoName}" at ${repoPath} is not a git work tree.`);
  }
  if (gitOut(['rev-parse', '--is-shallow-repository'], repoPath).trim() === 'true') {
    throw envError(`Repo "${repoName}" at ${repoPath} is a shallow clone, so a commit range cannot be walked. Run: git -C ${repoPath} fetch --unshallow`);
  }
}

function resolveRef(ref: string, repoPath: string, repoName: string): string {
  const out = gitStatus(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath);
  const sha = out.stdout.trim();
  if (out.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw envError(`Ref "${ref}" does not resolve to a commit in repo "${repoName}" (${repoPath}). Refs are read locally and never fetched — fetch it yourself if it is missing.`);
  }
  return sha;
}

/** Resolves once. Everything downstream walks these SHAs, never the ref names. */
export function resolveRange(spec: RangeSpec, repoPath: string): RangeResult {
  const baseSha = resolveRef(spec.base, repoPath, spec.repo);
  const headSha = resolveRef(spec.head, repoPath, spec.repo);

  const mergeBaseResult = gitStatus(['merge-base', baseSha, headSha], repoPath);
  // Status 1 means no common ancestor; anything else non-zero is a real failure.
  if (mergeBaseResult.code !== 0 && mergeBaseResult.code !== 1) {
    throw envError(`git merge-base failed in ${repoPath} (status ${mergeBaseResult.code}): ${mergeBaseResult.stderr}`);
  }
  const mergeBase = mergeBaseResult.code === 0 ? mergeBaseResult.stdout.trim() : null;

  const ancestry = gitStatus(['merge-base', '--is-ancestor', baseSha, headSha], repoPath);
  if (ancestry.code !== 0 && ancestry.code !== 1) {
    throw envError(`git merge-base --is-ancestor failed in ${repoPath} (status ${ancestry.code}): ${ancestry.stderr}`);
  }
  const baseIsAncestorOfHead = ancestry.code === 0;

  const commitsOnlyInBase = Number(gitOut(['rev-list', '--count', `${headSha}..${baseSha}`], repoPath).trim());

  return {
    repo: spec.repo,
    base: spec.base, baseSha,
    head: spec.head, headSha,
    include: spec.include ?? [],
    mergeBase,
    baseIsAncestorOfHead,
    commitsOnlyInBase,
    findings: baseIsAncestorOfHead ? [] : ['range-divergence']
  };
}
```

`packages/cli/src/git/log.ts`:

```ts
import { envError } from '../errors.js';
import { gitOut } from './exec.js';
import type { CommitRecord, HistoryMode, RangeResult } from '../types.js';

const FIELDS = 5;
// NUL-delimited: git forbids NUL in commit messages, so this is lossless.
const FORMAT = ['%H', '%an', '%cI', '%s', '%b'].join('%x00') + '%x00';

/**
 * Exported for direct testing: malformed framing cannot be induced through real
 * git, and silently returning a short list would understate a release.
 */
export function parseLogOutput(raw: string, repo: string, repoPath: string): CommitRecord[] {
  const fail = (why: string): never => {
    throw envError(`Unparseable git log output for repo "${repo}" in ${repoPath}: ${why}. This is a bug or a git version difference — the count cannot be trusted, so nothing is reported.`);
  };

  const parts = raw.split('\u0000');
  // The format ends with %x00, so the final chunk is always git's newline after
  // the last record — or '' when the range is empty.
  const tail = parts.pop();
  if (tail !== undefined && tail.trim() !== '') {
    fail(`unexpected trailing data after the final record (${JSON.stringify(tail.slice(0, 40))})`);
  }
  if (parts.length % FIELDS !== 0) {
    fail(`got ${parts.length} field(s), which is not a multiple of ${FIELDS}`);
  }

  const out: CommitRecord[] = [];
  for (let i = 0; i < parts.length; i += FIELDS) {
    // Only the sha is trimmed: it absorbs git's inter-record newline and can
    // never contain meaningful whitespace. Subject and body are untouched.
    const sha = (parts[i] as string).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      fail(`expected a commit sha in field ${i}, got ${JSON.stringify(sha.slice(0, 48))}`);
    }
    out.push({
      repo,
      sha,
      author: parts[i + 1] as string,
      committedAt: parts[i + 2] as string,
      subject: parts[i + 3] as string,
      body: parts[i + 4] as string
    });
  }
  return out;
}

/** Walks the resolved SHAs, never the mutable ref names. */
export function walkRange(range: RangeResult, repoPath: string, history: HistoryMode): CommitRecord[] {
  const args = ['log', `--format=${FORMAT}`];
  if (history === 'first-parent') args.push('--first-parent');
  args.push(`${range.baseSha}..${range.headSha}`);
  if (range.include.length > 0) args.push('--', ...range.include);

  return parseLogOutput(gitOut(args, repoPath), range.repo, repoPath);
}
```

- [ ] **Step 4: Write the failing log test and run everything**

`packages/cli/test/git/log.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { walkRange, parseLogOutput } from '../../src/git/log.js';
import { resolveRange } from '../../src/git/refs.js';
import { CliError } from '../../src/errors.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import type { RangeSpec } from '../../src/types.js';

let repo: FixtureRepo | undefined;
afterEach(() => { repo?.cleanup(); repo = undefined; });

const walk = (spec: RangeSpec, path: string, history: 'first-parent' | 'all') =>
  walkRange(resolveRange(spec, path), path, history);

describe('walkRange', () => {
  it('returns commits in the range and none outside it', () => {
    repo = makeRepo();
    repo.commit('before'); repo.tag('v1');
    repo.commit('PROJ-1 first');
    repo.commit('PROJ-2 second'); repo.tag('v2');
    const out = walk({ repo: 'repo-a', base: 'v1', head: 'v2' }, repo.path, 'all');
    expect(out.map((c) => c.subject)).toEqual(['PROJ-2 second', 'PROJ-1 first']);
  });

  it('captures author as bare %an, not name-and-email', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('PROJ-3 subject', { author: 'dependabot[bot]' });
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out[0]?.author).toBe('dependabot[bot]');
  });

  it('parses a multi-line body losslessly', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('PROJ-4 subject', { body: 'first line\n\nsecond line refs PROJ-9' });
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out[0]?.body).toContain('first line');
    expect(out[0]?.body).toContain('second line refs PROJ-9');
  });

  it('parses a subject containing separators and special characters', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    const tricky = 'PROJ-5: fix "quoted" | piped \\ backslash and (#42)';
    repo.commit(tricky);
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out[0]?.subject).toBe(tricky);
  });

  it('yields one commit for a squash merge, carrying the pull request number', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('wip one'); repo.commit('wip two'); repo.commit('wip three');
    repo.checkout('main');
    repo.run(['merge', '-q', '--squash', 'feature']);
    repo.run(['commit', '-q', '-m', 'PROJ-8: squashed feature (#42)']);
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'first-parent');
    expect(out).toHaveLength(1);
    expect(out[0]?.subject).toBe('PROJ-8: squashed feature (#42)');
  });

  it('sees a squashed commit identically under history all, since it has one parent', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('wip one'); repo.commit('wip two');
    repo.checkout('main');
    repo.run(['merge', '-q', '--squash', 'feature']);
    repo.run(['commit', '-q', '-m', 'PROJ-8: squashed (#42)']);
    expect(walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all')).toHaveLength(1);
  });

  it('first-parent yields one entry per merge; all yields every commit', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('wip one'); repo.commit('wip two');
    repo.checkout('main');
    repo.mergeNoFf('feature', 'Merge pull request #7 from feature');
    const first = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'first-parent');
    const all = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(first).toHaveLength(1);
    expect(first[0]?.subject).toContain('#7');
    expect(all.length).toBeGreaterThan(1);
  });

  it('handles a rebase-merged branch under history all', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.branch('feature'); repo.checkout('feature');
    repo.commit('PROJ-6 one'); repo.commit('PROJ-7 two');
    repo.checkout('main'); repo.commit('main moves on');
    repo.checkout('feature'); repo.rebaseOnto('main');
    repo.checkout('main'); repo.run(['merge', '-q', '--ff-only', 'feature']);
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD' }, repo.path, 'all');
    expect(out.map((c) => c.subject)).toContain('PROJ-6 one');
    expect(out.map((c) => c.subject)).toContain('PROJ-7 two');
  });

  it('applies nested include paths as a pathspec', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('touches a', { file: 'packages/a/src/x.txt' });
    repo.commit('touches b', { file: 'packages/b/src/y.txt' });
    const out = walk({ repo: 'r', base: 'v1', head: 'HEAD', include: ['packages/a/**'] }, repo.path, 'all');
    expect(out.map((c) => c.subject)).toEqual(['touches a']);
  });

  it('walks the resolved sha even after the ref moves', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1');
    repo.commit('inside range'); repo.tag('v2');
    const resolved = resolveRange({ repo: 'r', base: 'v1', head: 'v2' }, repo.path);
    repo.commit('added after resolution'); repo.moveTag('v2');
    const out = walkRange(resolved, repo.path, 'all');
    expect(out.map((c) => c.subject)).toEqual(['inside range']);
  });

  it('tags every commit with the configured repo name', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1'); repo.commit('next');
    expect(walk({ repo: 'repo-b', base: 'v1', head: 'HEAD' }, repo.path, 'all')[0]?.repo).toBe('repo-b');
  });

  it('returns an empty list for an empty range', () => {
    repo = makeRepo();
    repo.commit('only'); repo.tag('v1');
    expect(walk({ repo: 'r', base: 'v1', head: 'v1' }, repo.path, 'all')).toEqual([]);
  });
});

describe('parseLogOutput framing', () => {
  const sha = 'a'.repeat(40);
  const record = (s: string, subject = 'subj', body = ''): string =>
    [s, 'Dev', '2026-01-01T00:00:00+00:00', subject, body].join('\u0000') + '\u0000';

  it('parses a well-formed single record', () => {
    const out = parseLogOutput(`${record(sha)}\n`, 'r', '/tmp/x');
    expect(out).toHaveLength(1);
    expect(out[0]?.sha).toBe(sha);
  });

  it('parses two records, absorbing the inter-record newline into the sha field', () => {
    const b = 'b'.repeat(40);
    const out = parseLogOutput(`${record(sha)}\n${record(b)}\n`, 'r', '/tmp/x');
    expect(out.map((c) => c.sha)).toEqual([sha, b]);
  });

  it('treats empty output as no commits', () => {
    expect(parseLogOutput('', 'r', '/tmp/x')).toEqual([]);
  });

  it('throws rather than truncating when a field is missing', () => {
    const truncated = [sha, 'Dev', '2026-01-01T00:00:00+00:00'].join('\u0000') + '\u0000';
    expect(() => parseLogOutput(`${truncated}\n`, 'r', '/tmp/x')).toThrow(/not a multiple/);
  });

  it('throws rather than silently stopping when a sha is malformed', () => {
    const bad = `${record(sha)}\n${record('not-a-sha')}\n`;
    expect(() => parseLogOutput(bad, 'r', '/tmp/x')).toThrow(/expected a commit sha/);
  });

  it('throws on unexpected trailing data', () => {
    expect(() => parseLogOutput(`${record(sha)}\nleftover`, 'r', '/tmp/x')).toThrow(/trailing data/);
  });

  it('reports framing failures as environment errors, not usage errors', () => {
    try {
      parseLogOutput('garbage', 'r', '/tmp/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
    }
  });

  it('does not trim subject or body', () => {
    const out = parseLogOutput(`${record(sha, '  padded  ', ' body \n\n')}\n`, 'r', '/tmp/x');
    expect(out[0]?.subject).toBe('  padded  ');
    expect(out[0]?.body).toBe(' body \n\n');
  });
});
```

Run: `npm test --workspace shipledger -- git && npm run typecheck --workspace shipledger`
Expected: all refs and log tests PASS. The mutable-ref test is the load-bearing one — it proves resolution happens once.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/git packages/cli/test/git packages/cli/test/helpers
git commit -m "feat: repository-read-only git layer with SHA walking and lossless parsing"
```

---

### Task 10: `check` command

**Files:**
- Create: `packages/cli/src/io/atomic.ts`, `packages/cli/src/cli/version.ts`, `packages/cli/src/cli/check.ts`, `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/cli/check.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 8, 9.
- Produces: `writeAtomic(path: string, contents: string): void`; `CLI_VERSION`; `runCheck(argv: string[], cwd: string): number`; `main(argv: string[]): Promise<number>`.

**Ordering requirement:** load and validate config, check identities, compile matchers and ignore rules, load and validate the changeset, cross-check it — **all before any repository is opened**.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cli/check.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheck } from '../../src/cli/check.js';
import { validateVerified } from '../../src/config/validate.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

let repo: FixtureRepo | undefined;
let extraRepo: FixtureRepo | undefined;
let work: string | undefined;

// Most cases here assert non-zero exits, which write diagnostics to stderr.
// Silencing keeps expected failures from reading like test failures.
beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  repo?.cleanup();
  extraRepo?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
  repo = undefined; extraRepo = undefined; work = undefined;
  vi.restoreAllMocks();
});

const item = (id: string, token: string) => ({
  id, title: 't', type: 'story', status: 'done',
  tokens: [{ matcher: 'ticket-key', token }]
});

function scenario(opts: { subjects: string[]; items: unknown[]; failOn?: string[]; preset?: string }) {
  repo = makeRepo();
  repo.commit('base'); repo.tag('v1');
  for (const s of opts.subjects) repo.commit(s);
  repo.tag('v2');

  work = mkdtempSync(join(tmpdir(), 'shipledger-work-'));
  writeFileSync(join(work, 'config.json'), JSON.stringify({
    version: 1,
    preset: opts.preset ?? 'tracker-keys@1',
    repos: [{ name: 'repo-a', path: repo.path }],
    ...(opts.failOn ? { policy: { failOn: opts.failOn } } : {})
  }));
  writeFileSync(join(work, 'changeset.json'), JSON.stringify({
    version: 1, id: 'release 1.4.0',
    source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
    items: opts.items,
    ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
  }));
  return {
    args: ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json'), '--out', join(work, 'out.json')],
    out: join(work, 'out.json'),
    configPath: join(work, 'config.json'),
    changesetPath: join(work, 'changeset.json')
  };
}

describe('runCheck', () => {
  it('exits 0 and writes schema-valid output when everything reconciles', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: ['no-reference', 'unknown-reference', 'item-without-commits'] });
    expect(runCheck(s.args, process.cwd())).toBe(0);
    const out = JSON.parse(readFileSync(s.out, 'utf8'));
    expect(out.verdict).toBe('pass');
    expect(() => validateVerified(out)).not.toThrow();
  });

  it('exits 1 on a policy violation but still writes the output', () => {
    const s = scenario({ subjects: ['PROJ-9 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: ['unknown-reference'] });
    expect(runCheck(s.args, process.cwd())).toBe(1);
    const out = JSON.parse(readFileSync(s.out, 'utf8'));
    expect(out.verdict).toBe('fail');
    expect(out.violations[0].finding).toBe('unknown-reference');
  });

  it('exits 2 when the preset is unpinned', () => {
    const s = scenario({ subjects: ['x'], items: [], preset: 'tracker-keys' });
    expect(runCheck(s.args, process.cwd())).toBe(2);
  });

  it('exits 2 when the changeset names an undefined repo', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    const bad = JSON.parse(readFileSync(s.changesetPath, 'utf8'));
    bad.ranges = [{ repo: 'ghost', base: 'v1', head: 'v2' }];
    writeFileSync(s.changesetPath, JSON.stringify(bad));
    expect(runCheck(s.args, process.cwd())).toBe(2);
  });

  it('exits 2 for an invalid matcher pattern before opening any repository', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    writeFileSync(s.configPath, JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'repo-a', path: '/nonexistent/repo' }],
      matchers: [{ id: 'bad', sources: ['subject'], pattern: '([', namespace: 'global', normalize: 'none' }]
    }));
    // The repo path is deliberately missing: a code of 2 proves compilation ran first.
    expect(runCheck(s.args, process.cwd())).toBe(2);
  });

  it('exits 3 when a configured repo path does not exist', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    writeFileSync(s.configPath, JSON.stringify({
      version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '/nonexistent/repo' }]
    }));
    expect(runCheck(s.args, process.cwd())).toBe(3);
  });

  it('exits 2 when --changeset is missing', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    expect(runCheck(['--config', s.configPath], process.cwd())).toBe(2);
  });

  it('exits 2 for an unknown flag', () => {
    const s = scenario({ subjects: ['x'], items: [] });
    expect(runCheck([...s.args, '--turbo'], process.cwd())).toBe(2);
  });

  it('omits generatedAt under --stable and is byte-identical across runs', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    runCheck([...s.args, '--stable'], process.cwd());
    const first = readFileSync(s.out, 'utf8');
    runCheck([...s.args, '--stable'], process.cwd());
    expect(readFileSync(s.out, 'utf8')).toBe(first);
    expect(JSON.parse(first).generatedAt).toBeUndefined();
  });

  it('includes generatedAt without --stable', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    runCheck(s.args, process.cwd());
    expect(JSON.parse(readFileSync(s.out, 'utf8')).generatedAt).toMatch(/^\d{4}-/);
  });

  it('writes sorted keys so output diffs cleanly', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    runCheck([...s.args, '--stable'], process.cwd());
    const text = readFileSync(s.out, 'utf8');
    expect(text.indexOf('"changeset"')).toBeLessThan(text.indexOf('"cliVersion"'));
  });

  it('exits 3 when the output path is not writable', () => {
    const s = scenario({ subjects: ['PROJ-1 fix'], items: [item('PROJ-1', 'PROJ-1')], failOn: [] });
    const args = ['--config', s.configPath, '--changeset', s.changesetPath, '--out', '/nonexistent-dir/out.json'];
    expect(runCheck(args, process.cwd())).toBe(3);
  });

  it('walks repos in config order regardless of the order ranges appear in the changeset', () => {
    repo = makeRepo();
    repo.commit('base'); repo.tag('v1'); repo.commit('PROJ-1 in first repo'); repo.tag('v2');
    extraRepo = makeRepo();
    extraRepo.commit('base'); extraRepo.tag('v1'); extraRepo.commit('PROJ-2 in second repo'); extraRepo.tag('v2');

    work = mkdtempSync(join(tmpdir(), 'shipledger-order-'));
    const out = join(work, 'out.json');
    writeFileSync(join(work, 'config.json'), JSON.stringify({
      version: 1, preset: 'tracker-keys@1',
      repos: [{ name: 'alpha', path: repo.path }, { name: 'beta', path: extraRepo.path }],
      policy: { failOn: [] }
    }));
    // Ranges deliberately listed beta-first.
    writeFileSync(join(work, 'changeset.json'), JSON.stringify({
      version: 1, id: 'r',
      source: { kind: 'test', ref: 'local', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [item('PROJ-1', 'PROJ-1'), item('PROJ-2', 'PROJ-2')],
      ranges: [
        { repo: 'beta', base: 'v1', head: 'v2' },
        { repo: 'alpha', base: 'v1', head: 'v2' }
      ]
    }));

    const args = ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json'), '--out', out, '--stable'];
    expect(runCheck(args, process.cwd())).toBe(0);
    const verified = validateVerified(JSON.parse(readFileSync(out, 'utf8')));
    expect(verified.commits.map((c) => c.repo)).toEqual(['alpha', 'beta']);
    expect(verified.ranges.map((r) => r.repo)).toEqual(['alpha', 'beta']);
  });
});
```

Run: `npm test --workspace shipledger -- cli/check`
Expected: FAIL — modules not found.

- [ ] **Step 2: Implement `src/io/atomic.ts`, `src/cli/version.ts`, and `src/cli/args.ts`**

`packages/cli/src/io/atomic.ts`:

```ts
import { renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { envError } from '../errors.js';

export function writeAtomic(path: string, contents: string): void {
  const tmp = join(dirname(path), `.shipledger-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw envError(`Cannot write ${path}: ${(err as Error).message}`);
  }
}
```

`packages/cli/src/cli/version.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
export const CLI_VERSION: string = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
```

`packages/cli/src/cli/args.ts` — one place turns an argument-parsing failure into
exit 2, so an unknown flag cannot be reported differently by different commands:

```ts
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { usageError } from '../errors.js';

export function parseOrUsage<T>(config: ParseArgsConfig): T {
  try {
    return parseArgs(config).values as T;
  } catch (err) {
    throw usageError((err as Error).message);
  }
}
```

- [ ] **Step 3: Implement `src/cli/check.ts`**

```ts
import { resolve } from 'node:path';
import { toExitCode, usageError } from '../errors.js';
import { parseOrUsage } from './args.js';
import { loadConfig } from '../config/load.js';
import { assertChangesetAgainstConfig, loadChangeset } from '../config/changeset.js';
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

    // Everything below this line happens before any repository is opened.
    const { config, configFingerprint } = loadConfig(resolve(cwd, values.config), CLI_VERSION);
    const compiled = compileAll(config);
    const changeset = loadChangeset(resolve(cwd, values.changeset));
    assertChangesetAgainstConfig(changeset, config);

    // Iterate config order rather than changeset order. V1 permits one range
    // per repo, so this visits every range exactly once, and it makes the
    // `commits` array independent of how the agent happened to order `ranges`.
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
```

- [ ] **Step 4: Implement `src/cli/index.ts` and run the tests**

```ts
#!/usr/bin/env node
import { runCheck } from './check.js';

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

/**
 * String-concatenating `file://` breaks on spaces (percent-encoding), on the
 * symlink npm creates in `node_modules/.bin`, and on Windows drive paths.
 * `realpathSync` plus `pathToFileURL` handles all three.
 */
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
```

The imports at the top of this file are therefore:

```ts
#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCheck } from './check.js';
```

`doctor`, `init`, and `render` join this switch in Tasks 11–13.

Run: `npm test --workspace shipledger -- cli/check && npm run typecheck --workspace shipledger`
Expected: all thirteen tests PASS. Two of them earn their place: "invalid matcher pattern with a missing repo path" is the ordering proof, where exit 2 rather than 3 means compilation ran before the repository was touched; and the config-order test proves `commits` does not inherit the changeset's range ordering.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/io packages/cli/src/cli packages/cli/test/cli
git commit -m "feat: check command, validate-before-git ordering, atomic output"
```

---

### Task 11: `doctor` command with skill compatibility

**Files:**
- Create: `packages/cli/src/cli/doctor.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `compileAll`, `loadChangeset`, `assertChangesetAgainstConfig`, `assertUsableRepo`, `resolveRange`, `CLI_VERSION`.
- Produces: `runDoctor(argv: string[], cwd: string): number`. Accepts `--skill-cli-range <semver range>` and reports incompatibility. Returns `0` when everything checkable is fine, `2` for config or changeset errors, `3` for environment problems.

Range checking uses a deliberately small subset — `^x.y.z`, `>=x.y.z`, and `x.y.z` — implemented inline rather than adding a semver dependency. Anything else is reported as unparseable rather than silently accepted.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cli/doctor.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../../src/cli/doctor.js';
import { CLI_VERSION } from '../../src/cli/version.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';

let repo: FixtureRepo | undefined;
let work: string | undefined;

afterEach(() => {
  repo?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
  repo = undefined; work = undefined;
  vi.restoreAllMocks();
});

function capture(): { text: () => string } {
  let buf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { buf += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { buf += String(c); return true; });
  return { text: () => buf };
}

function setup(repoPath: string, preset = 'tracker-keys@1') {
  work = mkdtempSync(join(tmpdir(), 'shipledger-doc-'));
  writeFileSync(join(work, 'config.json'), JSON.stringify({
    version: 1, preset, repos: [{ name: 'repo-a', path: repoPath }]
  }));
  writeFileSync(join(work, 'changeset.json'), JSON.stringify({
    version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
    items: [], ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
  }));
  return ['--config', join(work, 'config.json'), '--changeset', join(work, 'changeset.json')];
}

function healthyRepo(): FixtureRepo {
  const r = makeRepo();
  r.commit('a'); r.tag('v1'); r.commit('b'); r.tag('v2');
  return r;
}

describe('runDoctor', () => {
  it('reports OK for a healthy repo and range', () => {
    repo = healthyRepo();
    const out = capture();
    expect(runDoctor(setup(repo.path), process.cwd())).toBe(0);
    expect(out.text()).toMatch(/OK/);
    expect(out.text()).toMatch(/repo-a/);
  });

  it('prints the fingerprint and resolved preset', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    expect(out.text()).toMatch(/sha256:[0-9a-f]{64}/);
    expect(out.text()).toMatch(/tracker-keys@1/);
  });

  it('states that upstream freshness is unknown', () => {
    repo = healthyRepo();
    const out = capture();
    runDoctor(setup(repo.path), process.cwd());
    expect(out.text()).toMatch(/upstream state is unknown/i);
  });

  it('returns 2 for an unpinned preset', () => {
    repo = healthyRepo();
    capture();
    expect(runDoctor(setup(repo.path, 'tracker-keys'), process.cwd())).toBe(2);
  });

  it('returns 3 and names the remedy for a missing repo', () => {
    const out = capture();
    expect(runDoctor(setup('/nonexistent/repo'), process.cwd())).toBe(3);
    expect(out.text()).toMatch(/does not exist/);
  });

  it('validates the changeset before opening repositories', () => {
    // Both a bad changeset and a missing repo. Exit 2 proves the changeset was
    // cross-checked first; exit 3 would mean the repo was opened first.
    const args = setup('/nonexistent/repo');
    const changesetPath = args[args.indexOf('--changeset') + 1] as string;
    writeFileSync(changesetPath, JSON.stringify({
      version: 1, id: 'r', source: { kind: 'test', ref: 'l', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [], ranges: [{ repo: 'ghost', base: 'v1', head: 'v2' }]
    }));
    const out = capture();
    expect(runDoctor(args, process.cwd())).toBe(2);
    expect(out.text()).toMatch(/ghost/);
  });

  it('reports divergence as a warning without failing', () => {
    repo = makeRepo();
    repo.commit('root');
    repo.branch('a'); repo.branch('b');
    repo.checkout('a'); repo.commit('on a'); repo.tag('v1');
    repo.checkout('b'); repo.commit('on b'); repo.tag('v2');
    const out = capture();
    expect(runDoctor(setup(repo.path), process.cwd())).toBe(0);
    expect(out.text()).toMatch(/WARN/);
    expect(out.text()).toMatch(/diverge/i);
  });

  it('checks only the repos when no changeset is given', () => {
    repo = healthyRepo();
    const args = setup(repo.path).slice(0, 2);
    const out = capture();
    expect(runDoctor(args, process.cwd())).toBe(0);
    expect(out.text()).toMatch(/repo-a/);
  });

  it('reports a compatible skill range as OK', () => {
    repo = healthyRepo();
    const out = capture();
    const code = runDoctor([...setup(repo.path), '--skill-cli-range', `^${CLI_VERSION}`], process.cwd());
    expect(code).toBe(0);
    expect(out.text()).toMatch(/skill/i);
  });

  it('reports an incompatible skill range and fails', () => {
    repo = healthyRepo();
    const out = capture();
    expect(runDoctor([...setup(repo.path), '--skill-cli-range', '^99.0.0'], process.cwd())).toBe(3);
    expect(out.text()).toMatch(/incompatible/i);
  });

  it('reports an unparseable skill range rather than assuming compatibility', () => {
    repo = healthyRepo();
    const out = capture();
    expect(runDoctor([...setup(repo.path), '--skill-cli-range', 'sometimes'], process.cwd())).toBe(3);
    expect(out.text()).toMatch(/cannot interpret/i);
  });
});
```

Run: `npm test --workspace shipledger -- doctor`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/cli/doctor.ts`**

```ts
import { resolve } from 'node:path';
import { toExitCode } from '../errors.js';
import { parseOrUsage } from './args.js';
import { loadConfig } from '../config/load.js';
import { compileAll } from '../core/compile.js';
import { assertChangesetAgainstConfig, loadChangeset } from '../config/changeset.js';
import { assertUsableRepo, resolveRange } from '../git/refs.js';
import { CLI_VERSION } from './version.js';

type RangeCheck = { ok: true; compatible: boolean } | { ok: false };

/** Supports `^x.y.z`, `>=x.y.z`, and an exact `x.y.z`. Anything else is unparseable. */
export function checkCliRange(range: string, version: string): RangeCheck {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const current = parse(version);
  if (!current) return { ok: false };

  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  const gte = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range);
  const exact = /^(\d+\.\d+\.\d+)$/.exec(range);
  const target = parse(caret?.[1] ?? gte?.[1] ?? exact?.[1] ?? '');
  if (!target) return { ok: false };

  const atLeast =
    current[0] > target[0] ||
    (current[0] === target[0] && (current[1] > target[1] ||
      (current[1] === target[1] && current[2] >= target[2])));

  if (caret) {
    // npm caret semantics: the caret pins the leftmost non-zero component, so
    // `^0.1.0` is `>=0.1.0 <0.2.0` and `^0.0.3` means exactly 0.0.3. Treating
    // `^0.1.0` as "any 0.x" would silently accept a pre-1.0 breaking change,
    // which is the situation this tool ships in.
    if (target[0] > 0) return { ok: true, compatible: current[0] === target[0] && atLeast };
    if (target[1] > 0) {
      return { ok: true, compatible: current[0] === 0 && current[1] === target[1] && atLeast };
    }
    return { ok: true, compatible: current.join('.') === target.join('.') };
  }
  if (gte) return { ok: true, compatible: atLeast };
  return { ok: true, compatible: current.join('.') === target.join('.') };
}

export function runDoctor(argv: string[], cwd: string): number {
  const lines: string[] = [];
  let exitCode: 0 | 2 | 3 = 0;

  try {
    const values = parseOrUsage<{ config: string; changeset?: string; 'skill-cli-range'?: string }>({
      args: argv,
      options: {
        config: { type: 'string', default: 'shipledger.config.json' },
        changeset: { type: 'string' },
        'skill-cli-range': { type: 'string' }
      },
      strict: true
    });

    const { config, configFingerprint } = loadConfig(resolve(cwd, values.config), CLI_VERSION);
    compileAll(config);

    // Load and cross-check the changeset here, before any repository is opened,
    // so a malformed changeset is exit 2 rather than being masked by a repo
    // problem reported first.
    const changeset = values.changeset === undefined
      ? undefined
      : loadChangeset(resolve(cwd, values.changeset));
    if (changeset !== undefined) assertChangesetAgainstConfig(changeset, config);

    lines.push(`shipledger ${CLI_VERSION}`);
    lines.push(`preset: ${config.presetName}@${config.presetVersion}`);
    lines.push(`policy failOn: ${config.policy.failOn.join(', ') || '(none)'}`);
    lines.push(`config fingerprint: ${configFingerprint}`);

    const range = values['skill-cli-range'];
    if (range !== undefined) {
      const result = checkCliRange(range, CLI_VERSION);
      if (!result.ok) {
        exitCode = 3;
        lines.push(`FAIL skill compatibility — cannot interpret required CLI range "${range}"`);
      } else if (!result.compatible) {
        exitCode = 3;
        lines.push(`FAIL skill compatibility — the skill requires CLI "${range}" but this is ${CLI_VERSION}. Pin the CLI with npx shipledger@<version>.`);
      } else {
        lines.push(`OK   skill compatibility — CLI ${CLI_VERSION} satisfies "${range}"`);
      }
    }
    lines.push('');

    for (const repo of config.repos) {
      try {
        assertUsableRepo(repo.path, repo.name);
        lines.push(`OK   repo ${repo.name} — ${repo.path}`);
      } catch (err) {
        exitCode = 3;
        lines.push(`FAIL repo ${repo.name} — ${(err as Error).message}`);
      }
    }

    if (changeset !== undefined) {
      const rangeByRepo = new Map(changeset.ranges.map((r) => [r.repo, r]));
      lines.push('');
      // Config order here too, so doctor and check report in the same sequence.
      for (const repo of config.repos) {
        const spec = rangeByRepo.get(repo.name);
        if (spec === undefined) continue;
        try {
          // Not named `range`: that identifier is already the --skill-cli-range
          // value in the enclosing scope, and shadowing it here reads badly.
          const resolved = resolveRange(spec, repo.path);
          if (resolved.baseIsAncestorOfHead) {
            lines.push(`OK   range ${spec.repo} ${spec.base}..${spec.head}`);
          } else {
            lines.push(`WARN range ${spec.repo} ${spec.base}..${spec.head} — refs diverge; ${resolved.commitsOnlyInBase} commit(s) reachable from base but not head will not be seen`);
          }
        } catch (err) {
          exitCode = 3;
          lines.push(`FAIL range ${spec.repo} — ${(err as Error).message}`);
        }
      }
    }

    lines.push('');
    lines.push('Note: refs are read locally and never fetched, so upstream state is unknown.');
  } catch (err) {
    const { code, message } = toExitCode(err);
    lines.push(message);
    exitCode = code === 1 ? 3 : code;
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return exitCode;
}
```

- [ ] **Step 3: Wire it in**

In `packages/cli/src/cli/index.ts` add:

```ts
import { runDoctor } from './doctor.js';
```

```ts
    case 'doctor':
      return runDoctor(rest, process.cwd());
```

- [ ] **Step 4: Add direct unit tests for the range checker, then run everything**

Append to `packages/cli/test/cli/doctor.test.ts`:

```ts
import { checkCliRange } from '../../src/cli/doctor.js';

describe('checkCliRange', () => {
  it('accepts a caret range within the same major', () => {
    expect(checkCliRange('^1.2.0', '1.4.0')).toEqual({ ok: true, compatible: true });
  });

  it('rejects a caret range across a major', () => {
    expect(checkCliRange('^1.2.0', '2.0.0')).toEqual({ ok: true, compatible: false });
  });

  it('rejects a caret range below the floor', () => {
    expect(checkCliRange('^1.4.0', '1.3.9')).toEqual({ ok: true, compatible: false });
  });

  it('pins the minor for a 0.x caret range, since 0.x minors are breaking', () => {
    expect(checkCliRange('^0.1.0', '0.1.0')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('^0.1.0', '0.1.7')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('^0.1.0', '0.2.0')).toEqual({ ok: true, compatible: false });
    expect(checkCliRange('^0.1.2', '0.1.1')).toEqual({ ok: true, compatible: false });
  });

  it('pins the patch for a 0.0.x caret range', () => {
    expect(checkCliRange('^0.0.3', '0.0.3')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('^0.0.3', '0.0.4')).toEqual({ ok: true, compatible: false });
  });

  it('does not treat a 1.x caret as pinning the minor', () => {
    expect(checkCliRange('^1.1.0', '1.9.0')).toEqual({ ok: true, compatible: true });
  });

  it('handles >= ranges', () => {
    expect(checkCliRange('>=1.0.0', '2.5.1')).toEqual({ ok: true, compatible: true });
  });

  it('handles an exact pin', () => {
    expect(checkCliRange('1.2.3', '1.2.3')).toEqual({ ok: true, compatible: true });
    expect(checkCliRange('1.2.3', '1.2.4')).toEqual({ ok: true, compatible: false });
  });

  it('reports an unsupported range form as unparseable', () => {
    expect(checkCliRange('~1.2.3', '1.2.3')).toEqual({ ok: false });
    expect(checkCliRange('1.x', '1.2.3')).toEqual({ ok: false });
  });
});
```

Run: `npm test --workspace shipledger -- doctor && npm run typecheck --workspace shipledger`
Expected: all doctor tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/doctor.ts packages/cli/src/cli/index.ts packages/cli/test/cli/doctor.test.ts
git commit -m "feat: doctor with locally provable facts and skill compatibility"
```

---

### Task 12: `init` command

**Files:**
- Create: `packages/cli/src/cli/init.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/cli/init.test.ts`

**Interfaces:**
- Consumes: `resolvePreset` with `allowUnpinned: true`, `writeAtomic`, `validateConfig`.
- Produces: `runInit(argv: string[], cwd: string): number`. Writes a schema-valid config with the **pinned** preset form, and refuses to overwrite.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cli/init.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../../src/cli/init.js';
import { validateConfig } from '../../src/config/validate.js';
import { mergeConfig } from '../../src/config/load.js';

let work: string | undefined;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
  vi.restoreAllMocks();
});

function silence(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

describe('runInit', () => {
  it('writes a schema-valid config with a pinned default preset', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'shipledger.config.json');
    expect(runInit(['--out', out], work)).toBe(0);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(() => validateConfig(parsed)).not.toThrow();
    expect(parsed.preset).toBe('tracker-keys@1');
  });

  it('pins a bare preset name', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--preset', 'github-oss', '--out', out], work);
    expect(JSON.parse(readFileSync(out, 'utf8')).preset).toBe('github-oss@1');
  });

  it('accepts an already-pinned preset', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    expect(runInit(['--preset', 'github-oss@1', '--out', out], work)).toBe(0);
  });

  it('produces a config that loads without an unpinned-preset error', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--out', out], work);
    const raw = validateConfig(JSON.parse(readFileSync(out, 'utf8')));
    expect(() => mergeConfig(raw, work as string)).not.toThrow();
  });

  it('rejects an unknown preset with exit 2 and writes nothing', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    expect(runInit(['--preset', 'nope', '--out', out], work)).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to overwrite an existing file', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    const out = join(work, 'c.json');
    runInit(['--out', out], work);
    const before = readFileSync(out, 'utf8');
    expect(runInit(['--out', out], work)).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it('exits 2 for an unknown flag', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-init-'));
    silence();
    expect(runInit(['--wat'], work)).toBe(2);
  });
});
```

Run: `npm test --workspace shipledger -- init`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/cli/init.ts`**

```ts
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

    // init is the one place a bare name is allowed; the written file is pinned.
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
```

- [ ] **Step 3: Wire it in**

In `packages/cli/src/cli/index.ts`:

```ts
import { runInit } from './init.js';
```

```ts
    case 'init':
      return runInit(rest, process.cwd());
```

- [ ] **Step 4: Run the tests**

Run: `npm test --workspace shipledger -- init && npm run typecheck --workspace shipledger`
Expected: all seven tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/init.ts packages/cli/src/cli/index.ts packages/cli/test/cli/init.test.ts
git commit -m "feat: init writes a pinned, schema-valid config"
```

---

### Task 13: Notes coverage and verified-artifact semantics

**Files:**
- Create: `packages/cli/src/notes.ts`, `packages/cli/src/verify.ts`
- Create: `packages/cli/test/fixtures/verified-example.json`
- Test: `packages/cli/test/notes.test.ts`, `packages/cli/test/verify.test.ts`

**Interfaces:**
- Consumes: `validateVerified`, `usageError`, `summarise`, `FINDING_ORDER`.
- Produces:
  - Internal, NUL-delimited so no field value can forge a collision: `commitKey(repo, sha)`, `referenceKey(repo, sha, matcher, token)`.
  - `NoteLookup` — maps built from the note arrays, for renderers to consult.
  - `buildNoteLookup(notes: NotesFile): NoteLookup`.
  - `assertNotesCoverFindings(notes: NotesFile, verified: VerifiedChangeset): void` — exit 2 on a missing, extra, duplicated, or whitespace-only entry.
  - `assertVerifiedSemantics(verified: VerifiedChangeset): void` — exit 2 when a structurally valid artifact contradicts itself.

Splitting this from rendering keeps two independently reviewable concerns apart: what makes a triage complete, and what the artifacts look like.

- [ ] **Step 1: Create the shared fixture**

`packages/cli/test/fixtures/verified-example.json` — note every `sha` is a real 40-character hex string so it satisfies the published schema:

```json
{
  "version": 1,
  "cliVersion": "0.1.0",
  "preset": "tracker-keys@1",
  "history": "first-parent",
  "configFingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "changeset": {
    "id": "release 1.4.0",
    "source": { "kind": "test", "ref": "local", "fetchedAt": "2026-01-01T00:00:00Z" },
    "items": [
      { "id": "PROJ-1", "title": "Add the thing", "type": "story", "status": "done", "tokens": [{ "matcher": "ticket-key", "token": "PROJ-1" }] },
      { "id": "PROJ-2", "title": "Claimed but absent", "type": "bug", "status": "done", "tokens": [{ "matcher": "ticket-key", "token": "PROJ-2" }] }
    ]
  },
  "ranges": [
    { "repo": "repo-a", "base": "v1.3.0", "baseSha": "1111111111111111111111111111111111111111", "head": "v1.4.0", "headSha": "2222222222222222222222222222222222222222", "include": [], "mergeBase": "1111111111111111111111111111111111111111", "baseIsAncestorOfHead": false, "commitsOnlyInBase": 2, "findings": ["range-divergence"] }
  ],
  "commits": [
    { "repo": "repo-a", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "subject": "PROJ-1 add thing", "body": "", "author": "Dev", "committedAt": "2026-01-01T00:00:00Z", "ignored": null, "references": [{ "matcher": "ticket-key", "token": "PROJ-1", "namespace": "global", "sources": ["subject"], "resolvesTo": ["PROJ-1"] }], "findings": [] },
    { "repo": "repo-a", "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "subject": "PROJ-1 and PROJ-9 together", "body": "", "author": "Dev", "committedAt": "2026-01-01T00:00:00Z", "ignored": null, "references": [{ "matcher": "ticket-key", "token": "PROJ-1", "namespace": "global", "sources": ["subject"], "resolvesTo": ["PROJ-1"] }, { "matcher": "ticket-key", "token": "PROJ-9", "namespace": "global", "sources": ["subject"], "resolvesTo": [] }], "findings": ["unknown-reference"] },
    { "repo": "repo-a", "sha": "cccccccccccccccccccccccccccccccccccccccc", "subject": "tidy up", "body": "", "author": "Dev", "committedAt": "2026-01-01T00:00:00Z", "ignored": null, "references": [], "findings": ["no-reference"] },
    { "repo": "repo-a", "sha": "dddddddddddddddddddddddddddddddddddddddd", "subject": "Merge branch main", "body": "", "author": "Dev", "committedAt": "2026-01-01T00:00:00Z", "ignored": { "rule": "subjects:^Merge branch" }, "references": [], "findings": [] }
  ],
  "items": [
    { "id": "PROJ-1", "title": "Add the thing", "type": "story", "status": "done", "commits": [{ "repo": "repo-a", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { "repo": "repo-a", "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }], "findings": [] },
    { "id": "PROJ-2", "title": "Claimed but absent", "type": "bug", "status": "done", "commits": [], "findings": ["item-without-commits"] }
  ],
  "summary": { "items": 2, "itemsLinked": 1, "commits": 4, "commitsIgnored": 1, "noReference": 1, "unknownReference": 1, "itemsWithoutCommits": 1, "rangeDivergence": 1 },
  "verdict": "fail",
  "violations": [{ "finding": "unknown-reference", "count": 1 }, { "finding": "item-without-commits", "count": 1 }, { "finding": "range-divergence", "count": 1 }]
}
```

- [ ] **Step 2: Write the failing notes test, then implement `src/notes.ts`**

Coverage is exact in both directions. A note for a finding that does not exist is an error, and a finding with no note is an error too — partial notes would otherwise present a half-triaged release as triaged. Omitting `--notes` entirely remains legitimate and is handled by the renderers, not here.

`packages/cli/test/notes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotesCoverFindings, buildNoteLookup, commitKey, referenceKey } from '../src/notes.js';
import { validateVerified } from '../src/config/validate.js';
import type { NotesFile } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const verified = validateVerified(
  JSON.parse(readFileSync(join(here, 'fixtures', 'verified-example.json'), 'utf8'))
);

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';

/** The complete, correct triage for the fixture. */
const complete = (): NotesFile => ({
  version: 1,
  noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', note: 'lint config only' }],
  unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
  items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
  ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
});

describe('key builders', () => {
  it('separate fields with NUL, which no field value can contain', () => {
    expect(commitKey('repo-a', C)).toBe(`repo-a\u0000${C}`);
    expect(referenceKey('repo-a', B, 'ticket-key', 'PROJ-9')).toBe(`repo-a\u0000${B}\u0000ticket-key\u0000PROJ-9`);
  });

  it('cannot be collided by a token containing the old colon delimiter', () => {
    const a = referenceKey('r', A, 'm', 'x:y');
    const b = referenceKey('r', A, 'm:x', 'y');
    expect(a).not.toBe(b);
  });
});

describe('assertNotesCoverFindings', () => {
  it('accepts a complete triage', () => {
    expect(() => assertNotesCoverFindings(complete(), verified)).not.toThrow();
  });

  it('rejects a missing no-reference entry', () => {
    const notes = complete();
    notes.noReference = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/missing/i);
  });

  it('rejects a missing unknown-reference entry, naming the tuple', () => {
    const notes = complete();
    notes.unknownReference = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/PROJ-9/);
  });

  it('rejects a missing item entry', () => {
    const notes = complete();
    notes.items = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/PROJ-2/);
  });

  it('rejects a missing range entry', () => {
    const notes = complete();
    notes.ranges = [];
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/repo-a/);
  });

  it('rejects an omitted section as missing coverage rather than treating it as untriaged', () => {
    const { noReference, ...rest } = complete();
    expect(() => assertNotesCoverFindings(rest as NotesFile, verified)).toThrow(/missing/i);
  });

  it('rejects an entry for a commit with no no-reference finding', () => {
    const notes = complete();
    notes.noReference?.push({ repo: 'repo-a', sha: A, classification: 'revert', note: 'x' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/does not carry/);
  });

  it('rejects an entry for a reference that resolved', () => {
    const notes = complete();
    notes.unknownReference?.push({ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-1', classification: 'typo', note: 'x' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/resolved/);
  });

  it('rejects an entry for a reference tuple that does not exist at all', () => {
    const notes = complete();
    notes.unknownReference?.push({ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-77', classification: 'typo', note: 'x' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/PROJ-77/);
  });

  it('rejects a duplicate entry for one finding', () => {
    const notes = complete();
    notes.items?.push({ item: 'PROJ-2', classification: 'wrongly-tagged', note: 'second opinion' });
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/more than one/);
  });

  it('rejects a whitespace-only sentence even though the shape is right', () => {
    const notes = complete();
    (notes.items as Array<{ note: string }>)[0]!.note = '   ';
    expect(() => assertNotesCoverFindings(notes, verified)).toThrow(/whitespace/);
  });

  it('permits the same sentence on several entries', () => {
    const twoBare = {
      ...verified,
      commits: [
        ...verified.commits,
        { ...verified.commits.find((c) => c.sha === C)!, sha: 'e'.repeat(40) }
      ]
    };
    const notes = complete();
    notes.noReference?.push({ repo: 'repo-a', sha: 'e'.repeat(40), classification: 'tooling-or-ci', note: 'lint config only' });
    expect(() => assertNotesCoverFindings(notes, twoBare)).not.toThrow();
  });

  it('lets two unknown references on one commit take different dispositions', () => {
    const two = {
      ...verified,
      commits: verified.commits.map((c) => c.sha === B
        ? { ...c, references: [...c.references, { matcher: 'ticket-key', token: 'PROJ-8', namespace: 'global' as const, sources: ['subject' as const], resolvesTo: [] }] }
        : c)
    };
    const notes = complete();
    notes.unknownReference?.push({ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-8', classification: 'typo', note: 'meant PROJ-1' });
    expect(() => assertNotesCoverFindings(notes, two)).not.toThrow();
  });

  it('reports every problem in one error', () => {
    const notes: NotesFile = { version: 1 };
    try {
      assertNotesCoverFindings(notes, verified);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch('PROJ-9');
      expect(msg).toMatch('PROJ-2');
      expect(msg).toMatch(C);
    }
  });
});

describe('buildNoteLookup', () => {
  it('indexes entries so renderers can find them by finding', () => {
    const lookup = buildNoteLookup(complete());
    expect(lookup.noReference.get(commitKey('repo-a', C))?.classification).toBe('tooling-or-ci');
    expect(lookup.unknownReference.get(referenceKey('repo-a', B, 'ticket-key', 'PROJ-9'))?.note).toBe('shipped in 1.3');
    expect(lookup.items.get('PROJ-2')?.classification).toBe('not-done');
    expect(lookup.ranges.get('repo-a')?.classification).toBe('expected-divergence');
  });

  it('returns empty maps for empty notes', () => {
    const lookup = buildNoteLookup({ version: 1 });
    expect(lookup.items.size).toBe(0);
  });
});
```

Run: `npm test --workspace shipledger -- notes`
Expected: FAIL — module not found.

`packages/cli/src/notes.ts`:

```ts
import { usageError } from './errors.js';
import type {
  ItemNote, NoReferenceNote, NotesFile, RangeNote, UnknownReferenceNote, VerifiedChangeset
} from './types.js';

// NUL cannot appear in a repo name, sha, matcher id, or token, so a composite
// key built with it cannot be forged into a collision the way `a:b` can.
const SEP = '\u0000';

export const commitKey = (repo: string, sha: string): string => `${repo}${SEP}${sha}`;

export const referenceKey = (
  repo: string, sha: string, matcher: string, token: string
): string => [repo, sha, matcher, token].join(SEP);

export interface NoteLookup {
  noReference: Map<string, NoReferenceNote>;
  unknownReference: Map<string, UnknownReferenceNote>;
  items: Map<string, ItemNote>;
  ranges: Map<string, RangeNote>;
}

export function buildNoteLookup(notes: NotesFile): NoteLookup {
  const lookup: NoteLookup = {
    noReference: new Map(), unknownReference: new Map(), items: new Map(), ranges: new Map()
  };
  for (const n of notes.noReference ?? []) lookup.noReference.set(commitKey(n.repo, n.sha), n);
  for (const n of notes.unknownReference ?? []) {
    lookup.unknownReference.set(referenceKey(n.repo, n.sha, n.matcher, n.token), n);
  }
  for (const n of notes.items ?? []) lookup.items.set(n.item, n);
  for (const n of notes.ranges ?? []) lookup.ranges.set(n.repo, n);
  return lookup;
}

/**
 * Exact coverage in both directions. Supplying `--notes` is a claim that the
 * release has been triaged; a gap in that claim is worse than no claim.
 */
export function assertNotesCoverFindings(notes: NotesFile, verified: VerifiedChangeset): void {
  const problems: string[] = [];

  // Whitespace-only sentences: the schema pattern catches these, but notes may
  // also arrive from an in-process caller that skipped validation.
  const checkSentence = (label: string, note: string): void => {
    if (note.trim() === '') problems.push(`${label} has a whitespace-only note`);
  };

  const section = <T>(
    label: string,
    entries: T[],
    keyOf: (entry: T) => string,
    describeKey: (key: string) => string,
    expected: Set<string>,
    explainUnexpected: (key: string) => string,
    noteOf: (entry: T) => string
  ): void => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = keyOf(entry);
      checkSentence(`${label} entry ${describeKey(key)}`, noteOf(entry));
      if (seen.has(key)) {
        problems.push(`${label} has more than one entry for ${describeKey(key)}`);
        continue;
      }
      seen.add(key);
      if (!expected.has(key)) problems.push(explainUnexpected(key));
    }
    for (const key of expected) {
      if (!seen.has(key)) problems.push(`${label} is missing an entry for ${describeKey(key)}`);
    }
  };

  const bareCommits = new Set(
    verified.commits.filter((c) => c.findings.includes('no-reference')).map((c) => commitKey(c.repo, c.sha))
  );
  const showCommit = (key: string): string => key.split(SEP).join(' ');
  section(
    'noReference', notes.noReference ?? [],
    (n) => commitKey(n.repo, n.sha), showCommit, bareCommits,
    (key) => `noReference names ${showCommit(key)}, which does not carry a no-reference finding`,
    (n) => n.note
  );

  const unresolved = new Set<string>();
  const resolved = new Set<string>();
  for (const commit of verified.commits) {
    for (const ref of commit.references) {
      const key = referenceKey(commit.repo, commit.sha, ref.matcher, ref.token);
      (ref.resolvesTo.length === 0 ? unresolved : resolved).add(key);
    }
  }
  const showRef = (key: string): string => {
    const [repo, sha, matcher, token] = key.split(SEP);
    return `${repo} ${sha} ${matcher}=${token}`;
  };
  section(
    'unknownReference', notes.unknownReference ?? [],
    (n) => referenceKey(n.repo, n.sha, n.matcher, n.token), showRef, unresolved,
    (key) => resolved.has(key)
      ? `unknownReference names ${showRef(key)}, a reference that resolved`
      : `unknownReference names ${showRef(key)}, which is not a reference in this artifact`,
    (n) => n.note
  );

  const orphanItems = new Set(
    verified.items.filter((i) => i.findings.includes('item-without-commits')).map((i) => i.id)
  );
  section(
    'items', notes.items ?? [], (n) => n.item, (k) => k, orphanItems,
    (key) => `items names "${key}", which does not carry an item-without-commits finding`,
    (n) => n.note
  );

  const divergedRepos = new Set(
    verified.ranges.filter((r) => r.findings.includes('range-divergence')).map((r) => r.repo)
  );
  section(
    'ranges', notes.ranges ?? [], (n) => n.repo, (k) => k, divergedRepos,
    (key) => `ranges names "${key}", which does not carry a range-divergence finding`,
    (n) => n.note
  );

  if (problems.length > 0) {
    throw usageError(
      `Notes do not completely and exactly cover the findings:\n${problems.map((p) => `  ${p}`).join('\n')}\n\nOmit --notes to render an explicitly untriaged artifact instead.`
    );
  }
}
```

Run: `npm test --workspace shipledger -- notes`
Expected: all eighteen tests PASS.

- [ ] **Step 3: Write the failing semantics test, then implement `src/verify.ts`**

JSON Schema proves shape, not coherence. A hand-edited artifact can be perfectly valid and still claim a summary its own commits contradict, or link an item to a commit that is not in the list. Since every renderer and every downstream consumer trusts this file, `render` checks the invariants the reconciler guarantees.

`packages/cli/test/verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVerifiedSemantics } from '../src/verify.js';
import { validateVerified } from '../src/config/validate.js';
import { CliError } from '../src/errors.js';
import type { VerifiedChangeset } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (): VerifiedChangeset => validateVerified(
  JSON.parse(readFileSync(join(here, 'fixtures', 'verified-example.json'), 'utf8'))
);

describe('assertVerifiedSemantics', () => {
  it('accepts the reconciler-produced fixture', () => {
    expect(() => assertVerifiedSemantics(load())).not.toThrow();
  });

  it('rejects an item linked to a commit that is not in the commit list', () => {
    const v = load();
    v.items[0]!.commits = [{ repo: 'repo-a', sha: 'f'.repeat(40) }];
    expect(() => assertVerifiedSemantics(v)).toThrow(/not present in commits/);
  });

  it('rejects a reference resolving to an unknown item id', () => {
    const v = load();
    v.commits[0]!.references[0]!.resolvesTo = ['GHOST-1'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/GHOST-1/);
  });

  it('rejects a commit whose findings contradict its references', () => {
    const v = load();
    v.commits[0]!.findings = ['no-reference'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/no-reference/);
  });

  it('rejects an ignored commit that carries findings', () => {
    const v = load();
    const ignored = v.commits.find((c) => c.ignored !== null)!;
    ignored.findings = ['no-reference'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/ignored/);
  });

  it('rejects an item finding that contradicts its commit list', () => {
    const v = load();
    v.items[0]!.findings = ['item-without-commits'];
    expect(() => assertVerifiedSemantics(v)).toThrow(/item-without-commits/);
  });

  it('rejects a range finding that contradicts its ancestry flag', () => {
    const v = load();
    v.ranges[0]!.baseIsAncestorOfHead = true;
    expect(() => assertVerifiedSemantics(v)).toThrow(/range-divergence/);
  });

  it('rejects a summary that does not match the commits', () => {
    const v = load();
    v.summary.noReference = 99;
    expect(() => assertVerifiedSemantics(v)).toThrow(/summary/);
  });

  it('rejects a verdict that contradicts the violations', () => {
    const v = load();
    v.verdict = 'pass';
    expect(() => assertVerifiedSemantics(v)).toThrow(/verdict/);
  });

  it('rejects a violation count that overstates the findings', () => {
    const v = load();
    v.violations = [{ finding: 'no-reference', count: 7 }];
    expect(() => assertVerifiedSemantics(v)).toThrow(/count/);
  });

  it('rejects item ids that disagree with the embedded changeset', () => {
    const v = load();
    v.items[0]!.id = 'RENAMED-1';
    expect(() => assertVerifiedSemantics(v)).toThrow(/changeset/);
  });

  it('reports semantic failures as usage errors', () => {
    const v = load();
    v.summary.commits = 0;
    try {
      assertVerifiedSemantics(v);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
    }
  });
});
```

Run: `npm test --workspace shipledger -- verify`
Expected: FAIL — module not found.

`packages/cli/src/verify.ts`:

```ts
import { usageError } from './errors.js';
import { FINDING_ORDER, summarise } from './core/findings.js';
import { canonicalStringify } from './core/canonical.js';
import type { FindingName, VerifiedChangeset } from './types.js';

/** Invariants the reconciler guarantees, re-checked on anything read from disk. */
export function assertVerifiedSemantics(verified: VerifiedChangeset): void {
  const problems: string[] = [];

  const commitIds = new Set(verified.commits.map((c) => `${c.repo}\u0000${c.sha}`));
  const itemIds = new Set(verified.items.map((i) => i.id));

  const changesetIds = verified.changeset.items.map((i) => i.id);
  if (canonicalStringify(changesetIds) !== canonicalStringify(verified.items.map((i) => i.id))) {
    problems.push('items do not match the embedded changeset items, in id or in order');
  }

  for (const commit of verified.commits) {
    const where = `commit ${commit.repo} ${commit.sha.slice(0, 8)}`;

    if (commit.ignored !== null) {
      if (commit.findings.length > 0) problems.push(`${where} is ignored but carries findings`);
      if (commit.references.length > 0) problems.push(`${where} is ignored but carries references`);
    }

    for (const ref of commit.references) {
      for (const id of ref.resolvesTo) {
        if (!itemIds.has(id)) problems.push(`${where} resolves ${ref.token} to "${id}", which is not an item`);
      }
    }

    const expected: FindingName[] = commit.ignored !== null
      ? []
      : commit.references.length === 0
        ? ['no-reference']
        : commit.references.some((r) => r.resolvesTo.length === 0) ? ['unknown-reference'] : [];
    if (canonicalStringify(commit.findings) !== canonicalStringify(expected)) {
      problems.push(`${where} declares findings [${commit.findings.join(', ')}] but its references imply [${expected.join(', ')}]`);
    }
  }

  for (const item of verified.items) {
    for (const link of item.commits) {
      if (!commitIds.has(`${link.repo}\u0000${link.sha}`)) {
        problems.push(`item "${item.id}" links ${link.repo} ${link.sha.slice(0, 8)}, which is not present in commits`);
      }
    }
    const expected: FindingName[] = item.commits.length === 0 ? ['item-without-commits'] : [];
    if (canonicalStringify(item.findings) !== canonicalStringify(expected)) {
      problems.push(`item "${item.id}" declares findings [${item.findings.join(', ')}] but has ${item.commits.length} commit(s), implying [${expected.join(', ')}]`);
    }
  }

  for (const range of verified.ranges) {
    const expected: FindingName[] = range.baseIsAncestorOfHead ? [] : ['range-divergence'];
    if (canonicalStringify(range.findings) !== canonicalStringify(expected)) {
      problems.push(`range "${range.repo}" declares findings [${range.findings.join(', ')}] but baseIsAncestorOfHead=${range.baseIsAncestorOfHead} implies [${expected.join(', ')}]`);
    }
  }

  const recomputed = summarise(verified);
  if (canonicalStringify(recomputed) !== canonicalStringify(verified.summary)) {
    problems.push(`summary does not match the commits, items, and ranges it describes (recomputed ${canonicalStringify(recomputed)})`);
  }

  const actual = new Map<FindingName, number>();
  for (const finding of FINDING_ORDER) {
    const count = verified.commits.filter((c) => c.findings.includes(finding)).length
      + verified.items.filter((i) => i.findings.includes(finding)).length
      + verified.ranges.filter((r) => r.findings.includes(finding)).length;
    actual.set(finding, count);
  }
  for (const violation of verified.violations) {
    if (actual.get(violation.finding) !== violation.count) {
      problems.push(`violation "${violation.finding}" claims count ${violation.count} but ${actual.get(violation.finding)} finding(s) are present`);
    }
  }
  const expectedVerdict = verified.violations.length > 0 ? 'fail' : 'pass';
  if (verified.verdict !== expectedVerdict) {
    problems.push(`verdict "${verified.verdict}" contradicts ${verified.violations.length} violation(s)`);
  }

  if (problems.length > 0) {
    throw usageError(`Verified changeset is internally inconsistent:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
```

Note `summarise` takes `{ commits, items, ranges }`, and `VerifiedChangeset` structurally satisfies that, so it can be passed directly — the same function that produced the counts re-checks them.

Run: `npm test --workspace shipledger -- verify`
Expected: all twelve tests PASS.

- [ ] **Step 4: Confirm `check` output passes both gates, then commit**

Add to `packages/cli/test/verify.test.ts`:

```ts
it('accepts output produced by reconcile itself', async () => {
  const [{ reconcile }, { compileAll }, { mergeConfig }] = await Promise.all([
    import('../src/core/reconcile.js'),
    import('../src/core/compile.js'),
    import('../src/config/load.js')
  ]);
  const config = mergeConfig({
    version: 1, preset: 'tracker-keys@1', repos: [{ name: 'repo-a', path: '../a' }]
  }, '/tmp');
  const out = reconcile({
    config, compiled: compileAll(config),
    changeset: {
      version: 1, id: 'r', source: { kind: 'k', ref: 'r', fetchedAt: '2026-01-01T00:00:00Z' },
      items: [{ id: 'PROJ-1', title: 't', type: 'story', status: 'done', tokens: [{ matcher: 'ticket-key', token: 'PROJ-1' }] }],
      ranges: [{ repo: 'repo-a', base: 'v1', head: 'v2' }]
    },
    commits: [{ repo: 'repo-a', sha: 'a'.repeat(40), subject: 'PROJ-1 and PROJ-9', body: '', author: 'Dev', committedAt: '2026-01-01T00:00:00Z' }],
    ranges: [],
    cliVersion: '0.1.0', configFingerprint: `sha256:${'0'.repeat(64)}`
  });
  expect(() => assertVerifiedSemantics(out)).not.toThrow();
});
```

This is the test that keeps the reconciler and the validator from drifting apart: if a future change to finding derivation forgets one of them, this fails.

Run: `npm test --workspace shipledger && npm run typecheck --workspace shipledger`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/notes.ts packages/cli/src/verify.ts packages/cli/test/notes.test.ts packages/cli/test/verify.test.ts packages/cli/test/fixtures
git commit -m "feat: exact notes coverage and semantic validation of verified artifacts"
```

---

### Task 14: The three renderers and committed golden files

**Files:**
- Create: `packages/cli/src/render/{report,changelog,release-notes}.ts`
- Create: `packages/cli/test/render/__golden__/{report,report-untriaged,changelog,release-notes}.txt`
- Test: `packages/cli/test/render/renderers.test.ts`

**Interfaces:**
- Consumes: `buildNoteLookup`, `NoteLookup`, `VerifiedChangeset`.
- Produces: `renderReport(v, notes?)`, `renderChangelog(v, notes?)`, `renderReleaseNotes(v, notes?)` — all pure functions of their arguments, all deterministic.

Every renderer must state when it was given no notes. An artifact that silently omits triage reads as though there was nothing to triage.

- [ ] **Step 1: Write the failing renderer test, then implement the three renderers**

`packages/cli/test/render/renderers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../../src/render/report.js';
import { renderChangelog } from '../../src/render/changelog.js';
import { renderReleaseNotes } from '../../src/render/release-notes.js';
import { validateVerified } from '../../src/config/validate.js';
import type { NotesFile } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const verified = validateVerified(
  JSON.parse(readFileSync(join(here, '..', 'fixtures', 'verified-example.json'), 'utf8'))
);

const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';

const notes: NotesFile = {
  version: 1,
  noReference: [{ repo: 'repo-a', sha: C, classification: 'tooling-or-ci', note: 'lint config only' }],
  unknownReference: [{ repo: 'repo-a', sha: B, matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
  items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
  ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
};

const golden = (name: string): string =>
  readFileSync(join(here, '__golden__', `${name}.txt`), 'utf8');

describe('renderReport', () => {
  const text = renderReport(verified);

  it('states the verdict', () => { expect(text).toMatch(/FAIL/); });
  it('names the unresolved token', () => { expect(text).toMatch(/PROJ-9/); });
  it('lists the unreferenced commit', () => { expect(text).toMatch(/cccccccc/); });
  it('lists the item with no commits, by title', () => { expect(text).toMatch(/Claimed but absent/); });
  it('shows the ignored commit and its rule', () => { expect(text).toMatch(/subjects:\^Merge branch/); });
  it('reports range divergence with the count only in base', () => {
    expect(text).toMatch(/diverge/i);
    expect(text).toMatch(/2 commit/);
  });
  it('does not attribute a finding to the ignored commit', () => {
    expect(text).not.toMatch(/dddddddd.*no-reference/);
  });
  it('shows a commit that is both linked and carrying an unknown reference', () => {
    expect(text).toMatch(/bbbbbbbb/);
  });
  it('includes triage notes when supplied', () => {
    const withNotes = renderReport(verified, notes);
    expect(withNotes).toMatch(/tooling-or-ci/);
    expect(withNotes).toMatch(/shipped in 1\.3/);
    expect(withNotes).toMatch(/expected-divergence/);
  });
  it('is deterministic', () => {
    expect(renderReport(verified, notes)).toBe(renderReport(verified, notes));
  });
});

describe('renderChangelog', () => {
  it('lists linked items by title', () => {
    expect(renderChangelog(verified)).toMatch(/Add the thing/);
  });
  it('does not silently omit unaccounted commits', () => {
    const text = renderChangelog(verified);
    expect(text).toMatch(/PROJ-9/);
    expect(text).toMatch(/cccccccc/);
  });
  it('reports the ignored count', () => {
    expect(renderChangelog(verified)).toMatch(/1 commit/);
  });
  it('carries note classifications through', () => {
    expect(renderChangelog(verified, notes)).toMatch(/other-release/);
  });
  it('records the fingerprint for traceability', () => {
    expect(renderChangelog(verified)).toMatch(/sha256:0{64}/);
  });
});

describe('renderReleaseNotes', () => {
  it('renders a heading with the changeset id', () => {
    expect(renderReleaseNotes(verified)).toMatch(/release 1\.4\.0/);
  });
  it('lists verified items by title', () => {
    expect(renderReleaseNotes(verified)).toMatch(/Add the thing/);
  });
  it('summarises the reconciliation counts', () => {
    expect(renderReleaseNotes(verified)).toMatch(/1\/2/);
  });
  it('is deterministic', () => {
    expect(renderReleaseNotes(verified)).toBe(renderReleaseNotes(verified));
  });
});

describe('untriaged output', () => {
  it('each renderer says so when given no notes', () => {
    for (const text of [renderReport(verified), renderChangelog(verified), renderReleaseNotes(verified)]) {
      expect(text.toLowerCase()).toMatch(/untriaged/);
    }
  });

  it('and stops saying so once notes are supplied', () => {
    for (const text of [renderReport(verified, notes), renderChangelog(verified, notes), renderReleaseNotes(verified, notes)]) {
      expect(text.toLowerCase()).not.toMatch(/untriaged/);
    }
  });
});

describe('golden files', () => {
  it('report matches byte for byte', () => {
    expect(renderReport(verified, notes)).toBe(golden('report'));
  });

  it('untriaged report matches byte for byte', () => {
    expect(renderReport(verified)).toBe(golden('report-untriaged'));
  });

  it('changelog matches byte for byte', () => {
    expect(renderChangelog(verified, notes)).toBe(golden('changelog'));
  });

  it('release notes match byte for byte', () => {
    expect(renderReleaseNotes(verified, notes)).toBe(golden('release-notes'));
  });
});
```

The golden files cover all four findings, an ignored commit, a linked item, an orphan item, a diverged range, and both triaged and untriaged rendering. Generate them once with the snippet in Step 3, then **read them** before committing — an unreviewed golden file only proves the output has not changed, not that it was ever right.

Run: `npm test --workspace shipledger -- renderers`
Expected: FAIL — modules not found.

`packages/cli/src/render/report.ts`:

```ts
import { buildNoteLookup, commitKey, referenceKey } from '../notes.js';
import type { NotesFile, VerifiedChangeset } from '../types.js';

const short = (sha: string): string => sha.slice(0, 8);

function suffix(entry: { classification: string; note: string } | undefined): string {
  return entry ? ` [${entry.classification}: ${entry.note}]` : '';
}

export function renderReport(verified: VerifiedChangeset, notes?: NotesFile): string {
  const out: string[] = [];
  const s = verified.summary;
  const lookup = buildNoteLookup(notes ?? { version: 1 });

  out.push(`shipledger report — ${verified.changeset.id}`);
  out.push(`verdict: ${verified.verdict.toUpperCase()}   preset: ${verified.preset}   history: ${verified.history}`);
  if (verified.violations.length > 0) {
    out.push(`violations: ${verified.violations.map((v) => `${v.finding}=${v.count}`).join(', ')}`);
  }
  out.push(`items ${s.itemsLinked}/${s.items} linked · commits ${s.commits} (${s.commitsIgnored} ignored)`);
  if (notes === undefined) out.push('triage: UNTRIAGED — no notes supplied');
  out.push('');

  for (const range of verified.ranges) {
    if (range.baseIsAncestorOfHead) {
      out.push(`OK   range ${range.repo} ${range.base}..${range.head}`);
    } else {
      out.push(
        `WARN range ${range.repo} ${range.base}..${range.head} — refs diverge; ${range.commitsOnlyInBase} commit(s) reachable from base but not head are invisible${suffix(lookup.ranges.get(range.repo))}`
      );
    }
  }

  const unknown = verified.commits.filter((c) => c.findings.includes('unknown-reference'));
  if (unknown.length > 0) {
    out.push('');
    out.push(`Commits referencing work outside this release (${unknown.length}):`);
    for (const c of unknown) {
      out.push(`  ${c.repo} ${short(c.sha)} · ${c.subject}`);
      for (const ref of c.references.filter((r) => r.resolvesTo.length === 0)) {
        const entry = lookup.unknownReference.get(referenceKey(c.repo, c.sha, ref.matcher, ref.token));
        out.push(`    → ${ref.token} (${ref.matcher}, seen in ${ref.sources.join('+')})${suffix(entry)}`);
      }
      const linked = c.references.flatMap((r) => r.resolvesTo);
      if (linked.length > 0) out.push(`    also linked to ${[...new Set(linked)].join(', ')}`);
    }
  }

  const bare = verified.commits.filter((c) => c.findings.includes('no-reference'));
  if (bare.length > 0) {
    out.push('');
    out.push(`Commits with no reference (${bare.length}):`);
    for (const c of bare) {
      out.push(`  ${c.repo} ${short(c.sha)} · ${c.subject}${suffix(lookup.noReference.get(commitKey(c.repo, c.sha)))}`);
    }
  }

  const orphans = verified.items.filter((i) => i.findings.includes('item-without-commits'));
  if (orphans.length > 0) {
    out.push('');
    out.push(`Items claimed with no commits (${orphans.length}):`);
    for (const i of orphans) {
      out.push(`  ${i.id} · ${i.title}${suffix(lookup.items.get(i.id))}`);
    }
  }

  const ignored = verified.commits.filter((c) => c.ignored !== null);
  if (ignored.length > 0) {
    out.push('');
    out.push(`Ignored (${ignored.length}):`);
    for (const c of ignored) {
      out.push(`  ${c.repo} ${short(c.sha)} · ${c.subject} — ${c.ignored?.rule}`);
    }
  }

  return `${out.join('\n')}\n`;
}
```

`packages/cli/src/render/changelog.ts`:

```ts
import { buildNoteLookup, commitKey, referenceKey } from '../notes.js';
import type { NotesFile, VerifiedChangeset } from '../types.js';

export function renderChangelog(verified: VerifiedChangeset, notes?: NotesFile): string {
  const lookup = buildNoteLookup(notes ?? { version: 1 });
  const out: string[] = [`# ${verified.changeset.id}`, ''];

  const linked = verified.items.filter((i) => i.commits.length > 0);
  if (linked.length > 0) {
    out.push('## Changes', '');
    for (const item of linked) {
      const n = item.commits.length;
      out.push(`- **${item.id}** ${item.title} (${n} commit${n === 1 ? '' : 's'})`);
    }
    out.push('');
  }

  const unaccounted = verified.commits.filter(
    (c) => c.findings.includes('unknown-reference') || c.findings.includes('no-reference')
  );
  if (unaccounted.length > 0) {
    out.push('## Unaccounted commits', '');
    for (const c of unaccounted) {
      const unresolved = c.references.filter((r) => r.resolvesTo.length === 0);
      const dispositions = unresolved
        .map((r) => lookup.unknownReference.get(referenceKey(c.repo, c.sha, r.matcher, r.token)))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map((n) => n.classification);
      const bare = lookup.noReference.get(commitKey(c.repo, c.sha));
      const tags = [...dispositions, ...(bare ? [bare.classification] : [])];
      const refs = unresolved.length > 0 ? ` (refs ${unresolved.map((r) => r.token).join(', ')})` : '';
      out.push(`- \`${c.repo} ${c.sha.slice(0, 8)}\` ${c.subject}${refs}${tags.length > 0 ? ` — ${tags.join(', ')}` : ''}`);
    }
    out.push('');
  }

  const orphans = verified.items.filter((i) => i.findings.includes('item-without-commits'));
  if (orphans.length > 0) {
    out.push('## Claimed but not found in git', '');
    for (const i of orphans) {
      const note = lookup.items.get(i.id);
      out.push(`- **${i.id}** ${i.title}${note ? ` — ${note.classification}` : ''}`);
    }
    out.push('');
  }

  const diverged = verified.ranges.filter((r) => r.findings.includes('range-divergence'));
  if (diverged.length > 0) {
    out.push('## Incomplete ranges', '');
    for (const r of diverged) {
      const note = lookup.ranges.get(r.repo);
      out.push(`- \`${r.repo}\` ${r.base}..${r.head} — ${r.commitsOnlyInBase} commit(s) only in base are not represented${note ? ` — ${note.classification}` : ''}`);
    }
    out.push('');
  }

  const n = verified.summary.commitsIgnored;
  const triage = notes === undefined ? ' Findings are untriaged.' : '';
  out.push(`_Generated from a verified changeset (${verified.configFingerprint}, preset ${verified.preset}). ${n} commit${n === 1 ? '' : 's'} ignored by configured rules.${triage}_`);
  return `${out.join('\n')}\n`;
}
```

`packages/cli/src/render/release-notes.ts`:

```ts
import type { NotesFile, VerifiedChangeset } from '../types.js';

export function renderReleaseNotes(verified: VerifiedChangeset, notes?: NotesFile): string {
  const out: string[] = [`## ${verified.changeset.id}`, ''];

  const byType = new Map<string, typeof verified.items>();
  for (const item of verified.items.filter((i) => i.commits.length > 0)) {
    const bucket = byType.get(item.type) ?? [];
    bucket.push(item);
    byType.set(item.type, bucket);
  }

  for (const [type, items] of byType) {
    out.push(`### ${type}`, '');
    for (const item of items) out.push(`* ${item.title} (${item.id})`);
    out.push('');
  }

  const s = verified.summary;
  const caveats: string[] = [];
  if (s.unknownReference > 0) caveats.push(`${s.unknownReference} commit(s) reference other releases`);
  if (s.noReference > 0) caveats.push(`${s.noReference} unreferenced`);
  if (s.itemsWithoutCommits > 0) caveats.push(`${s.itemsWithoutCommits} claimed with no code`);
  if (s.rangeDivergence > 0) caveats.push(`${s.rangeDivergence} incomplete range(s)`);
  if ((notes?.items ?? []).some((n) => n.classification === 'not-done')) {
    caveats.push('at least one claimed item was not done');
  }
  if (notes === undefined) caveats.push('findings untriaged');

  out.push(`<sub>${s.itemsLinked}/${s.items} claimed items verified against git · ${s.commits} commits${caveats.length > 0 ? ` · ${caveats.join(' · ')}` : ''}</sub>`);
  return `${out.join('\n')}\n`;
}
```

- [ ] **Step 2: Run the behavioural tests**

Run: `npm test --workspace shipledger -- renderers`
Expected: every test except the four golden-file tests PASSES; those four fail because `__golden__` does not exist yet.

- [ ] **Step 3: Generate the golden files, then read them**

```bash
mkdir -p packages/cli/test/render/__golden__
node --experimental-strip-types -e "
import { readFileSync, writeFileSync } from 'node:fs';
const v = JSON.parse(readFileSync('packages/cli/test/fixtures/verified-example.json','utf8'));
const C='c'.repeat(40), B='b'.repeat(40);
const notes = { version:1,
  noReference:[{repo:'repo-a',sha:C,classification:'tooling-or-ci',note:'lint config only'}],
  unknownReference:[{repo:'repo-a',sha:B,matcher:'ticket-key',token:'PROJ-9',classification:'other-release',note:'shipped in 1.3'}],
  items:[{item:'PROJ-2',classification:'not-done',note:'moved out of scope'}],
  ranges:[{repo:'repo-a',classification:'expected-divergence',note:'branches cut separately'}] };
const { renderReport } = await import('./packages/cli/src/render/report.ts');
const { renderChangelog } = await import('./packages/cli/src/render/changelog.ts');
const { renderReleaseNotes } = await import('./packages/cli/src/render/release-notes.ts');
const d='packages/cli/test/render/__golden__/';
writeFileSync(d+'report.txt', renderReport(v, notes));
writeFileSync(d+'report-untriaged.txt', renderReport(v));
writeFileSync(d+'changelog.txt', renderChangelog(v, notes));
writeFileSync(d+'release-notes.txt', renderReleaseNotes(v, notes));
console.log('wrote 4 golden files');
"
```

If `--experimental-strip-types` is unavailable on the installed Node, run `npm run build --workspace shipledger` first and import from `dist/` instead.

Now **read all four files.** Check that the report names every finding, that the untriaged variant says so, that the changelog does not present an incomplete range as complete, and that no classification is attached to the wrong commit. A golden file adopted without reading only locks in whatever the code did first.

Run: `npm test --workspace shipledger -- renderers`
Expected: all tests PASS, golden comparisons included.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace shipledger`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/render packages/cli/test/render
git commit -m "feat: three deterministic renderers with reviewed golden files"
```

---

### Task 15: `render` command

**Files:**
- Create: `packages/cli/src/cli/render.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/cli/render.test.ts`

**Interfaces:**
- Consumes: `validateVerified`, `validateNotes`, `assertVerifiedSemantics`, `assertNotesCoverFindings`, the three renderers.
- Produces: `runRender(argv: string[], cwd: string): number`.

Validation order is structural schema, then artefact semantics, then note schema, then note coverage — cheapest and most specific failure first.

- [ ] **Step 1: Implement `src/cli/render.ts`**

`packages/cli/src/cli/render.ts`:

```ts
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

    // Omitting --notes is legitimate: the renderers mark the output untriaged.
    // Supplying it is a claim of complete triage, and is held to that.
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
```

- [ ] **Step 2: Wire it into the dispatcher**

In `packages/cli/src/cli/index.ts`:

```ts
import { runRender } from './render.js';
```

```ts
    case 'render':
      return runRender(rest, process.cwd());
```

- [ ] **Step 3: Write the command test**

`packages/cli/test/cli/render.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runRender } from '../../src/cli/render.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'verified-example.json');
let work: string | undefined;

afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
  vi.restoreAllMocks();
});

function capture(): { text: () => string } {
  let buf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { buf += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { buf += String(c); return true; });
  return { text: () => buf };
}

describe('runRender', () => {
  it('renders every format and exits 0', () => {
    for (const format of ['report', 'changelog', 'release-notes']) {
      const out = capture();
      expect(runRender([format, '--input', fixture], process.cwd())).toBe(0);
      expect(out.text().length).toBeGreaterThan(0);
      vi.restoreAllMocks();
    }
  });

  it('exits 2 for an unknown format', () => {
    capture();
    expect(runRender(['pretty', '--input', fixture], process.cwd())).toBe(2);
  });

  it('exits 3 when the input is missing', () => {
    capture();
    expect(runRender(['report', '--input', '/nonexistent.json'], process.cwd())).toBe(3);
  });

  it('exits 2 when the input is not a valid verified changeset', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const bad = join(work, 'bad.json');
    writeFileSync(bad, JSON.stringify({ version: 1 }));
    capture();
    expect(runRender(['report', '--input', bad], process.cwd())).toBe(2);
  });

  it('exits 2 when the artifact is schema-valid but internally inconsistent', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const tampered = JSON.parse(readFileSync(fixture, 'utf8'));
    tampered.summary.noReference = 99;
    const path = join(work, 'tampered.json');
    writeFileSync(path, JSON.stringify(tampered));
    const out = capture();
    expect(runRender(['report', '--input', path], process.cwd())).toBe(2);
    expect(out.text()).toMatch(/summary/);
  });

  it('exits 2 when notes name a finding the artifact does not contain', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const notes = join(work, 'notes.json');
    writeFileSync(notes, JSON.stringify({
      version: 1, items: [{ item: 'PROJ-1', classification: 'not-done', note: 'wrong target' }]
    }));
    capture();
    expect(runRender(['report', '--input', fixture, '--notes', notes], process.cwd())).toBe(2);
  });

  it('exits 2 when notes are supplied but incomplete', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const notes = join(work, 'notes.json');
    // Correct as far as it goes, but the fixture has four findings.
    writeFileSync(notes, JSON.stringify({
      version: 1, items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }]
    }));
    const out = capture();
    expect(runRender(['report', '--input', fixture, '--notes', notes], process.cwd())).toBe(2);
    expect(out.text()).toMatch(/missing/i);
    expect(out.text()).toMatch(/Omit --notes/);
  });

  it('accepts a complete triage and includes it in output', () => {
    work = mkdtempSync(join(tmpdir(), 'shipledger-render-'));
    const notes = join(work, 'notes.json');
    writeFileSync(notes, JSON.stringify({
      version: 1,
      noReference: [{ repo: 'repo-a', sha: 'c'.repeat(40), classification: 'tooling-or-ci', note: 'lint config only' }],
      unknownReference: [{ repo: 'repo-a', sha: 'b'.repeat(40), matcher: 'ticket-key', token: 'PROJ-9', classification: 'other-release', note: 'shipped in 1.3' }],
      items: [{ item: 'PROJ-2', classification: 'not-done', note: 'moved out of scope' }],
      ranges: [{ repo: 'repo-a', classification: 'expected-divergence', note: 'branches cut separately' }]
    }));
    const out = capture();
    expect(runRender(['report', '--input', fixture, '--notes', notes], process.cwd())).toBe(0);
    expect(out.text()).toMatch(/moved out of scope/);
    expect(out.text().toLowerCase()).not.toMatch(/untriaged/);
  });

  it('marks output untriaged when --notes is omitted, without failing', () => {
    const out = capture();
    expect(runRender(['report', '--input', fixture], process.cwd())).toBe(0);
    expect(out.text().toLowerCase()).toMatch(/untriaged/);
  });

  it('reads the committed fixture unchanged', () => {
    expect(JSON.parse(readFileSync(fixture, 'utf8')).verdict).toBe('fail');
  });
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test --workspace shipledger && npm run typecheck --workspace shipledger`
Expected: everything green. All four public commands now exist.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/render.ts packages/cli/src/cli/index.ts packages/cli/test/cli/render.test.ts
git commit -m "feat: render command validating artifact semantics and note coverage"
```

---

### Task 16: Deterministic end-to-end bundle

**Files:**
- Create: `fixtures/make-bundle.sh`, `fixtures/README.md`, `fixtures/deterministic.bundle`, `fixtures/expected.json`
- Create: `packages/cli/test/e2e/{config.json,changeset.json,bundle.test.ts}`
- Modify: `docs/superpowers/specs/2026-09-01-shipledger-design.md` (Repo layout line)

**Interfaces:**
- Consumes: `runCheck`, `runRender`.
- Produces: no new source interfaces. Asserts exact links, findings, and SHAs with no placeholders.

The fixture repository is synthetic and built by a committed script with fixed author, email, dates, and content, which makes every SHA deterministic. That is what allows exact-SHA assertions; a third-party clone could not provide them.

- [ ] **Step 1: Write the fixture generator**

`fixtures/make-bundle.sh`:

```bash
#!/usr/bin/env bash
# Builds fixtures/deterministic.bundle and fixtures/expected.json.
# Every input is fixed, so the commit SHAs are reproducible on any machine with
# the same git object format. Re-run only when the fixture shape must change,
# then commit both outputs.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$HERE/deterministic.bundle"
EXPECTED="$HERE/expected.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_AUTHOR_DATE='2026-01-01T00:00:00+0000'
export GIT_COMMITTER_DATE='2026-01-01T00:00:00+0000'
export GIT_AUTHOR_NAME='Fixture'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

R="$TMP/repo"
git init -q -b main "$R"
git -C "$R" config user.name  "$GIT_AUTHOR_NAME"
git -C "$R" config user.email "$GIT_AUTHOR_EMAIL"
git -C "$R" config commit.gpgsign false

commit() { # subject path [author]
  local subject="$1" path="$2" author="${3:-$GIT_AUTHOR_NAME}"
  mkdir -p "$R/$(dirname "$path")"
  printf '%s\n' "$subject" > "$R/$path"
  git -C "$R" add "$path"
  GIT_AUTHOR_NAME="$author" git -C "$R" commit -q -m "$subject"
}

commit 'initial commit' 'file.txt'
git -C "$R" tag v1.0.0

# Every commit that should be seen touches packages/a/, because the changeset
# scopes the range to packages/a/**. A commit outside that scope is removed by
# pathspec filtering *before* ignore rules are ever consulted, so an ignored
# commit must live inside the scope to exercise the ignore path at all.
commit 'PROJ-1: add the widget (#11)'       'packages/a/widget.txt'
commit 'PROJ-2: fix the gadget (#12)'       'packages/a/gadget.txt'
commit 'PROJ-9: unrelated work (#13)'       'packages/a/other.txt'
commit 'chore: reformat everything'         'packages/a/format.txt'
commit 'docs: only touches package b (#14)' 'packages/b/readme.txt'
commit 'chore(deps): bump left-pad'         'packages/a/vendor.txt' 'dependabot[bot]'
git -C "$R" tag v1.1.0

git -C "$R" bundle create "$BUNDLE" --all

# awk rather than `sed '$!s/$/,/'`, which is not portable between GNU and BSD sed.
git -C "$R" log --reverse --format='%H%x09%an%x09%s' v1.0.0..v1.1.0 | awk -F'\t' '
  BEGIN { print "{"; print "  \"tags\": { \"base\": \"v1.0.0\", \"head\": \"v1.1.0\" },"; print "  \"commits\": [" }
  {
    s = $3; gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s);
    a = $2; gsub(/\\/, "\\\\", a); gsub(/"/, "\\\"", a);
    rows[NR] = sprintf("    { \"sha\": \"%s\", \"author\": \"%s\", \"subject\": \"%s\" }", $1, a, s)
  }
  END {
    for (i = 1; i <= NR; i++) printf "%s%s\n", rows[i], (i < NR ? "," : "");
    print "  ]"; print "}"
  }' > "$EXPECTED"

echo "Wrote $BUNDLE"
echo "Wrote $EXPECTED"
cat "$EXPECTED"
```

Run: `chmod +x fixtures/make-bundle.sh && ./fixtures/make-bundle.sh`
Expected: both files written, and the printed `expected.json` lists six commits between `v1.0.0` and `v1.1.0` with 40-character SHAs.

Write `fixtures/README.md` recording: what the fixture contains, that all SHAs are deterministic because author, email, dates and content are fixed, the exact command to regenerate, and that `expected.json` is the committed source of truth for SHA assertions.

- [ ] **Step 2: Write the e2e config and changeset**

Both files use real values from the fixture — no placeholders. `path` is the one field the test fills in, because it is a temp directory.

`packages/cli/test/e2e/config.json`:

```json
{
  "version": 1,
  "preset": "tracker-keys@1",
  "repos": [{ "name": "pinned", "path": "FILLED_IN_BY_TEST" }],
  "policy": { "failOn": ["unknown-reference"] }
}
```

`packages/cli/test/e2e/changeset.json`:

```json
{
  "version": 1,
  "id": "fixture 1.1.0",
  "source": {
    "kind": "manual-fixture",
    "ref": "fixtures/deterministic.bundle v1.0.0..v1.1.0",
    "fetchedAt": "2026-09-01T00:00:00Z"
  },
  "items": [
    {
      "id": "PROJ-1",
      "title": "Add the widget",
      "type": "story",
      "status": "done",
      "tokens": [
        { "matcher": "ticket-key", "token": "PROJ-1" },
        { "matcher": "pr-ref", "token": "#11", "repo": "pinned" }
      ]
    },
    {
      "id": "PROJ-2",
      "title": "Fix the gadget",
      "type": "bug",
      "status": "done",
      "tokens": [
        { "matcher": "ticket-key", "token": "PROJ-2" },
        { "matcher": "pr-ref", "token": "#12", "repo": "pinned" }
      ]
    },
    {
      "id": "PROJ-3",
      "title": "Claimed but never landed",
      "type": "story",
      "status": "done",
      "tokens": [{ "matcher": "ticket-key", "token": "PROJ-3" }]
    }
  ],
  "ranges": [
    { "repo": "pinned", "base": "v1.0.0", "head": "v1.1.0", "include": ["packages/a/**"] }
  ]
}
```

Expected reconciliation, derived by hand from the fixture and the config above. The test asserts every row, so work through the derivation rather than trusting the table.

| Fixture commit | References extracted | Outcome |
| --- | --- | --- |
| `PROJ-1: add the widget (#11)` | `PROJ-1` (declared), `#11` (declared) | linked to `PROJ-1`, no findings |
| `PROJ-2: fix the gadget (#12)` | `PROJ-2` (declared), `#12` (declared) | linked to `PROJ-2`, no findings |
| `PROJ-9: unrelated work (#13)` | `PROJ-9` and `#13`, neither declared | `unknown-reference` |
| `chore: reformat everything` | none | `no-reference` |
| `docs: only touches package b (#14)` | not walked | excluded by `include: packages/a/**` |
| `chore(deps): bump left-pad` | not extracted | ignored via `authors:dependabot[bot]` |
| item `PROJ-3` | — | `item-without-commits` |

Two subtleties this fixture exists to pin down, both of which an earlier draft of this plan got wrong:

**Every commit carrying a pull-request number needs that number declared.** `tracker-keys@1` enables both `ticket-key` and `pr-ref`, so `PROJ-2: fix the gadget (#12)` yields *two* references. Declaring only `PROJ-2` leaves `#12` unresolved and the commit gains `unknown-reference` despite being correctly linked. That is the tool behaving correctly — an identifier appeared in git that the release does not account for — and it is why the item declares both tokens.

**Pathspec filtering happens before ignore rules.** An empty commit, or one touching only `packages/b/`, is removed by `include` during the git walk and never reaches ignore processing, so it appears nowhere in the output and contributes nothing to `commitsIgnored`. The dependabot commit therefore writes to `packages/a/vendor.txt` deliberately.

Both ignore rules would match that last commit — the `dependabot[bot]` author and the `^chore\(deps\)` subject — and the author rule is checked first, so `ignored.rule` is `authors:dependabot[bot]`.

Resulting summary: 3 items, 2 linked, 5 commits walked, 1 ignored, 1 `no-reference`, 1 `unknown-reference`, 1 `item-without-commits`, 0 `range-divergence`. With `failOn` narrowed to `unknown-reference`, the verdict is `fail` with a single violation of count 1, so `check` exits 1.

- [ ] **Step 3: Write the e2e test**

`packages/cli/test/e2e/bundle.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runCheck } from '../../src/cli/check.js';
import { runRender } from '../../src/cli/render.js';
import { validateVerified } from '../../src/config/validate.js';
import type { VerifiedChangeset } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const bundle = join(root, 'fixtures', 'deterministic.bundle');
const expectedPath = join(root, 'fixtures', 'expected.json');

interface Expected {
  tags: { base: string; head: string };
  commits: Array<{ sha: string; author: string; subject: string }>;
}

let work: string;
let repoPath: string;
let configPath: string;
let changesetPath: string;
let outPath: string;
let expected: Expected;

const shaFor = (subject: string): string => {
  const hit = expected.commits.find((c) => c.subject === subject);
  if (!hit) throw new Error(`fixture has no commit with subject "${subject}"`);
  return hit.sha;
};

beforeAll(() => {
  if (!existsSync(bundle) || !existsSync(expectedPath)) {
    throw new Error('Missing fixture. Run ./fixtures/make-bundle.sh once and commit both outputs.');
  }
  expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;

  work = mkdtempSync(join(tmpdir(), 'shipledger-e2e-'));
  repoPath = join(work, 'repo');
  execFileSync('git', ['clone', '--quiet', bundle, repoPath]);

  const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
  config.repos[0].path = repoPath;
  configPath = join(work, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));

  changesetPath = join(work, 'changeset.json');
  writeFileSync(changesetPath, readFileSync(join(here, 'changeset.json'), 'utf8'));
  outPath = join(work, 'verified.json');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

const args = (): string[] =>
  ['--config', configPath, '--changeset', changesetPath, '--out', outPath, '--stable'];

const read = (): VerifiedChangeset =>
  validateVerified(JSON.parse(readFileSync(outPath, 'utf8')));

describe('end to end over the deterministic bundle', () => {
  it('exits 1 because the fixture contains one unknown reference', () => {
    expect(runCheck(args(), process.cwd())).toBe(1);
  });

  it('resolves both refs to the SHAs recorded in the fixture', () => {
    runCheck(args(), process.cwd());
    const range = read().ranges[0];
    expect(range?.headSha).toBe(shaFor('chore(deps): bump left-pad'));
    expect(range?.baseIsAncestorOfHead).toBe(true);
    expect(range?.include).toEqual(['packages/a/**']);
  });

  it('links PROJ-1 and PROJ-2 to their exact commits with no findings', () => {
    runCheck(args(), process.cwd());
    const v = read();

    const first = v.commits.find((c) => c.sha === shaFor('PROJ-1: add the widget (#11)'));
    expect(first?.findings).toEqual([]);
    expect(v.items.find((i) => i.id === 'PROJ-1')?.commits).toEqual([
      { repo: 'pinned', sha: shaFor('PROJ-1: add the widget (#11)') }
    ]);

    // Both the ticket key and the pull request number are declared, so both
    // references resolve and the commit is clean. Declaring only the ticket key
    // would leave `#12` unresolved and add unknown-reference.
    const second = v.commits.find((c) => c.sha === shaFor('PROJ-2: fix the gadget (#12)'));
    expect(second?.references.map((r) => r.token).sort()).toEqual(['#12', 'PROJ-2']);
    expect(second?.references.every((r) => r.resolvesTo.length > 0)).toBe(true);
    expect(second?.findings).toEqual([]);
    expect(v.items.find((i) => i.id === 'PROJ-2')?.commits).toEqual([
      { repo: 'pinned', sha: shaFor('PROJ-2: fix the gadget (#12)') }
    ]);
  });

  it('flags the PROJ-9 commit, whose ticket key and pull request number are both unclaimed', () => {
    runCheck(args(), process.cwd());
    const commit = read().commits.find((c) => c.sha === shaFor('PROJ-9: unrelated work (#13)'));
    expect(commit?.findings).toEqual(['unknown-reference']);
    expect(commit?.references.map((r) => r.token).sort()).toEqual(['#13', 'PROJ-9']);
    expect(commit?.references.every((r) => r.resolvesTo.length === 0)).toBe(true);
  });

  it('flags the reformat commit as no-reference', () => {
    runCheck(args(), process.cwd());
    expect(read().commits.find((c) => c.sha === shaFor('chore: reformat everything'))?.findings)
      .toEqual(['no-reference']);
  });

  it('ignores the dependabot commit by author rule and gives it no findings', () => {
    runCheck(args(), process.cwd());
    const commit = read().commits.find((c) => c.sha === shaFor('chore(deps): bump left-pad'));
    expect(commit?.ignored?.rule).toBe('authors:dependabot[bot]');
    expect(commit?.findings).toEqual([]);
  });

  it('excludes the package-b commit via the include pathspec', () => {
    runCheck(args(), process.cwd());
    const subjects = read().commits.map((c) => c.subject);
    expect(subjects).not.toContain('docs: only touches package b (#14)');
  });

  it('walks exactly the five in-scope commits', () => {
    runCheck(args(), process.cwd());
    expect(read().commits.map((c) => c.subject)).toEqual([
      'chore(deps): bump left-pad',
      'chore: reformat everything',
      'PROJ-9: unrelated work (#13)',
      'PROJ-2: fix the gadget (#12)',
      'PROJ-1: add the widget (#11)'
    ]);
  });

  it('flags PROJ-3 as claimed with no commits', () => {
    runCheck(args(), process.cwd());
    expect(read().items.find((i) => i.id === 'PROJ-3')?.findings).toEqual(['item-without-commits']);
  });

  it('reports exact summary counts', () => {
    runCheck(args(), process.cwd());
    const v = read();
    expect(v.summary).toEqual({
      items: 3, itemsLinked: 2, commits: 5, commitsIgnored: 1,
      noReference: 1, unknownReference: 1, itemsWithoutCommits: 1, rangeDivergence: 0
    });
    expect(v.violations).toEqual([{ finding: 'unknown-reference', count: 1 }]);
    expect(v.verdict).toBe('fail');
  });

  it('produces an artifact that passes its own semantic validation', async () => {
    const { assertVerifiedSemantics } = await import('../../src/verify.js');
    runCheck(args(), process.cwd());
    expect(() => assertVerifiedSemantics(read())).not.toThrow();
  });

  it('produces byte-identical output across two runs', () => {
    runCheck(args(), process.cwd());
    const first = readFileSync(outPath, 'utf8');
    runCheck(args(), process.cwd());
    expect(readFileSync(outPath, 'utf8')).toBe(first);
  });

  it('renders every format without error', () => {
    runCheck(args(), process.cwd());
    for (const format of ['report', 'changelog', 'release-notes']) {
      expect(runRender([format, '--input', outPath], process.cwd())).toBe(0);
    }
  });

  it('rejects a shallow clone with exit 3', () => {
    const shallow = join(work, 'shallow');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repoPath}`, shallow]);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.repos[0].path = shallow;
    const shallowConfig = join(work, 'shallow-config.json');
    writeFileSync(shallowConfig, JSON.stringify(config));
    expect(runCheck(['--config', shallowConfig, '--changeset', changesetPath, '--out', outPath], process.cwd())).toBe(3);
  });
});
```

Run: `npm test --workspace shipledger -- e2e`
Expected: all fourteen tests PASS. If a count differs, the fixture and the derivation in Step 2 disagree — work out which is wrong and fix that. **Do not relax an assertion to make it pass**; the counts are the product here.

- [ ] **Step 4: Confirm the spec still matches the fixture that was built**

Decision 1 at the top of this plan was settled as synthetic and the spec was amended before implementation began. Verify it still reads that way:

Run: `rg -n 'make-bundle' docs/superpowers/specs/2026-09-01-shipledger-design.md`
Expected: the Repo layout line naming `fixtures/make-bundle.sh`.

If it instead describes a "git bundle of the pinned public repo", **stop and raise it** — something reverted the spec, and the fixture you just built no longer matches the contract. Do not edit the spec from inside this task; a plan that amends its own spec is how a contract stops being one.

- [ ] **Step 5: Commit**

```bash
git add fixtures packages/cli/test/e2e docs/superpowers/specs
git commit -m "test: deterministic end-to-end bundle with exact SHA assertions"
```

---

### Task 17: The agent plugin

**Files:**
- Create: `plugin/.cursor-plugin/plugin.json`, `plugin/skills/shipledger/SKILL.md`, `plugin/skills/shipledger/templates/change-request.md`, `plugin/cli-compatibility.json`, `plugin/README.md`
- Test: `packages/cli/test/plugin.test.ts`

**Interfaces:**
- Consumes: the CLI command surface, exit codes, and `checkCliRange`.
- Produces: no source interfaces. `plugin/cli-compatibility.json` declares `{ "cliRange": "^0.1.0" }`, which the skill passes to `doctor --skill-cli-range`.

Skills are discovered from `plugin/skills/<name>/SKILL.md` with YAML frontmatter, which is the normal Cursor discovery contract; the manifest names the plugin rather than enumerating skill files.

- [ ] **Step 1: Write the manifest and compatibility declaration**

`plugin/.cursor-plugin/plugin.json`:

```json
{
  "name": "shipledger",
  "version": "0.1.0",
  "description": "Reconcile a claimed release changeset against git history, then render release artifacts from the verified result."
}
```

`plugin/cli-compatibility.json`:

```json
{ "cliRange": "^0.1.0" }
```

- [ ] **Step 2: Write the skill**

`plugin/skills/shipledger/SKILL.md`:

```markdown
---
name: shipledger
description: >-
  Reconcile a claimed release changeset against git history using the shipledger
  CLI. Use when the user wants to verify a release, find commits that shipped
  without a ticket, find claimed work with no code, or produce a changelog or
  change request from a verified changeset.
---

# shipledger — verify a release, then write it up

## What this skill does and does not do

The CLI decides every match. It is deterministic and reproducible, and you must
not second-guess it. Your job is the four things it cannot do:

1. Build `changeset.json` from whatever tracker the user has.
2. Declare every matchable identifier in `items[].tokens`.
3. Confirm the ranges with the user.
4. Triage the findings into `notes.json`.

Never edit `verified-changeset.json`. Never claim a commit belongs to an item the
CLI did not link.

## Step 0 — Check compatibility and environment

Read `cliRange` from `plugin/cli-compatibility.json` and pass it through:

```bash
npx shipledger doctor --config shipledger.config.json --skill-cli-range '^0.1.0'
```

Exit 3 on an incompatible or uninterpretable range means stop and tell the user
which CLI version to pin. If there is no config yet:

```bash
npx shipledger init --preset tracker-keys   # or github-oss
```

`init` writes a pinned preset (`tracker-keys@1`). `check` and `doctor` reject an
unpinned preset, because an unpinned preset would let a CLI upgrade silently
change the policy a release was judged against.

## Step 1 — Build the changeset

Fetch the claimed release from the user's tracker using whatever is available —
an MCP server, a CLI such as `gh`, or a pasted export. Then write
`changeset.json`.

- `source` is mandatory: `kind`, `ref` (the exact query or URL), `fetchedAt`.
- **`id` is opaque identity and is never matched against git.** Every identifier
  that might appear in a commit goes in `tokens` — including the item's own
  primary key or issue number. An item with no tokens is a schema error.
- Each token names its `matcher` and, for a repo-namespaced matcher, its `repo`:

```json
{
  "id": "example/repo-a#100",
  "title": "Handle empty range gracefully",
  "type": "issue",
  "status": "closed",
  "tokens": [
    { "matcher": "pr-ref", "token": "#100", "repo": "repo-a" },
    { "matcher": "pr-ref", "token": "#123", "repo": "repo-a" }
  ]
}
```

- This is the second hop: when a squash-merge subject carries a pull request
  number rather than an issue number, the token list is the only thing that
  connects them. You have the forge API; the CLI does not.
- V1 allows **one range per repo**. Multiple paths go in that range's `include`.

## Step 2 — Confirm the ranges

Do not invent `base` and `head`. Propose them and get confirmation:

> "I'll compare `repo-a` from `v1.3.0` to `v1.4.0`, scoped to `packages/thing/**`.
> Correct?"

## Step 3 — Run the check

```bash
npx shipledger check --config shipledger.config.json --changeset changeset.json --out verified-changeset.json
npx shipledger render report --input verified-changeset.json
```

Exit codes: `0` pass; `1` policy violation, which is an expected outcome to
triage; `2` your input is wrong — fix the config or changeset; `3` environment —
the message names the remedy, and you must **not** fetch or check out on the
user's behalf.

## Step 4 — Triage the findings

Triage is **all or nothing**. If you pass `--notes`, the file must account for
every finding in the artifact — exactly one entry each, no entries for findings
that are not there, and a real sentence on each. If you cannot classify
everything, **omit `--notes`** and render an explicitly untriaged artifact rather
than a partial one dressed up as complete.

Each section is an array of records, not a keyed object. Use this vocabulary and
nothing else:

| Section | Identifies a finding by | Allowed classifications |
| --- | --- | --- |
| `noReference` | `repo`, `sha` | `revert`, `dependency-bump`, `hotfix-already-released`, `tooling-or-ci`, `process-miss` |
| `unknownReference` | `repo`, `sha`, `matcher`, `token` | `other-release`, `typo`, `wrongly-omitted` |
| `items` | `item` | `configuration-only`, `documentation-only`, `landed-earlier`, `wrongly-tagged`, `not-done` |
| `ranges` | `repo` | `expected-divergence`, `wrong-base` |

```json
{
  "version": 1,
  "noReference": [
    { "repo": "repo-a", "sha": "<full 40-char sha>", "classification": "tooling-or-ci", "note": "CI workflow only" }
  ],
  "unknownReference": [
    { "repo": "repo-a", "sha": "<full 40-char sha>", "matcher": "ticket-key", "token": "PROJ-9", "classification": "other-release", "note": "shipped in 1.3.0" }
  ],
  "items": [
    { "item": "PROJ-3", "classification": "not-done", "note": "moved to the next release" }
  ],
  "ranges": []
}
```

An `unknownReference` entry names the full reference tuple rather than just the
commit, so two unknown references on one commit take separate dispositions. Reuse
the same sentence wherever it genuinely applies — forty dependency bumps may all
say "routine dependency bump"; that is not a shortcut, it is the truth.

`render` also re-checks the artifact's internal consistency, so a hand-edited
`verified-changeset.json` is rejected rather than rendered.

`unknown-reference` matters most: work shipped that this release does not claim.
Never classify it as benign without evidence — name the release it belongs to, or
flag it to the user. If you cannot classify something, say so and ask. A wrong
classification in an audit artifact is worse than an open question.

## Step 5 — Render the artifact

```bash
npx shipledger render changelog --input verified-changeset.json --notes notes.json
npx shipledger render release-notes --input verified-changeset.json --notes notes.json
```

Org-specific artifacts come from you, using `templates/change-request.md`. Fill
every field from `verified-changeset.json` and `notes.json`. Do not invent test
evidence, approvers, or rollback steps.

## Write discipline

The CLI writes only its own output files. Everything else — posting to a tracker,
commenting on a PR, updating a wiki — is **propose → confirm**, one confirmation
per write, showing the exact payload and destination first. Approval of a plan is
not approval of the writes inside it.
```

- [ ] **Step 3: Write the change-request template and README**

`plugin/skills/shipledger/templates/change-request.md`:

```markdown
# Change request — {{changeset.id}}

**Verified changeset fingerprint:** {{configFingerprint}}
**Preset / history:** {{preset}} / {{history}}
**Claim source:** {{changeset.source.kind}} — {{changeset.source.ref}} (fetched {{changeset.source.fetchedAt}})
**Verdict:** {{verdict}}

## Scope

| Repo | Base | Head | Path scope | Complete |
| --- | --- | --- | --- | --- |
| {{range.repo}} | {{range.base}} ({{range.baseSha}}) | {{range.head}} ({{range.headSha}}) | {{range.include}} | {{range.baseIsAncestorOfHead}} |

Verified work items: {{summary.itemsLinked}} of {{summary.items}}.

## Verified contents

| Item | Title | Commits |
| --- | --- | --- |
| {{item.id}} | {{item.title}} | {{item.commits.length}} |

## Reconciliation result

| Finding | Count | Disposition (from notes.json) |
| --- | --- | --- |
| Commits with no reference | {{summary.noReference}} | |
| Commits referencing other releases | {{summary.unknownReference}} | |
| Items claimed with no code | {{summary.itemsWithoutCommits}} | |
| Incomplete ranges | {{summary.rangeDivergence}} | |
| Commits ignored by rule | {{summary.commitsIgnored}} | |

## Risk

State the risk implied by the reconciliation result. An unresolved
`unknown-reference` is an unassessed change in the release and must be named here.
An incomplete range means the artifact does not describe everything that shipped.

## Rollback

(Operator-supplied. Do not invent.)

## Evidence

(Operator-supplied test evidence. Do not invent.)
```

`plugin/README.md`:

```markdown
# shipledger plugin

The agent half of shipledger. The CLI decides matches; this skill builds the
claim, confirms the ranges, triages the findings, and writes the artifact.

## Install

Claude Code:

```bash
ln -s "$(pwd)/plugin/skills/shipledger" ~/.claude/skills/shipledger
```

Cursor: add this directory as a local plugin, or symlink `plugin/skills/shipledger`
into `~/.cursor/skills/`.

## CLI compatibility

`cli-compatibility.json` declares the CLI range this skill was written against.
The skill passes it to `shipledger doctor --skill-cli-range`, which fails before
a release is checked if the installed CLI does not satisfy it. Pin explicitly
with `npx shipledger@<version>` when you need to.

There is nothing to build — the skill invokes the published CLI with `npx`.
```

- [ ] **Step 4: Write the plugin conformance test**

`packages/cli/test/plugin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCliRange } from '../src/cli/doctor.js';
import { CLI_VERSION } from '../src/cli/version.js';
import { NO_REFERENCE_CLASSIFICATIONS, UNKNOWN_REFERENCE_CLASSIFICATIONS, ITEM_CLASSIFICATIONS, RANGE_CLASSIFICATIONS } from '../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const plugin = join(root, 'plugin');
const skill = join(plugin, 'skills', 'shipledger', 'SKILL.md');

describe('plugin layout', () => {
  it('has a manifest with a valid name', () => {
    const manifest = JSON.parse(readFileSync(join(plugin, '.cursor-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('shipledger');
  });

  it('exposes the skill where skills/ discovery expects it', () => {
    expect(existsSync(skill)).toBe(true);
  });

  it('ships the change-request template the skill references', () => {
    expect(existsSync(join(plugin, 'skills', 'shipledger', 'templates', 'change-request.md'))).toBe(true);
  });
});

describe('skill frontmatter', () => {
  const text = readFileSync(skill, 'utf8');

  it('starts with YAML frontmatter carrying name and description', () => {
    expect(text.startsWith('---\n')).toBe(true);
    const front = text.slice(4, text.indexOf('\n---', 4));
    expect(front).toMatch(/^name:\s*shipledger$/m);
    expect(front).toMatch(/^description:/m);
  });
});

describe('cli compatibility declaration', () => {
  const { cliRange } = JSON.parse(readFileSync(join(plugin, 'cli-compatibility.json'), 'utf8'));

  it('is a range this CLI can interpret', () => {
    expect(checkCliRange(cliRange, CLI_VERSION).ok).toBe(true);
  });

  it('is satisfied by the current CLI version', () => {
    expect(checkCliRange(cliRange, CLI_VERSION)).toEqual({ ok: true, compatible: true });
  });
});

describe('skill documents the real contracts', () => {
  const text = readFileSync(skill, 'utf8');

  it('lists every classification the schema accepts', () => {
    for (const c of [
      ...NO_REFERENCE_CLASSIFICATIONS, ...UNKNOWN_REFERENCE_CLASSIFICATIONS,
      ...ITEM_CLASSIFICATIONS, ...RANGE_CLASSIFICATIONS
    ]) {
      expect(text).toContain(c);
    }
  });

  it('documents the note sections as arrays identified by their fields', () => {
    expect(text).toContain('"unknownReference": [');
    expect(text).toContain('"matcher": "ticket-key"');
  });

  it('does not document the superseded colon-delimited key form', () => {
    expect(text).not.toContain('<repo>:<sha>');
  });

  it('states the all-or-nothing coverage rule and the untriaged escape hatch', () => {
    expect(text).toMatch(/all or nothing/i);
    expect(text).toMatch(/omit `--notes`/i);
  });

  it('states that item id is not matchable', () => {
    expect(text).toMatch(/never matched against git/i);
  });
});
```

Run: `npm test --workspace shipledger -- plugin`
Expected: all tests PASS. This test is what stops the skill's documented vocabulary drifting away from the schema.

- [ ] **Step 5: Commit**

```bash
git add plugin packages/cli/test/plugin.test.ts
git commit -m "feat: agent skill, change-request template, pinned CLI compatibility"
```

---

### Task 18: Tested examples, one per preset

**Files:**
- Create: `examples/tracker-keys/{shipledger.config.json,changeset.json}`, `examples/github-oss/{shipledger.config.json,changeset.json}`
- Test: `packages/cli/test/examples.test.ts`

**Interfaces:**
- Consumes: `validateConfig`, `validateChangeset`, `mergeConfig`, `assertConfigIdentities`, `assertChangesetAgainstConfig`, `compileAll`.
- Produces: no new interfaces. The examples become tested artifacts rather than prose that rots.

- [ ] **Step 1: Write the examples**

`examples/tracker-keys/shipledger.config.json`:

```json
{
  "version": 1,
  "preset": "tracker-keys@1",
  "repos": [
    { "name": "repo-a", "path": "../repo-a" },
    { "name": "repo-b", "path": "../repo-b" }
  ],
  "policy": { "failOn": ["no-reference", "unknown-reference", "item-without-commits", "range-divergence"] }
}
```

`examples/tracker-keys/changeset.json`:

```json
{
  "version": 1,
  "id": "release 1.4.0",
  "source": {
    "kind": "tracker-release",
    "ref": "https://tracker.example.invalid/projects/PROJ/versions/1234",
    "fetchedAt": "2026-09-01T01:00:00Z"
  },
  "items": [
    {
      "id": "PROJ-42",
      "title": "Handle empty range gracefully",
      "type": "story",
      "status": "done",
      "url": "https://tracker.example.invalid/browse/PROJ-42",
      "tokens": [{ "matcher": "ticket-key", "token": "PROJ-42" }]
    },
    {
      "id": "PROJ-77",
      "title": "Warn on divergent ranges",
      "type": "bug",
      "status": "done",
      "url": "https://tracker.example.invalid/browse/PROJ-77",
      "tokens": [
        { "matcher": "ticket-key", "token": "PROJ-77" },
        { "matcher": "pr-ref", "token": "#312", "repo": "repo-b" }
      ]
    }
  ],
  "ranges": [
    { "repo": "repo-a", "base": "v1.3.0", "head": "v1.4.0" },
    { "repo": "repo-b", "base": "release/1.3", "head": "release/1.4", "include": ["packages/thing/**"] }
  ]
}
```

`examples/github-oss/shipledger.config.json`:

```json
{
  "version": 1,
  "preset": "github-oss@1",
  "repos": [{ "name": "repo-a", "path": "../repo-a" }]
}
```

This one deliberately omits `policy`, so it inherits `github-oss@1`'s default — fatal on `unknown-reference` and `range-divergence`, while `no-reference` and `item-without-commits` are reported but not fatal. It doubles as the worked example of a config relying on preset defaults.

`examples/github-oss/changeset.json`:

```json
{
  "version": 1,
  "id": "v1.4.0 milestone",
  "source": {
    "kind": "github-milestone",
    "ref": "https://github.com/example/repo-a/milestone/7",
    "fetchedAt": "2026-09-01T01:00:00Z"
  },
  "items": [
    {
      "id": "example/repo-a#100",
      "title": "Handle empty range gracefully",
      "type": "issue",
      "status": "closed",
      "url": "https://github.com/example/repo-a/issues/100",
      "tokens": [
        { "matcher": "pr-ref", "token": "#100", "repo": "repo-a" },
        { "matcher": "pr-ref", "token": "#123", "repo": "repo-a" }
      ]
    }
  ],
  "ranges": [{ "repo": "repo-a", "base": "v1.3.0", "head": "v1.4.0" }]
}
```

- [ ] **Step 2: Write the examples test**

`packages/cli/test/examples.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, validateChangeset } from '../src/config/validate.js';
import { mergeConfig, assertConfigIdentities } from '../src/config/load.js';
import { assertChangesetAgainstConfig } from '../src/config/changeset.js';
import { compileAll } from '../src/core/compile.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe.each(['tracker-keys', 'github-oss'])('examples/%s', (name) => {
  const dir = join(root, 'examples', name);
  const rawConfig = JSON.parse(readFileSync(join(dir, 'shipledger.config.json'), 'utf8'));
  const rawChangeset = JSON.parse(readFileSync(join(dir, 'changeset.json'), 'utf8'));

  it('has a schema-valid config with a pinned preset', () => {
    const parsed = validateConfig(rawConfig);
    expect(parsed.preset).toMatch(/@\d+$/);
  });

  it('has a policy that is either absent or complete, never partial', () => {
    const parsed = validateConfig(rawConfig);
    if (parsed.policy !== undefined) expect(Array.isArray(parsed.policy.failOn)).toBe(true);
  });

  it('has a schema-valid changeset', () => {
    expect(() => validateChangeset(rawChangeset)).not.toThrow();
  });

  it('resolves, compiles, and cross-checks cleanly', () => {
    const config = mergeConfig(validateConfig(rawConfig), dir);
    assertConfigIdentities(config);
    compileAll(config);
    expect(() => assertChangesetAgainstConfig(validateChangeset(rawChangeset), config)).not.toThrow();
  });
});
```

Run: `npm test --workspace shipledger -- examples`
Expected: PASS. If it fails, the example is wrong — fix the example, not the test.

- [ ] **Step 3: Commit**

```bash
git add examples packages/cli/test/examples.test.ts
git commit -m "docs: one tested example config and changeset per preset"
```

---

### Task 19: Packaging smoke test, CI, and README

**Files:**
- Test: `packages/cli/test/pack.test.ts`
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: the built package and its `bin`.
- Produces: no new interfaces. `npm pack` output is exercised as a real install, which is what catches a `files` field that forgot `schemas`.

- [ ] **Step 1: Write the packaging smoke test**

`packages/cli/test/pack.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let work: string;
let bin: string;

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: pkgDir, encoding: 'utf8' });
  work = mkdtempSync(join(tmpdir(), 'shipledger-pack-'));
  execFileSync('npm', ['pack', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8' });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(work, tarball)], { cwd: work, encoding: 'utf8' });
  bin = join(work, 'node_modules', '.bin', 'shipledger');
}, 180_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(bin, args, { cwd: work, encoding: 'utf8' }) };
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
```

Run: `npm test --workspace shipledger -- pack`
Expected: all six tests PASS. This is the test that catches a `files` field that forgot `schemas`.

- [ ] **Step 2: Write CI and the README**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['20', '22']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      # Requires the committed package-lock.json from Task 1.
      - run: npm ci
      # The fixture builder makes real commits; a runner with no git identity
      # fails in a way that looks like a test bug.
      - run: |
          git config --global user.email "ci@example.invalid"
          git config --global user.name "CI"
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

`README.md`:

```markdown
# shipledger

Checks that what your tracker says shipped actually shipped.

You give shipledger a claimed changeset — a tracker release, a GitHub milestone,
whatever you use — and the git ranges it should correspond to, across as many
repositories as the release spans. It reports where the claim and git disagree:
commits referencing work outside the release, commits referencing nothing, items
claiming to have shipped with no code behind them, and ranges that cannot be
walked completely. Changelogs and change requests are rendered from the verified
result, never from the raw range.

`git-cliff` and friends tell you what is in a git range. shipledger tells you
where the tracker and git disagree.

## Try it

```bash
npx shipledger init --preset github-oss
# edit "repos" to point at a checkout
npx shipledger doctor
npx shipledger check --changeset changeset.json
npx shipledger render report
```

## How it works

Matching is deterministic regular expressions over commit text, never a language
model, so the result is reproducible and a CI gate can depend on it. shipledger
never talks to your tracker: an agent (or you) normalises the claim into
`changeset.json`, which is why any tracker works with no adapters and no
credentials.

**It is repository-read-only.** It never fetches, checks out, mutates a working
tree, or makes a network call. It writes only the output files you name.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Pass |
| 1 | Policy violation — the tool worked; the release has problems |
| 2 | Usage, schema, consistency, or invalid-expression error |
| 3 | Environment error |

## Findings

| Finding | Meaning |
| --- | --- |
| `no-reference` | The commit references nothing recognisable |
| `unknown-reference` | It references something this release does not claim |
| `item-without-commits` | The claim says it shipped; git disagrees |
| `range-divergence` | `base` is not an ancestor of `head`, so the walk is asymmetric |

Findings are **not** mutually exclusive. A commit linked to one item can still
carry an unknown reference to another, and that is the signal the tool exists for.

Which findings are *fatal* is policy, and the two presets differ deliberately.
`tracker-keys` fails on all four: under a tracker, a commit with no ticket is a
process defect. `github-oss` fails only on `unknown-reference` and
`range-divergence`, because a drive-by fix with no issue is normal in open
source, and milestone issues closed as duplicate, wontfix, or docs-only routinely
have no code behind them. Both findings are still reported either way — they are
just not gate failures.

## Triage

`render` accepts an optional `notes.json`. Omit it and the artifact is explicitly
marked untriaged. Supply it and it must cover every finding exactly once, with a
non-empty sentence each, and name no finding that does not exist — a partial
triage presented as a complete one is the failure this rule exists to prevent.
Identical sentences may be reused freely, which matters when forty dependency
bumps share one disposition.

## Two things that surprise people

**An item's `id` is not matched against git.** Every identifier that can appear
in a commit is listed explicitly in `items[].tokens`, including the item's own
key. This keeps matching fully tuple-based — `(matcher, scope, token)` — so a
pull request number in `repo-a` can never match one in `repo-b`.

**A present config key replaces the preset value entirely**, objects and arrays
included. There is no deep merge, so an override must be complete. Presets are
pinned (`tracker-keys@1`) so a CLI upgrade cannot silently change the policy your
release was judged against.

## With an agent

`plugin/` holds a Claude Code / Cursor skill that builds the changeset, resolves
the pull-request-to-issue hop into tokens, triages findings into `notes.json`, and
renders a change request. See `plugin/README.md`.

## Configuration

Start from a preset (`tracker-keys` or `github-oss`) and override what you need.
Full reference: `examples/` and `packages/cli/schemas/`.

## Licence

MIT.
```

- [ ] **Step 3: Full clean run**

Run: `rm -rf node_modules packages/cli/node_modules && npm ci && npm run typecheck && npm test && npm run build`
Expected: all green from a clean install, including the e2e and pack suites. If `npm ci` fails here, `package-lock.json` was never committed in Task 1 — fix that rather than falling back to `npm install`, because CI has no other option.

- [ ] **Step 4: Verify the shipped surface one last time**

Run: `git status --short && git ls-files | rg -c '^(packages/cli/schemas|fixtures|plugin|examples)/'`
Expected: a clean tree, and non-zero counts for each shipped directory. A schema or fixture that exists locally but was never staged fails only in someone else's clone.

- [ ] **Step 5: Commit**

```bash
git add .github README.md packages/cli/test/pack.test.ts
git commit -m "ci: node matrix, packaging smoke test, README"
```

---

## Plan Self-Review

**Spec coverage.** Each spec section maps to at least one task.

| Spec section | Tasks |
| --- | --- |
| Architecture and unit boundaries | 1, 5–10 |
| `shipledger.config.json` incl. required pinned preset, blunt merge, exact-name ignores | 2, 3 |
| `changeset.json` incl. `tokens`, opaque `id`, strict identities, one range per repo | 2, 4 |
| `verified-changeset.json` incl. preset, history, changeset items, range include, commit body, item metadata | 1, 2, 8 |
| `notes.json` incl. four sections, fixed vocabulary, real sentences, exact coverage | 1, 2, 13 |
| Reconciliation: history modes, commit sources, two-stage references with `sources[]`, array `resolvesTo`, non-exclusive findings, ignored retention | 5, 6, 7, 8 |
| Range validation: resolve once, walk SHAs, ancestry status discipline, divergence finding | 9 |
| Lossless NUL-delimited git parsing, with malformed framing as a hard failure | 9 |
| Reproducibility contract: paths, four strict schemas, preset pinning, full fingerprint, config-order walking, timestamps, atomic write | 1, 2, 3, 8, 10 |
| CLI surface and exit codes, one shared error mapping | 1, 10, 11, 12, 15 |
| Failure behaviour, validation before git | 4, 5, 9, 10, 11 |
| Safety posture, doctor limited to provable facts | 9, 10, 11 |
| The skill, triage vocabulary, plugin pins CLI range, doctor reports incompatibility | 11, 17 |
| Testing table: core, git strategies incl. squash, renderers with goldens, CLI classes, e2e with exact assertions, packaging and plugin discovery | 5–9, 13–19 |
| Repo layout, packaging, licence | 1, 17, 19 |
| Both presets first-class in CI | 3, 18, 19 |
| Seam to sub-project 2 | deliberately unimplemented |

**Nineteen tasks, 93 steps.** Tasks 13–15 (notes coverage, renderers, render command) and 18–19 (examples, packaging and CI) were split from two larger tasks so each lands as an independently reviewable unit.

**Placeholder scan.** No `TBD`, `TODO`, or "implement later". The only templated strings are the `{{…}}` fields in the change-request template, which are template syntax by design, and `FILLED_IN_BY_TEST` for a temp-directory path that cannot be committed — Task 16 Step 2 derives every expected outcome concretely.

**Fixture-value audit.** Every value a schema pattern applies to is real: SHAs are 40 lowercase hex characters, fingerprints are `sha256:` plus 64 hex characters. This is called out because the previous revision used `'h'.repeat(40)` and `sha256:test`, which typecheck cleanly and fail schema validation, and the failure reads like an emitter bug rather than a bad fixture.

**Type consistency.** Defined once in Task 1 and used verbatim after: `ItemToken` (2, 4, 6), `Reference` with `sources`/`resolvesTo` arrays (5, 6, 7, 13), the four note record types (1, 2, 13, 14, 15, 17), `CompiledMatcher`/`CompiledIgnore` (5, 7, 8, 10, 11), `ItemIndex`/`buildItemIndex`/`resolveReferences` (6, 8), `matchIgnoreRule`/`commitFindings`/`summarise`/`decideVerdict` (7, 8, 13), `parseLogOutput`/`walkRange` (9, 10), `RangeResult` from `resolveRange` (8, 9, 10, 11), `parseOrUsage` (10–12, 15), `writeAtomic` (10, 12), `CLI_VERSION` (10–12, 17), `validateVerified` (2, 8, 13, 15, 16), `commitKey`/`referenceKey`/`buildNoteLookup`/`assertNotesCoverFindings` (13, 14, 15), `assertVerifiedSemantics` (13, 15, 16), `checkCliRange` (11, 17), the four classification constants (1, 2, 17).

**Corrections applied in this revision, listed so they can be checked rather than trusted.** Task 8's fixtures now satisfy the schema they are validated against. Task 16's expected end-to-end result is re-derived from first principles: `PROJ-2` declares `#12` because `tracker-keys@1` extracts both a ticket key and a pull request number from that subject, and the dependabot commit now touches `packages/a/` because pathspec filtering removes out-of-scope commits before ignore rules are consulted. `package-lock.json` is staged in Task 1. Ranges are walked in config order. Doctor validates its changeset before opening repositories. Caret ranges follow npm's 0.x semantics, so `^0.1.0` rejects `0.2.0`. Malformed git framing throws instead of returning a short list. Note keys are NUL-delimited internally and structured records on disk. The CLI entry-point check survives spaces, symlinks, and Windows paths.

**Remaining judgement call, surfaced rather than buried.** `doctor` implements only `^x.y.z`, `>=x.y.z`, and exact pins, reporting anything else as uninterpretable rather than adding a semver dependency against the one-runtime-dependency constraint — an adopter writing `~1.2.3` gets a clear refusal, not a wrong answer.

**Blocking on nothing.** Every decision in section 2 at the top of this plan is settled and applied to the spec: the `github-oss@1` policy, the notes record shape, the coverage rule, artifact semantic validation, and the synthetic fixture. The spec is the contract and this plan implements it; neither document now asserts anything the other contradicts.
