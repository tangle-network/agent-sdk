# @tangle-network/agent-core

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
