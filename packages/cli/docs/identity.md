# `shipledger identity` — measured build identity

`shipledger identity` prints, as a single JSON line, the identity of the CLI
build that is running. It exists so a consumer (for example a release-control
plane) can bind the exact Shipledger build it invoked into an audit record and
**independently reproduce** the authoritative part of that identity.

```json
{
  "schemaVersion": 1,
  "cliVersion": "0.1.0",
  "commit": "2be555fbf8314baf0664162ec70d9c1e3e186683",
  "build": {
    "algorithm": "sha256",
    "digestManifestVersion": "1",
    "digest": "sha256:…",
    "fileCount": 42
  }
}
```

`identity` **fails closed**. If the build cannot be measured into a trustworthy
identity — the `dist/` tree or the published bin entry is missing, the file set
is empty, or a symlink or a filesystem race is encountered — it writes a
controlled error to stderr and exits non-zero (3) instead of printing a
valid-looking report. A broken or empty build never reports an identity.

## Authority

- `build.digest` is the **authoritative** identity: a content digest of the
  immutable published build content. It is independently reproducible (see
  manifest v1 below), so a consumer must recompute it over the package it
  resolved and compare.
- `commit` is **source-traceability metadata only**. It is the commit embedded
  at build time from `git rev-parse HEAD`, or `null` when the build had no git
  context. It is self-reported and is **not** independently verified; a consumer
  must not treat it as verified provenance unless it checks it against a trusted
  source. The digest, not the commit, is the trust anchor. Both Git object
  formats are accepted: 40-hex (SHA-1) and 64-hex (SHA-256).

## What the digest identifies

The digest identifies the **immutable published build content** — the exact
bytes npm publishes under `dist/` and `schemas/`. That is the whole published
surface, *not* only the JavaScript that executes: the emitted TypeScript
declarations (`*.d.ts`) and runtime schema data are part of the identity too. A
change to any published byte — including a type-only change that alters a
`.d.ts` while leaving the emitted `.js` untouched — changes the identity, by
design. This is a build-artifact identity, not a "bytes the interpreter runs"
identity.

## Manifest v1 (`digestManifestVersion: "1"`)

The algorithm is defined **language-neutrally** so a non-JavaScript consumer can
reproduce it byte-for-byte. Fixed cross-implementation test vectors live in
`packages/cli/test/fixtures/manifest-v1-digest-vectors.json` (shipledger) and are
shared byte-for-byte with Release Control's copy; both test suites assert their
independent implementation reproduces them.

1. **File set** — every regular file under `dist/` and `schemas/` in the
   installed package root. Symlinks are rejected (the identity must be the
   package's own bytes). `schemas/` is optional; `dist/` and the bin entry
   (`dist/cli/index.js`) are required — an empty set or a missing bin entry is a
   fail-closed error, not a digest.
2. **Per-file entry** — each file contributes a pair
   `[packageRelativePosixPath, sha256Hex(rawBytes)]`.
   - The content hash is sha256 over the file's **raw bytes** — never a text
     decode — as lower-case hex.
   - Paths are POSIX and **package-relative**; absolute paths never enter the
     digest. No timestamps, mode, or other filesystem metadata are hashed.
3. **Ordering** — the pairs are ordered by the **UTF-8 byte sequence of the
   path**, which equals Unicode code-point order. This is deliberately *not*
   JavaScript's default string comparison (UTF-16 code units), which orders
   astral characters differently; see the `non-ascii-ordering` test vector.
4. **Serialisation** — the ordered array of pairs is serialised with
   **RFC 8785 (JSON Canonicalisation Scheme)**. For this all-string data that is
   identical to compact JSON: `[["path","hash"],…]` with no insignificant
   whitespace and RFC 8785 string escaping.
5. **Digest** — `digest = "sha256:" + sha256Hex(utf8Bytes(serialisation))`.

Explicitly excluded (so the digest is insensitive to mutable / non-published
inputs): `node_modules/`, `package.json` (and its dependency ranges), lockfiles,
`docs/`, `build-info.json`, and the embedded commit.

The manifest is **versioned**: any change to the file set, ordering, or
serialisation must bump `digestManifestVersion` so both producer and consumer
agree on the exact algorithm.
