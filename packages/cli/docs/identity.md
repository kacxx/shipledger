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

## Authority

- `build.digest` is the **authoritative** identity: the content digest of the
  runtime bytes. It is independently reproducible (see manifest v1 below), so a
  consumer must recompute it over the package it resolved and compare.
- `commit` is **source-traceability metadata only**. It is the commit embedded
  at build time from `git rev-parse HEAD`, or `null` when the build had no git
  context. It is self-reported and is **not** independently verified; a consumer
  must not treat it as verified provenance unless it checks it against a trusted
  source. The digest, not the commit, is the trust anchor.

## Manifest v1 (`digestManifestVersion: "1"`)

The digest is reproducible under these rules:

1. The file set is every regular file under `dist/` and `schemas/` in the
   installed package root.
2. Each file contributes a pair `[packageRelativePosixPath, sha256Hex(content)]`.
   - Paths are POSIX and **package-relative** — absolute paths never enter the
     digest.
   - Only raw file **content** is hashed — no timestamps, mode, or other
     filesystem metadata.
3. The pairs are sorted lexicographically by path and serialised as compact JSON
   (`JSON.stringify`).
4. `digest = "sha256:" + sha256Hex(thatSerialisation)`.

Explicitly excluded (so the digest is a pure runtime identity, insensitive to
mutable inputs): `node_modules/`, `package.json` dependency ranges, lockfiles,
`docs/`, `build-info.json`, and the embedded commit.

The manifest is **versioned**: any change to the file set or serialisation must
bump `digestManifestVersion` so both producer and consumer agree on the exact
algorithm.
