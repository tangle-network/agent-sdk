---
"@tangle-network/agent-core": patch
---

fix(auth): make the token module browser-import-safe

The auth token module referenced `Buffer` at module-eval time (top-level
`JWT_HEADER` / `JWT_HEADER_EDDSA` = `base64UrlEncode(...)`) and statically
imported `node:crypto`. Because the package **root** re-exports this module,
any browser bundle that transitively imports `@tangle-network/agent-core`
(e.g. via `@tangle-network/sdk-telemetry`) boot-crashed with
`ReferenceError: Buffer is not defined`.

- base64url encode/decode is now isomorphic (`btoa`/`atob` + `TextEncoder`/
  `TextDecoder`), never `Buffer`
- the HS256 and EdDSA JWT headers are computed lazily on first use, not at
  module load
- HMAC/Ed25519 signing, verification, and key generation resolve `node:crypto`
  on demand via `process.getBuiltinModule` (server-only), so merely importing
  the module never pulls the builtin into a browser graph

Token wire format is unchanged — already-issued tokens still verify.
