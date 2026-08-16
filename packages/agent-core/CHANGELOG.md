# @tangle-network/agent-core

## 0.9.1

### Patch Changes

- Updated dependencies [d7be4d4]
  - @tangle-network/agent-interface@0.54.0

## 0.9.0

### Minor Changes

- 2ab01fc: Add the public interactions package for shared permission, question, and plan transport behavior.

## 0.8.1

### Patch Changes

- Updated dependencies [5ab7e8c]
  - @tangle-network/agent-interface@0.53.0

## 0.8.0

### Minor Changes

- c4e1978: Add caller cancellation as a canonical stream status and keep the Agent Core status type aligned with that contract.

### Patch Changes

- Updated dependencies [c4e1978]
- Updated dependencies [18dd3ce]
  - @tangle-network/agent-interface@0.52.0

## 0.7.3

### Patch Changes

- Updated dependencies [3cdb9d4]
  - @tangle-network/agent-interface@0.51.0

## 0.7.2

### Patch Changes

- Updated dependencies [bdb076b]
  - @tangle-network/agent-interface@0.50.0

## 0.7.1

### Patch Changes

- Updated dependencies [a47e59e]
- Updated dependencies [d93bac3]
  - @tangle-network/agent-interface@0.49.0

## 0.7.0

### Minor Changes

- 609d7fc: Validate the `cap` claim on sidecar access tokens, on both halves of the round
  trip.

  `cap` is the claim that decides authorization, and neither
  `issueSidecarAccessToken` nor `verifySidecarToken` inspected it. Every value a
  JSON claim can hold round-tripped intact: `cap: 42`, `cap: null`, `cap: {}`,
  `cap: ["totally_made_up"]`, and — the one that mattered — `cap: "read"`, a bare
  string. A consumer's `cap.includes("read")` degrades on a string into a
  substring test, so `cap: "read"` satisfied a read gate and `cap: "terminal"`
  would have satisfied a terminal gate. The non-array values instead threw a
  `TypeError` out of the consumer's auth middleware, reporting a server fault
  where the honest answer was "this token is malformed".

  `SidecarCapability` is now derived from a `SIDECAR_CAPABILITIES` list, the same
  way `SidecarSidScope` derives from `SIDECAR_SID_SCOPES`, so the type a caller
  programs against and the set the verifier enforces cannot drift apart.

  Fails closed on both sides. Minting throws unless `cap` is an array whose every
  entry is a recognised capability; verification rejects such a token rather than
  returning a claim a consumer cannot evaluate. `cap: []` stays valid and keeps
  its meaning — "scoped to no capability", which consumers read as
  deny-everything. An absent `cap` still means full scope, and a malformed value
  is never coerced to absent.

  Rollout: this only rejects values no issuer produces today, so a verifier may
  ship ahead of any issuer change with no mixed window to manage. Adding a
  capability to the vocabulary later is the breaking direction — a verifier
  rejects a capability it does not recognise, so every verifier must be
  **deployed** with the new value before any issuer stamps it. Sidecars are baked
  container images that outlive an orchestrator roll, and token TTLs run from 15
  minutes to 8 hours.

### Patch Changes

- Updated dependencies [c9856a0]
  - @tangle-network/agent-interface@0.48.0

## 0.6.1

### Patch Changes

- f825a68: Correct the `SidecarSidScope` doc comment, which told consumers to deny a
  `"project"` token on a session-addressed route.

  Denying every scope but `"session"` there is the behaviour that got the first
  version of the sidecar guard reverted: the read-only and terminal tokens carry
  a project ref in `sid`, so the rule 403s all of them on every session route. A
  `"project"` token means no session comparison is possible, and the route's own
  capability policy decides.

  Documentation only — no runtime change. The claim's handling in
  `issueSidecarAccessToken` and `verifySidecarToken` is unchanged.

## 0.6.0

### Minor Changes

