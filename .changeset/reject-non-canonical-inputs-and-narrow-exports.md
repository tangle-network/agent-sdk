---
"@tangle-network/agent-interface": minor
---

Reject non-canonical inputs, add narrow subpath exports, and add typed token
limits to model hints.

`isCanonicalJsonValue` now rejects a sparse array. `Array.prototype.every` and
`Array.prototype.map` both skip holes, so a sparse `Array(1)` passed validation
and then serialized to the same bytes as a dense `[]`. Two observably different
values collapsed to one content digest, which read as false idempotency. The
serializer output is unchanged, so existing digests hold; only the input gate is
stricter. A dense `[null]` still passes.

`InteractionDataSchema` now rejects a reserved key rather than silently dropping
it. A record parser assigns keys onto an ordinary object, so a raw own
`__proto__` invoked the legacy prototype setter and vanished before the field
name schema ran, and `InteractionDataSchema.safeParse(JSON.parse('{"__proto__":"x"}'))`
returned an empty object while `validateInteractionResponse` rejected the same
input. The schema now inspects the raw own keys, fails loud on `__proto__`,
`constructor`, or `prototype`, and still returns a null-prototype object. The two
paths now agree. The reserved-name set has one owner in `interaction-fields`.

The package now declares narrow subpath exports for the existing leaf modules:
`profile`, `profile-snapshot`, `profile-schema`, `profile-security`, `harness`,
`harness-capabilities`, and `interaction`. A caller can load one leaf without
evaluating the root barrel graph.

`AgentProfile.model` gains three optional token ceilings:
`maxVisibleOutputTokens`, `maxReasoningTokens`, and `maxTotalOutputTokens`. Each
is a positive integer, and each is independent. A refinement fails loud when a
single ceiling exceeds the total; it never clamps. `reasoningEffort` stays a
quality dial and never bounds spend. This change is the schema half only.
Provider and materializer enforcement — recording requested against applied and
lowering to a provider's `max_tokens` or `max_completion_tokens` before spend —
is a tracked phase 2, the same split used for #146 and #154.

The two input rejections are stricter validation. For a 0.x package a minor
release is correct. A caller that relied on a sparse array or a `__proto__` key
passing now receives a validation error; no caller in this repository does.
