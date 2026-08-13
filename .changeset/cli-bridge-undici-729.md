---
"@tangle-network/agent-provider-cli-bridge": patch
---

Bump `undici` from 7.28.0 to 7.29.0 to clear GHSA-4cwx-7wf7-3272 (high) and four
moderate advisories, all fixed at undici >=7.29.0.

`undici` is declared through the workspace catalog, and this package is the only
catalog consumer. The cleared advisories are:

- GHSA-4cwx-7wf7-3272 (high) — cross-user information disclosure and parse-time
  crash via degenerate private cache directives.
- GHSA-8xcm-r25x-g524 (moderate) — downstream response desynchronization via the
  retry interceptor.
- GHSA-m8rv-5g2x-5cg5 (moderate) — CRLF injection via a blob-like body `type`
  property.
- GHSA-jr45-8vmc-qm54 (moderate) — cross-user information disclosure via
  whitespace around equals in `Cache-Control` directives.
- GHSA-v3r7-h72x-cjcm (moderate) — cookie attribute injection via an unsanitized
  domain and unparsed `setCookie` fields.

The provider imports only `Agent` and `fetch` from `undici` in `transport.ts`.
Both stay unchanged across the 7.x line, so 7.29.0 is a drop-in minor bump with
no API change.