- 7a9afed: Add an `sst` claim to sidecar access tokens naming what `sid` holds.

  `sid` is minted with two meanings — a session id for a session-runtime token,
  a project ref for a project-scoped read-only one — and nothing on the token
  distinguished them, so a consumer could not tell whether comparing `sid`
  against a session id was an authorization check or a guaranteed mismatch.

  `issueSidecarAccessToken` accepts `sst: "session" | "project"` and
  `verifySidecarToken` returns it. Consumers must read the claim's absence as
  "the meaning of `sid` is unknown, do not enforce", so tokens minted before
  this change keep working. Sidecar token TTLs run from 15 minutes to 8 hours
  depending on the mint path, so plan for a mixed window of that length.

  Fails closed on both sides. Minting throws on an `sst` value no verifier
  accepts, and on `sst` without a `sid` for it to describe. Verification rejects
  a token whose `sst` is unrecognised or describes an empty or non-string `sid`,
  rather than returning a value a consumer would read as "not session-scoped".

### Patch Changes

- Updated dependencies [facff5c]
- Updated dependencies [facff5c]
  - @tangle-network/agent-interface@0.47.0

## 0.5.4

### Patch Changes

- Updated dependencies [077635f]
  - @tangle-network/agent-interface@0.46.1

## 0.5.3

### Patch Changes

- Updated dependencies [b44d502]
- Updated dependencies [d27deb9]
  - @tangle-network/agent-interface@0.46.0

## 0.5.2

### Patch Changes

- Updated dependencies [d8020a5]
  - @tangle-network/agent-interface@0.45.0

## 0.5.1

### Patch Changes

- Updated dependencies [3bbafd2]
  - @tangle-network/agent-interface@0.44.0

## 0.5.0

### Minor Changes

- b449679: Carry prompt-cache tokens through `readTokenUsage` instead of discarding them.

  `TokenUsageCounts` gains `cacheReadTokens` and `cacheWriteTokens`, and the three
  prompt-side fields are now disjoint and additive: `inputTokens` is the freshly
  billed tail, and `inputTokens + cacheReadTokens + cacheWriteTokens` is the size
  of the prompt the model saw. Two helpers expose that directly — `promptTokens()`
  and `cacheHitRate()`.

  **Behavior change on an existing field.** For OpenAI-compatible payloads,
  `inputTokens` previously returned the reported `prompt_tokens`, which already
  includes the cached share; it now excludes it, so a warm call's `inputTokens`
  drops to the part actually billed at the input rate. Measured on
  router.tangle.tools with `glm-5.2`, one append-only turn:
  `prompt_tokens=8656, cached_tokens=8576` used to read as 8,656 input tokens and
  now reads as 80 input + 8,576 cache-read.

  **The error flips direction, so callers must be updated, not just re-read.** A
  caller that prices `inputTokens` at the full input rate previously OVERCHARGED a
  warm call (8,656 × full rate against a true 80 × full + 8,576 × cache rate); it
  now UNDERCHARGES, because the 8,576 cache-read tokens are no longer in the field
  it prices and it does not yet charge for them anywhere. Correct usage is to
  price all three terms:

      cost = inputTokens × inputRate
           + cacheReadTokens × cacheReadRate
           + cacheWriteTokens × cacheWriteRate

  and to use `promptTokens(usage)` — never `inputTokens` — wherever the number
  means "context size".

  `genAiUsageAttributes` emits `gen_ai.usage.cache_read_input_tokens` and
  `gen_ai.usage.cache_creation_input_tokens` beside `gen_ai.usage.input_tokens`,
  so total prompt volume stays recoverable on the attribute bag rather than being
  silently under-reported once `input_tokens` narrows to the billed tail. Both are
  omitted entirely for a producer that reported no cache information, because a
  synthesized `0` would read as "measured, no cache".

  The reader normalizes two provider conventions that reach callers through the
  same endpoint — OpenAI-style, where the cached count is _inside_ the reported
  prompt total, and Anthropic-style, where it sits beside it — and does not
  double-count the router's normalized `prompt_cache` echo of a provider-native
  counter.

### Patch Changes

- Updated dependencies [682814e]
  - @tangle-network/agent-interface@0.43.1

## 0.4.35

### Patch Changes

- 0d34ae7: Preserve the caller's exact abort reason when cancellation occurs during an active retry attempt.

## 0.4.34

### Patch Changes

- 2385d13: Allow callers to cancel retry backoff through `RetryConfig.signal` so an aborted operation never waits for or starts another attempt.

## 0.4.33

### Patch Changes

- Updated dependencies [7000e82]
  - @tangle-network/agent-interface@0.43.0

## 0.4.32

### Patch Changes

- Updated dependencies [f681bb0]
  - @tangle-network/agent-interface@0.42.1

## 0.4.31

### Patch Changes

- Updated dependencies [cece8b3]
  - @tangle-network/agent-interface@0.42.0

## 0.4.30

### Patch Changes

- Updated dependencies [7011e7e]
- Updated dependencies [32acb32]
  - @tangle-network/agent-interface@0.41.0

## 0.4.29

### Patch Changes

- Updated dependencies [886666b]
  - @tangle-network/agent-interface@0.40.0

## 0.4.28

### Patch Changes

- Updated dependencies [7c68070]
- Updated dependencies [dfec816]
  - @tangle-network/agent-interface@0.39.0

## 0.4.27

### Patch Changes

- Updated dependencies [71d3391]
  - @tangle-network/agent-interface@0.38.0

## 0.4.26

### Patch Changes

- Updated dependencies [6ebe9d2]
  - @tangle-network/agent-interface@0.37.0

## 0.4.25

### Patch Changes

- Updated dependencies [c8da041]
  - @tangle-network/agent-interface@0.36.0

## 0.4.24

### Patch Changes

- Updated dependencies [0660698]
- Updated dependencies [87bae75]
  - @tangle-network/agent-interface@0.35.0

## 0.4.23

### Patch Changes

- 8521060: Publish Core and provider adapters with registry-valid Agent Interface dependencies.

## 0.4.22

### Patch Changes

- Updated dependencies [dc2990e]
- Updated dependencies [9483fb0]
  - @tangle-network/agent-interface@0.34.0

## 0.4.21

### Patch Changes

- Updated dependencies [b24db38]
  - @tangle-network/agent-interface@0.33.0

## 0.4.20

### Patch Changes

- Updated dependencies [fada902]
  - @tangle-network/agent-interface@0.32.0

## 0.4.19

### Patch Changes

- Updated dependencies [d8227eb]
  - @tangle-network/agent-interface@0.31.0

## 0.4.18

### Patch Changes

- Updated dependencies [4074c47]
  - @tangle-network/agent-interface@0.30.0

## 0.4.17

### Patch Changes

- a00d0a3: Build only before publishing so installed package artifacts can be repacked with lifecycle scripts enabled.
- Updated dependencies [e1c362e]
- Updated dependencies [a00d0a3]
  - @tangle-network/agent-interface@0.29.0

## 0.4.16

### Patch Changes

- Updated dependencies [f6dfea0]
  - @tangle-network/agent-interface@0.28.0

## 0.4.15

### Patch Changes

- Updated dependencies [d6685fa]
  - @tangle-network/agent-interface@0.27.2

## 0.4.14

### Patch Changes

- Updated dependencies [0103410]
  - @tangle-network/agent-interface@0.27.1

## 0.4.13

### Patch Changes

- Updated dependencies [f10a949]
  - @tangle-network/agent-interface@0.27.0

## 0.4.12

### Patch Changes

- Updated dependencies [8f8d4bb]
  - @tangle-network/agent-interface@0.26.1

## 0.4.11

### Patch Changes

- Updated dependencies [d5d542d]
- Updated dependencies [d5d542d]
  - @tangle-network/agent-interface@0.26.0

## 0.4.10

### Patch Changes

- Updated dependencies [7e34b8c]
- Updated dependencies [a26171f]
- Updated dependencies [1fc1bc7]
  - @tangle-network/agent-interface@0.25.0

## 0.4.9

### Patch Changes

- Updated dependencies [8b2576f]
  - @tangle-network/agent-interface@0.24.0

## 0.4.8

### Patch Changes

- 66ab1f0: Add the `workspace` sidecar token capability for session-scoped file operations.

## 0.4.7

### Patch Changes

- Updated dependencies [bca9ea6]
  - @tangle-network/agent-interface@0.23.0

## 0.4.6

### Patch Changes

- Updated dependencies [73759a5]
- Updated dependencies [96c6e84]
  - @tangle-network/agent-interface@0.22.0

## 0.4.5

### Patch Changes

- Updated dependencies [f5cbf34]
- Updated dependencies [2d70211]
- Updated dependencies [9ad63d0]
  - @tangle-network/agent-interface@0.21.0

## 0.4.4

### Patch Changes

- Updated dependencies [afe552d]
  - @tangle-network/agent-interface@0.20.0

## 0.4.3

### Patch Changes

- Updated dependencies [e0a8e98]
  - @tangle-network/agent-interface@0.19.0

## 0.4.2

### Patch Changes

- Updated dependencies [1f2821b]
  - @tangle-network/agent-interface@0.18.0

## 0.4.1

### Patch Changes

- 077b3d4: fix(auth): make the token module browser-import-safe

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

## 0.4.0

### Minor Changes

- 3a8f557: telemetry: read indexed / array / tool-call trace content, and stop dropping the reply

  `extractContent` / `hasContent` / `resolveDeclaredIntent` now reconstruct the
  INDEXED / ARRAY / nested content shapes that push-OTLP providers emit — which the
  flat alias table could not match, so `extractContent({"gen_ai.prompt.0.content":"hi"})`
  previously returned `{}` and every downstream analysis went dark for the entire
  push population:

  - OpenInference (Phoenix, LangGraph, CrewAI, LlamaIndex): `llm.input_messages.{i}.message.content`, nested `…tool_calls.{j}.tool_call.function.arguments`
  - OTel-GenAI flattened (LiteLLM, OpenAI Agents SDK, Pydantic, older OpenLLMetry): `gen_ai.prompt.{i}.content` / `gen_ai.completion.{i}.content`
  - OTel-GenAI v1.28+ event arrays (Vercel AI SDK, current OpenLLMetry): `gen_ai.input.messages` / `gen_ai.output.messages`
  - bare tool-call keys: `tool_call.function.arguments`

  Reconstruction runs as a pure, non-destructive pre-pass (`normalizeContentAttributes`,
  now exported) inside every read path, so a new provider's flattening is learned in
  ONE place and all consumers read indexed content by construction.

  Also fixes a latent reply-drop: both message arrays aliased the single `messages`
  field (resolved once), so with a prompt present the assistant reply was silently
  lost. The OUTPUT reply is now reconstructed into the SEPARATE `completion` field
  (`llm.output_messages` is no longer a `messages` alias), so a full turn carries
  BOTH the prompt and the reply.

  New exports: `normalizeContentAttributes` and `INDEXED_CONTENT_KEY_LIKE_PATTERNS`
  (SQL `LIKE` patterns for indexed-content detection, so a DB-side "content seen"
  check reuses the same vocabulary as the in-process reader).

## 0.3.8

### Patch Changes

- Updated dependencies [f7ca568]
  - @tangle-network/agent-interface@0.17.1

## 0.3.7

### Patch Changes

- Updated dependencies [175521c]
  - @tangle-network/agent-interface@0.17.0

## 0.3.6

### Patch Changes

- Updated dependencies [dd7c4fe]
  - @tangle-network/agent-interface@0.16.0

## 0.3.5

### Patch Changes

- Updated dependencies [ecd2adc]
  - @tangle-network/agent-interface@0.15.0

## 0.3.4

### Patch Changes

- Updated dependencies [6591b16]
  - @tangle-network/agent-interface@0.14.0

## 0.3.3

### Patch Changes

- Updated dependencies [5d8d8ec]
  - @tangle-network/agent-interface@0.13.0

## 0.3.2

### Patch Changes

- Updated dependencies [c63e325]
  - @tangle-network/agent-interface@0.12.0
